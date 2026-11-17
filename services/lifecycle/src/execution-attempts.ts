import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { PublicKey } from "@solana/web3.js";
import { address, check, exact, LifecycleError } from "./common.js";
import { claimInput, identifier, integer, jobId, sha, bindingText, type JobClaim } from "./job-model.js";
import { read, expected, type JobTransaction } from "./jobs.js";
import { load as loadIntent, type TransactionIntent } from "./transaction-intents.js";
import { advance, initialFacts, sealSnapshot, type ExecutionAttempt, type ExecutionEvidence } from "./execution-model.js";
import { takeExecutionObservation } from "./execution-observations.js";

export interface ExecutionRef { readonly attemptId: string; readonly identity: string; readonly revision: number }
export interface ExecutionControlFence {
  readonly jobId: string; readonly identity: string; readonly revision: number;
  readonly generation: number; readonly workerId: string | null; readonly operatorId: string;
}
export interface ExecutionAttempts {
  create(claim: JobClaim, jobRevision: number, requestId: string, intentId: string, intentIdentity: string,
    observationAuthority: string): Readonly<{attempt: ExecutionAttempt; created: boolean}>;
  get(id: string): ExecutionAttempt | undefined;
  getForIntent(intentId: string): ExecutionAttempt | undefined;
  history(id: string): readonly ExecutionHistory[];
  list(afterId?: string, limit?: number): readonly ExecutionAttempt[];
  recordSubmissionIntent(claim: JobClaim, jobRevision: number, ref: ExecutionRef, token: unknown): ExecutionAttempt;
  recordSimulatedInvocation(claim: JobClaim, jobRevision: number, ref: ExecutionRef, eventId: string): ExecutionAttempt;
  markUncertain(claim: JobClaim, jobRevision: number, ref: ExecutionRef, eventId: string): ExecutionAttempt;
}
export interface ExecutionRecoveryControl {
  applyObservation(fence: ExecutionControlFence, ref: ExecutionRef, token: unknown): ExecutionAttempt;
  requireReconciliation(fence: ExecutionControlFence, ref: ExecutionRef, eventId: string): ExecutionAttempt;
}
export interface ExecutionHistory {
  readonly eventId: string; readonly revision: number; readonly actor: "worker" | "control"; readonly actorId: string;
  readonly jobRevision: number; readonly jobGeneration: number; readonly jobWorker: string | null;
  readonly evidence: "created" | "invoke" | "uncertain" | Readonly<ExecutionEvidence>;
}
const fields = ["eventId","revision","actor","actorId","jobRevision","jobGeneration","jobWorker","evidence"] as const;
const binding = (id: string, request: string, intent: TransactionIntent, authority: string) =>
  sha(JSON.stringify(["proofwork:offline-execution:v1",id,request,intent.intentId,intent.identity,intent.preparation!.identity,
    intent.jobId,intent.jobIdentity,intent.operationKey,intent.feePayer,authority]));
const historyHash = (identity: string, n: number, previous: string, event: ExecutionHistory) =>
  sha(JSON.stringify(["proofwork:execution-history:v1",identity,n,previous,event]));
