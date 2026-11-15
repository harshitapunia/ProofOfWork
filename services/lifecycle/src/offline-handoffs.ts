import type { DatabaseSync } from "node:sqlite";
import { check, LifecycleError } from "./common.js";
import { claimInput, integer, jobId, sha, type JobClaim } from "./job-model.js";
import { append, expected, read, type JobTransaction } from "./jobs.js";

export type MockOutcome = "recorded" | "rejected" | "uncertain";
export interface OfflineHandoff {
  readonly jobId: string;
  readonly identity: string;
  readonly workerId: string;
  readonly generation: number;
  readonly revision: number;
  readonly messageDigest: string;
  readonly outcome: "intent" | MockOutcome;
  readonly reason: "pending" | "acknowledged" | "mock_rejected" | "mock_failure" | "mock_timeout";
  readonly signingAuthorization: "not_granted";
}
export interface OfflineHandoffs {
  begin(claim: JobClaim, revision: number, messageDigest: string): OfflineHandoff;
  finish(claim: JobClaim, revision: number, messageDigest: string, outcome: MockOutcome,
    reason: OfflineHandoff["reason"]): OfflineHandoff;
  get(jobId: string): OfflineHandoff | undefined;
}
const hash = (identity: string, sequence: number, previous: string, event: readonly unknown[]) =>
  sha(JSON.stringify(["proofwork:offline-handoff:v1", identity, sequence, previous, event]));
function digest(s: unknown): asserts s is string {
  check(typeof s === "string" && /^[0-9a-f]{64}$/.test(s) && /[1-9a-f]/.test(s));
}
function readHandoff(db: DatabaseSync, id: string): OfflineHandoff | undefined {
  const job = read(db, id); check(job, "not_found");
  const rows = db.prepare("SELECT sequence,event,digest FROM verification_offline_handoffs WHERE job_id=? ORDER BY sequence LIMIT 3").all(id);
  if (!rows.length) return undefined;
  try {
    check(rows.length <= 2);
    let previous = "0".repeat(64), intent: unknown[] | undefined, result: OfflineHandoff | undefined;
    for (const [n, row] of rows.entries()) {
      check(row.sequence === n && typeof row.event === "string" && row.event.length <= 512);
      const e: unknown = JSON.parse(row.event);
      check(Array.isArray(e) && e.length === 6 && JSON.stringify(e) === row.event);
      digest(e[4]); integer(e[2], 2147483647); integer(e[3], 256);
      const historical = job.history[e[3]];
      check(historical?.state === "authorization_pending" && historical.workerId === e[1] && historical.generation === e[2]);
      if (n === 0) { check(e[0] === "intent" && e[5] === "pending"); intent = e; }
      else {
        check(intent && JSON.stringify(e.slice(1, 5)) === JSON.stringify(intent.slice(1, 5)));
        check(e[0] === "recorded" ? e[5] === "acknowledged" : e[0] === "rejected" ? e[5] === "mock_rejected"
          : e[0] === "uncertain" && ["mock_failure", "mock_timeout"].includes(String(e[5])));
      }
      const h = hash(job.job.identity, n, previous, e); check(row.digest === h); previous = h;
      result = Object.freeze({ jobId: id, identity: job.job.identity, workerId: e[1] as string,
        generation: e[2], revision: e[3], messageDigest: e[4], outcome: e[0] as OfflineHandoff["outcome"],
        reason: e[5] as OfflineHandoff["reason"], signingAuthorization: "not_granted" });
    }
    return result;
  } catch { throw new LifecycleError("corrupt_store"); }
}
function fenced(db: DatabaseSync, claim: JobClaim, revision: number) {
  const record = expected(db, claim.jobId, claim.identity, revision);
  check(record.job.workerId === claim.workerId && record.job.generation === claim.generation, "stale_claim");
  check(record.job.state === "authorization_pending", "invalid_transition");
  return record;
}
/** Internal database mock receipt only. No message input, ticket reconstruction, signing or callbacks. */
export function createOfflineHandoffs(transaction: JobTransaction): OfflineHandoffs {
  return Object.freeze({
    begin(input: JobClaim, revision: number, messageDigest: string) {
      const claim = claimInput(input); integer(revision, 256); digest(messageDigest);
      return transaction(db => {
        const old = fenced(db, claim, revision);
        check(!readHandoff(db, claim.jobId), "duplicate_handoff");
        const event = ["intent", claim.workerId, claim.generation, revision, messageDigest, "pending"];
        db.prepare("INSERT INTO verification_offline_handoffs VALUES(?,0,?,?)")
          .run(claim.jobId, JSON.stringify(event), hash(old.job.identity, 0, "0".repeat(64), event));
        return readHandoff(db, claim.jobId)!;
      });
    },
    finish(input: JobClaim, revision: number, messageDigest: string, outcome: MockOutcome, reason: OfflineHandoff["reason"]) {
      const claim = claimInput(input); integer(revision, 256); digest(messageDigest);
      check(outcome === "recorded" ? reason === "acknowledged" : outcome === "rejected" ? reason === "mock_rejected"
        : outcome === "uncertain" && ["mock_failure", "mock_timeout"].includes(reason));
      return transaction(db => {
        const old = fenced(db, claim, revision), intent = readHandoff(db, claim.jobId);
        check(intent?.outcome === "intent" && intent.workerId === claim.workerId && intent.generation === claim.generation
          && intent.revision === revision && intent.messageDigest === messageDigest, "duplicate_handoff");
        const first = db.prepare("SELECT digest FROM verification_offline_handoffs WHERE job_id=? AND sequence=0").get(claim.jobId)!;
        const event = [outcome, claim.workerId, claim.generation, revision, messageDigest, reason];
        db.prepare("INSERT INTO verification_offline_handoffs VALUES(?,1,?,?)")
          .run(claim.jobId, JSON.stringify(event), hash(old.job.identity, 1, first.digest as string, event));
        if (outcome !== "recorded") append(db, old, ["interrupted", claim.workerId]);
        return readHandoff(db, claim.jobId)!;
      });
    },
    get(id: string) { jobId(id); return transaction(db => readHandoff(db, id), false); },
  });
}
