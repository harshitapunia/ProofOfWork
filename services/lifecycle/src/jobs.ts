import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { check, LifecycleError } from "./common.js";
import { apply, bindingText, claimInput, hydrateBindings, identifier, identity, integer, jobId, operationKey, publicBindings, sha,
  type JobBindings, type JobClaim, type JobHistoryEntry, type JobMutable, type JobStep, type VerificationJob } from "./job-model.js";
export type { JobBindings, JobClaim, JobHistoryEntry, JobState, JobStep, VerificationJob } from "./job-model.js";
export interface VerificationJobs {
  createOrGetJob(creationId: string, bindings: JobBindings): VerificationJob;
  getJob(jobId: string): VerificationJob | undefined;
  claimJob(jobId: string, identity: string, expectedRevision: number, workerId: string): Readonly<{job:VerificationJob;claim:Readonly<JobClaim>}>;
  transitionJob(claim: JobClaim, expectedRevision: number, to: JobStep): VerificationJob;
  getJobHistory(jobId: string): readonly JobHistoryEntry[];
  listRecoveryRequired(afterId?: string, limit?: number): Readonly<{entries:readonly RecoveryEntry[];nextAfter?:string}>;
}
export interface JobRecoveryControl {
  interruptJob(jobId: string, identity: string, expectedRevision: number, operatorId: string): VerificationJob;
}
export interface RecoveryEntry {
  readonly job: VerificationJob;
  readonly classification: "never_claimed" | "claimed_unfinished" | "verification_unfinished" | "verification_completed_locally"
    | "verification_rejected_locally" | "authorization_uncertain" | "reconciliation_required";
}
export type JobTransaction = <T>(fn: (db: DatabaseSync) => T, write?: boolean) => T;
interface JobRecord { job:VerificationJob;history:readonly JobHistoryEntry[];lastDigest:string }
const mutable = (v: JobMutable) => [v.state,v.revision,v.generation,v.workerId,v.verificationOutcome,v.recoveryReason];
const historyHash = (id: string, revision: number, previous: string, event: readonly unknown[]) =>
  sha(JSON.stringify(["proofwork:job-history:v1",id,revision,previous,event]));
