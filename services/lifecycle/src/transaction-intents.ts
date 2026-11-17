import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { address, check, exact, LifecycleError, MAX_ID } from "./common.js";
import { claimInput, identifier, integer, jobId, sha, type JobClaim, type JobBindings } from "./job-model.js";
import { expected, read, type JobTransaction } from "./jobs.js";

export const INTENT_FORMAT = "legacy-unsigned-attestation" as const;
export type IntentState = "created" | "preparation_recorded" | "preparation_rejected"
  | "preparation_uncertain" | "reconciliation_required";
export interface PreparationInput {
  readonly messageDigest: string;
  readonly format: typeof INTENT_FORMAT;
  readonly blockhash: string;
  readonly lastValidBlockHeight: string;
  readonly observedBlockHeight: string;
}
export interface Preparation extends PreparationInput { readonly identity: string }
export interface TransactionIntent {
  readonly intentId: string; readonly requestId: string; readonly identity: string;
  readonly jobId: string; readonly jobIdentity: string; readonly operationKey: string;
  readonly bindings: Readonly<JobBindings>; readonly feePayer: string; readonly format: typeof INTENT_FORMAT;
  readonly workerId: string; readonly generation: number; readonly jobRevision: number;
  readonly revision: number; readonly state: IntentState; readonly preparation?: Readonly<Preparation>;
  readonly reconciliationRequired: boolean; readonly signingAuthorization: "not_granted";
  readonly submissionAuthorized: false; readonly retryAuthorized: false;
}
export interface IntentHistoryEntry {
  readonly revision: number; readonly state: IntentState; readonly event: readonly (string | number)[];
}
export interface IntentCreation { readonly intent: TransactionIntent; readonly created: boolean }
export interface TransactionIntents {
  createIntent(claim: JobClaim, jobRevision: number, requestId: string, feePayer: string): IntentCreation;
  recordPreparation(claim: JobClaim, jobRevision: number, intentId: string, identity: string,
    intentRevision: number, input: PreparationInput): TransactionIntent;
  rejectPreparation(claim: JobClaim, jobRevision: number, intentId: string, identity: string, intentRevision: number): TransactionIntent;
  markPreparationUncertain(claim: JobClaim, jobRevision: number, intentId: string, identity: string, intentRevision: number): TransactionIntent;
  requireReconciliation(claim: JobClaim, jobRevision: number, intentId: string, identity: string, intentRevision: number): TransactionIntent;
  getIntent(intentId: string): TransactionIntent | undefined;
  getForJob(jobId: string): TransactionIntent | undefined;
  getIntentHistory(intentId: string): readonly IntentHistoryEntry[];
  listOutstandingIntents(afterId?: string, limit?: number): Readonly<{entries: readonly TransactionIntent[]; nextAfter?: string}>;
}
const FIELDS = ["messageDigest", "format", "blockhash", "lastValidBlockHeight", "observedBlockHeight"] as const;
function hash(value: unknown): asserts value is string {
  check(typeof value === "string" && /^[0-9a-f]{64}$/.test(value) && /[1-9a-f]/.test(value));
}
function height(value: unknown): asserts value is string {
  check(typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= MAX_ID);
}
function preparation(input: PreparationInput): Readonly<PreparationInput> {
  exact(input, FIELDS);
  try { input = structuredClone(input); } catch { throw new LifecycleError("invalid_input"); }
  hash(input.messageDigest); check(input.format === INTENT_FORMAT); address(input.blockhash);
  height(input.lastValidBlockHeight); height(input.observedBlockHeight);
  check(BigInt(input.lastValidBlockHeight) > BigInt(input.observedBlockHeight), "expired_preparation");
  return Object.freeze(Object.fromEntries(FIELDS.map(k => [k, input[k]])) as unknown as PreparationInput);
}
const tuple = (p: PreparationInput) => FIELDS.map(k => p[k]);
const identity = (id: string, request: string, job: { jobId: string; identity: string; operationKey: string }, payer: string) =>
  sha(JSON.stringify(["proofwork:transaction-intent:v1", id, request, job.jobId, job.identity, job.operationKey, payer, INTENT_FORMAT]));
const preparationId = (id: string, p: PreparationInput) => sha(JSON.stringify(["proofwork:preparation:v1", id, ...tuple(p)]));
const historyHash = (id: string, n: number, previous: string, event: readonly unknown[]) =>
  sha(JSON.stringify(["proofwork:intent-history:v1", id, n, previous, event]));