function authority(value: string, intent: TransactionIntent) {
  address(value); check(PublicKey.isOnCurve(new PublicKey(value).toBytes())
    && value !== intent.feePayer && value !== intent.bindings.verifier, "invalid_observation_authority");
}
function refInput(value: ExecutionRef): ExecutionRef {
  exact(value,["attemptId","identity","revision"]); const v = structuredClone(value);
  jobId(v.attemptId); integer(v.revision,32); check(typeof v.identity === "string" && /^[0-9a-f]{64}$/.test(v.identity)); return v;
}
function load(db: DatabaseSync, id: string) {
  const row = db.prepare("SELECT * FROM execution_attempts WHERE attempt_id=?").get(id); if (!row) return undefined;
  try {
    jobId(row.attempt_id); identifier(row.request_id); integer(row.revision,32);
    const intent = loadIntent(db,row.intent_id as string)!.value; check(intent.preparation);
    authority(row.observation_authority as string,intent);
    const identity = binding(id,row.request_id,intent,row.observation_authority as string); check(identity === row.identity);
    const job = read(db,intent.jobId)!;
    const rows = db.prepare("SELECT * FROM execution_history WHERE attempt_id=? ORDER BY revision LIMIT 34").all(id);
    check(rows.length === row.revision + 1);
    let facts = initialFacts(), previous = "0".repeat(64);
    const history: ExecutionHistory[] = [];
    for (const [n,r] of rows.entries()) {
      check(r.revision === n && typeof r.event === "string" && r.event.length <= 4096);
      const e = JSON.parse(r.event) as ExecutionHistory; exact(e,fields);
      check(JSON.stringify(e) === r.event && e.revision === n && e.eventId === r.event_id);
      identifier(e.eventId); identifier(e.actorId); integer(e.jobRevision,256); integer(e.jobGeneration,2147483647);
      const phase = job.history[e.jobRevision];
      check(phase && phase.generation === e.jobGeneration && phase.workerId === e.jobWorker);
      if (e.actor === "worker") {
        check(phase.state === "authorization_pending" && e.actorId === phase.workerId
          && intent.workerId === e.actorId && intent.generation === phase.generation && intent.jobRevision === phase.revision);
      } else check(e.actor === "control" && n > 0);
      if (n === 0) check(e.evidence === "created" && e.actor === "worker");
      else {
        check(e.evidence !== "created");
        if (typeof e.evidence === "object") {
          const v = e.evidence;
          check(v.attemptId === id && v.identity === identity && v.revision === n-1 && v.eventId === e.eventId
            && v.intentIdentity === intent.identity && v.preparationIdentity === intent.preparation.identity
            && v.bindingDigest === sha(bindingText(intent.bindings)));
          if (e.actor === "worker") check(v.kind === "signed_identity" && facts.phase === "execution_record_created");
        } else if (e.evidence === "invoke") check(e.actor === "worker");
        facts = advance(facts,e.evidence,intent.preparation.lastValidBlockHeight);
      }
      check(r.digest === historyHash(identity,n,previous,e)); previous = r.digest as string;
      history.push(Object.freeze({...e,evidence:typeof e.evidence === "object" ? Object.freeze(e.evidence) : e.evidence}));
    }
    const current = job.job;
    const revoked = current.state !== "authorization_pending" || current.workerId !== intent.workerId
      || current.generation !== intent.generation || current.revision !== intent.jobRevision;
    const value = sealSnapshot({...facts,attemptId:id,identity,requestId:row.request_id as string,revision:row.revision,
      intent,observationAuthority:row.observation_authority as string,mode:"offline-test-model" as const,rpcAuthenticated:false as const,
      signingAuthorization:"not_granted" as const,submissionAuthorized:false as const,retryAuthorized:false as const,
      reservationRetained:true as const,reconciliationRequired:facts.uncertain || revoked});
    return {value,history:Object.freeze(history),previous};
  } catch { throw new LifecycleError("corrupt_store"); }
}
/** Same DB and transaction as jobs/intents. No signer/transport/receipt promotion. */
export function createExecutionAttempts(transaction: JobTransaction): {attempts:ExecutionAttempts;recovery:ExecutionRecoveryControl} {
  function worker(db: DatabaseSync, c: JobClaim, revision: number, intent: TransactionIntent) {
    const j = expected(db,c.jobId,c.identity,revision).job;
    check(j.state === "authorization_pending" && j.workerId === c.workerId && j.generation === c.generation
      && intent.jobId === c.jobId && intent.jobIdentity === c.identity && intent.jobRevision === revision
      && intent.workerId === c.workerId && intent.generation === c.generation,"stale_claim");
    return j;
  }
  function append(db: DatabaseSync, old: NonNullable<ReturnType<typeof load>>, e: ExecutionHistory) {
    check(old.value.revision < 32,"execution_exhausted");
    advance(old.value,e.evidence as Exclude<ExecutionHistory["evidence"],"created">,old.value.intent.preparation!.lastValidBlockHeight);
    const result = db.prepare("UPDATE execution_attempts SET revision=revision+1 WHERE attempt_id=? AND identity=? AND revision=?")
      .run(old.value.attemptId,old.value.identity,old.value.revision);
    check(result.changes === 1,"conflict");
    db.prepare("INSERT INTO execution_history VALUES(?,?,?,?,?)").run(old.value.attemptId,e.revision,e.eventId,
      JSON.stringify(e),historyHash(old.value.identity,e.revision,old.previous,e));
    return load(db,old.value.attemptId)!.value;
  }
  function mutate(c: JobClaim, jrev: number, input: ExecutionRef, evidence: "invoke" | "uncertain" | ExecutionEvidence, eventId: string) {
    c = claimInput(c); integer(jrev,256); const ref = refInput(input); identifier(eventId);
    return transaction(db => {
      const old = load(db,ref.attemptId); check(old,"not_found");
      check(old.value.identity === ref.identity && old.value.revision === ref.revision,"conflict");
      const j = worker(db,c,jrev,old.value.intent);
      if (typeof evidence === "object" && evidence.kind === "signed_identity")
        check(old.value.phase === "execution_record_created","invalid_transition");
      return append(db,old,{eventId,revision:ref.revision+1,actor:"worker",actorId:c.workerId,
        jobRevision:j.revision,jobGeneration:j.generation,jobWorker:j.workerId,evidence});
    });
  }
  function control(input: ExecutionControlFence, inputRef: ExecutionRef, evidence: "uncertain" | ExecutionEvidence, eventId: string) {
    exact(input,["jobId","identity","revision","generation","workerId","operatorId"]);
    const f = structuredClone(input), ref = refInput(inputRef);
    jobId(f.jobId); check(typeof f.identity === "string" && /^[0-9a-f]{64}$/.test(f.identity)); identifier(f.operatorId); integer(f.revision,256); integer(f.generation,2147483647);
    if (f.workerId !== null) identifier(f.workerId); identifier(eventId);
    return transaction(db => {
      const j = expected(db,f.jobId,f.identity,f.revision).job;
      check(j.workerId === f.workerId && j.generation === f.generation,"stale_claim");
      const old = load(db,ref.attemptId); check(old,"not_found");
      check(old.value.identity === ref.identity && old.value.revision === ref.revision
        && old.value.intent.jobId === f.jobId && old.value.intent.jobIdentity === f.identity,"conflict");
      return append(db,old,{eventId,revision:ref.revision+1,actor:"control",actorId:f.operatorId,
        jobRevision:j.revision,jobGeneration:j.generation,jobWorker:j.workerId,evidence});
    });
  }
  const attempts: ExecutionAttempts = Object.freeze({
    create(c: JobClaim,jrev: number,request: string,intentId: string,intentIdentity: string,key: string) {
      c = claimInput(c); integer(jrev,256); identifier(request); jobId(intentId);
      return transaction(db => {
        const intent = loadIntent(db,intentId)?.value; check(intent?.preparation,"missing_preparation");
        check(intent.identity === intentIdentity,"intent_conflict"); worker(db,c,jrev,intent); authority(key,intent);
        const requestRow = db.prepare("SELECT intent_id FROM execution_attempts WHERE request_id=?").get(request);
        check(!requestRow || requestRow.intent_id === intentId,"execution_conflict");
        const existing = db.prepare("SELECT attempt_id FROM execution_attempts WHERE intent_id=?").get(intentId);
        if (existing) {
          const v = load(db,existing.attempt_id as string)!.value; check(v.observationAuthority === key,"execution_conflict");
          return Object.freeze({attempt:v,created:false});
        }
        const id = randomUUID(), identity = binding(id,request,intent,key);
        db.prepare("INSERT INTO execution_attempts VALUES(?,?,?,?,?,0)").run(id,request,intentId,key,identity);
        const e: ExecutionHistory = {eventId:"created",revision:0,actor:"worker",actorId:c.workerId,
          jobRevision:jrev,jobGeneration:c.generation,jobWorker:c.workerId,evidence:"created"};
        db.prepare("INSERT INTO execution_history VALUES(?,0,?,?,?)").run(id,e.eventId,JSON.stringify(e),historyHash(identity,0,"0".repeat(64),e));
        return Object.freeze({attempt:load(db,id)!.value,created:true});
      });
    },
    get(id: string) { jobId(id); return transaction(db => load(db,id)?.value,false); },
    getForIntent(id: string) { jobId(id); return transaction(db => {
      const row = db.prepare("SELECT attempt_id FROM execution_attempts WHERE intent_id=?").get(id);
      return row ? load(db,row.attempt_id as string)!.value : undefined;
    },false); },
    history(id: string) { jobId(id); return transaction(db => {const v=load(db,id);check(v,"not_found");return v.history;},false); },
    list(afterId?: string,limit=100) {
      if (afterId !== undefined) jobId(afterId); integer(limit,100); check(limit > 0);
      return transaction(db => Object.freeze(db.prepare("SELECT attempt_id FROM execution_attempts WHERE attempt_id>? ORDER BY attempt_id LIMIT ?")
        .all(afterId ?? "",limit).map(v=>load(db,v.attempt_id as string)!.value)),false);
    },
    recordSubmissionIntent(c: JobClaim,j: number,r: ExecutionRef,token: unknown) {
      const e = takeExecutionObservation(token); check(e.kind === "signed_identity","invalid_transition"); return mutate(c,j,r,e,e.eventId);
    },
    recordSimulatedInvocation(c: JobClaim,j: number,r: ExecutionRef,id: string) { return mutate(c,j,r,"invoke",id); },
    markUncertain(c: JobClaim,j: number,r: ExecutionRef,id: string) { return mutate(c,j,r,"uncertain",id); },
  });
  const recovery: ExecutionRecoveryControl = Object.freeze({
    applyObservation(f: ExecutionControlFence,r: ExecutionRef,token: unknown) {
      const e = takeExecutionObservation(token); return control(f,r,e,e.eventId);
    },
    requireReconciliation(f: ExecutionControlFence,r: ExecutionRef,id: string) { return control(f,r,"uncertain",id); },
  });
  return {attempts,recovery};
}