export function read(db: DatabaseSync, id: string): JobRecord | undefined {
  const raw = db.prepare("SELECT * FROM verification_jobs WHERE job_id=?").get(id);
  if (!raw) return undefined;
  const rows = db.prepare("SELECT revision,event,digest FROM verification_job_history WHERE job_id=? ORDER BY revision LIMIT 258").all(id);
  try {
    jobId(raw.job_id); identifier(raw.creation_id);
    const b = hydrateBindings(raw.bindings);
    const text = bindingText(b);
    const boundIdentity = identity(id,raw.creation_id,b);
    check(raw.job_id === id && raw.operation_key === operationKey(b) && raw.binding_digest === sha(text)
      && raw.identity === boundIdentity);
    integer(raw.revision,256); integer(raw.generation,2147483647);
    check(rows.length === raw.revision+1);
    let current:JobMutable|undefined, previous = "0".repeat(64);
    const history:JobHistoryEntry[] = [];
    for (const [n,row] of rows.entries()) {
      check(row.revision === n && typeof row.event === "string" && row.event.length <= 512);
      const event:unknown = JSON.parse(row.event);
      check(Array.isArray(event) && JSON.stringify(event) === row.event);
      current = apply(current,event);
      const h = historyHash(boundIdentity,n,previous,event);
      check(row.digest === h); previous = h;
      history.push(Object.freeze({...current,event:Object.freeze([...event]) as readonly (string|number)[]}));
    }
    check(current && JSON.stringify(mutable(current)) === JSON.stringify(
      [raw.state,raw.revision,raw.generation,raw.worker_id,raw.outcome,raw.reason]));
    const job = Object.freeze({...current,jobId:id,creationId:raw.creation_id,operationKey:operationKey(b),
      identity:boundIdentity,bindings:b,signingAuthorization:"not_granted" as const});
    return {job,history:Object.freeze(history),lastDigest:previous};
  } catch { throw new LifecycleError("corrupt_store"); }
}
export function append(db:DatabaseSync, old:JobRecord, event:readonly (string|number)[]):VerificationJob {
  const next = apply(old.job,event);
  const result=db.prepare("UPDATE verification_jobs SET state=?,revision=?,generation=?,worker_id=?,outcome=?,reason=? WHERE job_id=? AND revision=? AND generation=? AND identity=?")
    .run(next.state,next.revision,next.generation,next.workerId,next.verificationOutcome,next.recoveryReason,
      old.job.jobId,old.job.revision,old.job.generation,old.job.identity);
  check(result.changes === 1,"conflict");
  db.prepare("INSERT INTO verification_job_history VALUES(?,?,?,?)").run(old.job.jobId,next.revision,
    JSON.stringify(event),historyHash(old.job.identity,next.revision,old.lastDigest,event));
  return read(db,old.job.jobId)!.job;
}
export function expected(db:DatabaseSync,id:string,identityValue:string,revision:number):JobRecord {
  const record=read(db,id);check(record,"not_found");
  check(record.job.identity===identityValue,"job_conflict");check(record.job.revision===revision,"conflict");
  return record;
}
function lookupInput(id:string,identityValue:string,revision:number):void {
  jobId(id);check(typeof identityValue==="string"&&/^[0-9a-f]{64}$/.test(identityValue));integer(revision,256);
}
/** Internal factory: the store supplies its guarded transactions; no SQL handle is returned. */
export function createVerificationJobs(transaction:JobTransaction):Readonly<{jobs:VerificationJobs;recovery:JobRecoveryControl}> {
  const jobs:VerificationJobs=Object.freeze({
    createOrGetJob(creationId:string,input:JobBindings) {
      identifier(creationId);const b=publicBindings(input),text=bindingText(b),op=operationKey(b);
      return transaction(db=>{
        const request=db.prepare("SELECT operation_key FROM verification_jobs WHERE creation_id=?").get(creationId);
        check(!request||request.operation_key===op,"job_conflict");
        const found=db.prepare("SELECT job_id FROM verification_jobs WHERE operation_key=?").get(op);
        if(found){
          const existing=read(db,found.job_id as string)!.job;
          check(bindingText(existing.bindings)===text,"job_conflict");return existing;
        }
        const id=randomUUID(),boundIdentity=identity(id,creationId,b);
        db.prepare("INSERT INTO verification_jobs VALUES(?,?,?,?,?,?,'created',0,0,NULL,'none',NULL)")
          .run(id,creationId,op,text,sha(text),boundIdentity);
        const event=["created"];
        db.prepare("INSERT INTO verification_job_history VALUES(?,0,?,?)")
          .run(id,JSON.stringify(event),historyHash(boundIdentity,0,"0".repeat(64),event));
        return read(db,id)!.job;
      });
    },
    getJob(id:string) {jobId(id);return transaction(db=>read(db,id)?.job,false);},
    claimJob(id:string,identityValue:string,revision:number,workerId:string) {
      lookupInput(id,identityValue,revision);identifier(workerId);
      return transaction(db=>{
        const next=append(db,expected(db,id,identityValue,revision),["claimed",workerId]);
        return Object.freeze({job:next,claim:Object.freeze({jobId:id,identity:next.identity,workerId,generation:next.generation})});
      });
    },
    transitionJob(input:JobClaim,revision:number,to:JobStep) {
      const claim=claimInput(input);integer(revision,256);
      check(["verification_running","verification_completed","verification_rejected","authorization_pending","closed"].includes(to),"invalid_transition");
      return transaction(db=>{
        const old=expected(db,claim.jobId,claim.identity,revision);
        check(old.job.generation===claim.generation&&old.job.workerId===claim.workerId,"stale_claim");
        return append(db,old,[to,claim.workerId,claim.generation]);
      });
    },
    getJobHistory(id:string) {jobId(id);return transaction(db=>{const r=read(db,id);check(r,"not_found");return r.history;},false);},
    listRecoveryRequired(afterId?:string,limit=100) {
      if(afterId!==undefined)jobId(afterId);integer(limit,100);check(limit>0);
      return transaction(db=>{
        const rows=db.prepare("SELECT job_id FROM verification_jobs WHERE job_id>? ORDER BY job_id LIMIT ?").all(afterId??"",limit);
        const entries:RecoveryEntry[]=[];
        for(const row of rows) {
          const job=read(db,row.job_id as string)!.job;
          if(job.state==="closed")continue;
          const labels:Record<string,RecoveryEntry["classification"]>={created:"never_claimed",claimed:"claimed_unfinished",
            verification_running:"verification_unfinished",verification_completed:"verification_completed_locally",
            verification_rejected:"verification_rejected_locally",authorization_pending:"authorization_uncertain",recovery_required:"reconciliation_required"};
          entries.push(Object.freeze({job,classification:labels[job.state]!}));
        }
        return Object.freeze({entries:Object.freeze(entries),nextAfter:rows.length===limit?rows.at(-1)!.job_id as string:undefined});
      },false);
    },
  });
  const recovery:JobRecoveryControl=Object.freeze({
    interruptJob(id:string,identityValue:string,revision:number,operatorId:string) {
      lookupInput(id,identityValue,revision);identifier(operatorId);
      return transaction(db=>append(db,expected(db,id,identityValue,revision),["interrupted",operatorId]));
    },
  });
  return Object.freeze({jobs,recovery});
}