function payer(value: string, b: JobBindings): string {
  address(value);
  check(![b.verifier, b.internship, b.milestone, b.submission, b.programId].includes(value), "invalid_fee_payer");
  return value;
}
interface Record { value: TransactionIntent; history: readonly IntentHistoryEntry[]; lastDigest: string }
export function load(db: DatabaseSync, id: string): Record | undefined {
  const row = db.prepare("SELECT * FROM transaction_intents WHERE intent_id=?").get(id);
  if (!row) return undefined;
  try {
    jobId(row.intent_id); identifier(row.request_id); jobId(row.job_id);
    const job = read(db, row.job_id)!; check(job);
    payer(row.fee_payer as string, job.job.bindings);
    const bound = identity(id, row.request_id, job.job, row.fee_payer as string);
    check(row.identity === bound); integer(row.revision, 2);
    const rows = db.prepare("SELECT revision,event,digest FROM transaction_intent_history WHERE intent_id=? ORDER BY revision LIMIT 4").all(id);
    check(rows.length === row.revision + 1);
    let state: IntentState = "created", prepared: Readonly<Preparation> | undefined, previous = "0".repeat(64);
    let worker = "", generation = -1, jobRevision = -1;
    const history: IntentHistoryEntry[] = [];
    for (const [n, raw] of rows.entries()) {
      check(raw.revision === n && typeof raw.event === "string" && raw.event.length <= 1024);
      const e: unknown = JSON.parse(raw.event);
      check(Array.isArray(e) && JSON.stringify(e) === raw.event && e.length >= 4);
      identifier(e[1]); integer(e[2], 2147483647); integer(e[3], 256);
      const phase = job.history[e[3]];
      check(phase?.state === "authorization_pending" && phase.workerId === e[1] && phase.generation === e[2]);
      if (n === 0) {
        check(e.length === 4 && e[0] === "created");
        worker = e[1]; generation = e[2]; jobRevision = e[3];
      } else {
        check(e[1] === worker && e[2] === generation && e[3] === jobRevision);
        if (e[0] === "preparation_recorded") {
          check(state === "created" && e.length === 9);
          const p = preparation(Object.fromEntries(FIELDS.map((k, index) => [k, e[index + 4]])) as unknown as PreparationInput);
          prepared = Object.freeze({ ...p, identity: preparationId(bound, p) }); state = "preparation_recorded";
        } else if (e[0] === "preparation_rejected" || e[0] === "preparation_uncertain") {
          check(state === "created" && e.length === 4); state = e[0];
        } else {
          check(e[0] === "reconciliation_required" && state !== "reconciliation_required" && e.length === 4);
          state = "reconciliation_required";
        }
      }
      const digest = historyHash(bound, n, previous, e); check(raw.digest === digest); previous = digest;
      history.push(Object.freeze({ revision: n, state, event: Object.freeze([...e]) as readonly (string | number)[] }));
    }
    check(row.state === state);
    const current = job.job;
    const revoked = current.state !== "authorization_pending" || current.revision !== jobRevision
      || current.workerId !== worker || current.generation !== generation;
    const value: TransactionIntent = Object.freeze({ intentId: id, requestId: row.request_id, identity: bound,
      jobId: current.jobId, jobIdentity: current.identity, operationKey: current.operationKey, bindings: current.bindings,
      feePayer: row.fee_payer as string, format: INTENT_FORMAT, workerId: worker, generation, jobRevision,
      revision: row.revision, state, preparation: prepared,
      reconciliationRequired: revoked || state === "created" || state === "preparation_uncertain" || state === "reconciliation_required",
      signingAuthorization: "not_granted", submissionAuthorized: false, retryAuthorized: false });
    return { value, history: Object.freeze(history), lastDigest: previous };
  } catch { throw new LifecycleError("corrupt_store"); }
}
function fence(db: DatabaseSync, claim: JobClaim, revision: number) {
  const record = expected(db, claim.jobId, claim.identity, revision);
  check(record.job.workerId === claim.workerId && record.job.generation === claim.generation, "stale_claim");
  check(record.job.state === "authorization_pending", "invalid_transition");
  return record;
}
function parameters(input: JobClaim, revision: number) {
  const claim = claimInput(input); integer(revision, 256); return claim;
}
/** Public audit assertions only: no bytes, signer, transport, tickets or authorization hydration. */
export function createTransactionIntents(transaction: JobTransaction): TransactionIntents {
  function mutate(input: JobClaim, jobRevision: number, id: string, identityValue: string, revision: number,
    to: Exclude<IntentState, "created">, prep?: Readonly<PreparationInput>): TransactionIntent {
    const claim = parameters(input, jobRevision); jobId(id); hash(identityValue); integer(revision, 2);
    return transaction(db => {
      fence(db, claim, jobRevision);
      const old = load(db, id); check(old, "not_found");
      const v = old.value;
      check(v.jobId === claim.jobId && v.jobIdentity === claim.identity && v.identity === identityValue, "intent_conflict");
      check(v.workerId === claim.workerId && v.generation === claim.generation && v.jobRevision === jobRevision, "stale_claim");
      check(v.revision === revision, "conflict");
      if (to === "preparation_recorded" && v.state === to) {
        check(prep && v.preparation?.identity === preparationId(v.identity, prep), "intent_conflict");
        return v; // Exact idempotent read; no history append and no new authority.
      }
      check(v.state !== "reconciliation_required" && (to === "reconciliation_required" || v.state === "created"), "invalid_transition");
      check(revision < 2, "invalid_transition");
      const event: (string | number)[] = [to, claim.workerId, claim.generation, jobRevision, ...(prep ? tuple(prep) : [])];
      const result = db.prepare("UPDATE transaction_intents SET state=?,revision=revision+1 WHERE intent_id=? AND identity=? AND revision=?")
        .run(to, id, identityValue, revision);
      check(result.changes === 1, "conflict");
      db.prepare("INSERT INTO transaction_intent_history VALUES(?,?,?,?)")
        .run(id, revision + 1, JSON.stringify(event), historyHash(v.identity, revision + 1, old.lastDigest, event));
      return load(db, id)!.value;
    });
  }
  return Object.freeze({
    createIntent(input: JobClaim, revision: number, requestId: string, feePayer: string) {
      const claim = parameters(input, revision); identifier(requestId);
      return transaction(db => {
        const current = fence(db, claim, revision).job; payer(feePayer, current.bindings);
        const request = db.prepare("SELECT job_id FROM transaction_intents WHERE request_id=?").get(requestId);
        check(!request || request.job_id === claim.jobId, "intent_conflict");
        const existing = db.prepare("SELECT intent_id FROM transaction_intents WHERE job_id=?").get(claim.jobId);
        if (existing) {
          const v = load(db, existing.intent_id as string)!.value;
          check(v.feePayer === feePayer && v.workerId === claim.workerId && v.generation === claim.generation
            && v.jobRevision === revision, "intent_conflict");
          return Object.freeze({ intent: v, created: false });
        }
        const id = randomUUID(), bound = identity(id, requestId, current, feePayer);
        db.prepare("INSERT INTO transaction_intents VALUES(?,?,?,?,?,'created',0)").run(id, requestId, claim.jobId, feePayer, bound);
        const event = ["created", claim.workerId, claim.generation, revision];
        db.prepare("INSERT INTO transaction_intent_history VALUES(?,0,?,?)")
          .run(id, JSON.stringify(event), historyHash(bound, 0, "0".repeat(64), event));
        return Object.freeze({ intent: load(db, id)!.value, created: true });
      });
    },
    recordPreparation(c: JobClaim, j: number, id: string, identityValue: string, revision: number, p: PreparationInput) {
      return mutate(c, j, id, identityValue, revision, "preparation_recorded", preparation(p));
    },
    rejectPreparation(c: JobClaim, j: number, id: string, identityValue: string, revision: number) {
      return mutate(c, j, id, identityValue, revision, "preparation_rejected");
    },
    markPreparationUncertain(c: JobClaim, j: number, id: string, identityValue: string, revision: number) {
      return mutate(c, j, id, identityValue, revision, "preparation_uncertain");
    },
    requireReconciliation(c: JobClaim, j: number, id: string, identityValue: string, revision: number) {
      return mutate(c, j, id, identityValue, revision, "reconciliation_required");
    },
    getIntent(id: string) { jobId(id); return transaction(db => load(db, id)?.value, false); },
    getForJob(id: string) { jobId(id); return transaction(db => {
      const row = db.prepare("SELECT intent_id FROM transaction_intents WHERE job_id=?").get(id);
      return row ? load(db, row.intent_id as string)!.value : undefined;
    }, false); },
    getIntentHistory(id: string) {
      jobId(id); return transaction(db => { const row = load(db, id); check(row, "not_found"); return row.history; }, false);
    },
    listOutstandingIntents(afterId?: string, limit = 100) {
      if (afterId !== undefined) jobId(afterId); integer(limit, 100); check(limit > 0);
      return transaction(db => {
        const rows = db.prepare("SELECT intent_id FROM transaction_intents WHERE intent_id>? ORDER BY intent_id LIMIT ?").all(afterId ?? "", limit);
        return Object.freeze({ entries: Object.freeze(rows.map(row => load(db, row.intent_id as string)!.value)),
          nextAfter: rows.length === limit ? rows.at(-1)!.intent_id as string : undefined });
      }, false);
    },
  });
}
