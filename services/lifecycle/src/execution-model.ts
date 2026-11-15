import { check, exact, MAX_ID } from "./common.js";
import { integer } from "./job-model.js";
import type { TransactionIntent } from "./transaction-intents.js";

export type ExecutionPhase = "execution_record_created" | "submission_intent_recorded" | "submission_initiated"
  | "submission_uncertain" | "acknowledgment_observed" | "confirmation_pending"
  | "confirmed_success_observed" | "confirmed_failure_observed"
  | "finalized_success_observed" | "finalized_failure_observed";
export interface ExecutionFacts {
  readonly phase: ExecutionPhase; readonly wireDigest: string | null; readonly testTransactionId: string | null;
  readonly invocationRecorded: boolean; readonly finality: number; readonly outcome: "none" | "success" | "failure";
  readonly error: string | null; readonly transactionSlot: string | null; readonly contextSlot: string | null;
  readonly observedBlockHeight: string | null; readonly uncertain: boolean;
}
export interface ExecutionAttempt extends ExecutionFacts {
  readonly attemptId: string; readonly identity: string; readonly requestId: string; readonly revision: number;
  readonly intent: TransactionIntent; readonly observationAuthority: string;
  readonly mode: "offline-test-model"; readonly rpcAuthenticated: false; readonly signingAuthorization: "not_granted";
  readonly submissionAuthorized: false; readonly retryAuthorized: false; readonly reservationRetained: true;
  readonly reconciliationRequired: boolean;
}
export interface ExecutionEvidence {
  readonly eventId: string; readonly attemptId: string; readonly identity: string; readonly revision: number;
  readonly intentIdentity: string; readonly preparationIdentity: string; readonly bindingDigest: string;
  readonly kind: "signed_identity" | "ack" | "status" | "unknown" | "timeout" | "null_lookup" | "history_missing" | "expired";
  readonly wireDigest: string; readonly testTransactionId: string; readonly finality: number;
  readonly outcome: "none" | "success" | "failure"; readonly error: string | null;
  readonly transactionSlot: string | null; readonly contextSlot: string | null; readonly observedBlockHeight: string;
}
export const evidenceFields = ["eventId","attemptId","identity","revision","intentIdentity","preparationIdentity","bindingDigest",
  "kind","wireDigest","testTransactionId","finality","outcome","error","transactionSlot","contextSlot","observedBlockHeight"] as const;
export function height(v: unknown): asserts v is string {
  check(typeof v === "string" && /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= MAX_ID);
}
export const initialFacts = (): ExecutionFacts => ({ phase:"execution_record_created",wireDigest:null,testTransactionId:null,
  invocationRecorded:false,finality:0,outcome:"none",error:null,transactionSlot:null,contextSlot:null,observedBlockHeight:null,uncertain:true });
/** Pure replay only. This does not authenticate observations or authorize any effect. */
export function advance(old: ExecutionFacts, event: "invoke" | "uncertain" | ExecutionEvidence, lastHeight: string): ExecutionFacts {
  check(old.finality !== 3, "terminal_execution");
  if (event === "invoke") {
    check(old.phase === "submission_intent_recorded" && !old.invocationRecorded, "invalid_transition");
    return {...old,phase:"submission_initiated",invocationRecorded:true,uncertain:true};
  }
  if (event === "uncertain") {
    return {...old,phase:old.finality > 0 || old.phase === "acknowledgment_observed" ? old.phase : "submission_uncertain",uncertain:true};
  }
  exact(event,evidenceFields); integer(event.finality,3); height(event.observedBlockHeight);
  check(/^[0-9a-f]{64}$/.test(event.wireDigest));
  if (old.wireDigest !== null) check(old.wireDigest === event.wireDigest && old.testTransactionId === event.testTransactionId, "transaction_conflict");
  if (old.observedBlockHeight !== null) check(BigInt(event.observedBlockHeight) >= BigInt(old.observedBlockHeight), "height_regression");
  const next = {...old,observedBlockHeight:event.observedBlockHeight};
  if (event.kind === "signed_identity") {
    const recoveryWindow = old.phase === "submission_uncertain" && old.wireDigest === null && !old.invocationRecorded;
    check(old.phase === "execution_record_created" || recoveryWindow, "invalid_transition");
    check(event.finality === 0 && event.outcome === "none" && event.error === null && event.transactionSlot === null && event.contextSlot === null);
    return {...next,phase:recoveryWindow ? "submission_uncertain" : "submission_intent_recorded",wireDigest:event.wireDigest,testTransactionId:event.testTransactionId};
  }
  check(old.wireDigest !== null, "missing_signed_identity");
  if (event.kind !== "status") {
    check(event.finality === 0 && event.outcome === "none" && event.error === null && event.transactionSlot === null && event.contextSlot === null);
    if (event.kind === "ack") {
      check(old.finality === 0 && old.phase !== "acknowledgment_observed", "invalid_transition");
      return {...next,phase:"acknowledgment_observed",uncertain:true};
    }
    check(["unknown","timeout","null_lookup","history_missing","expired"].includes(event.kind));
    if (event.kind === "expired") check(BigInt(event.observedBlockHeight) > BigInt(lastHeight), "not_expired");
    return {...next,phase:old.finality > 0 || old.phase === "acknowledgment_observed" ? old.phase : "submission_uncertain",uncertain:true};
  }
  check(event.finality > old.finality && event.finality >= 1, "finality_regression");
  check(event.outcome === "success" || event.outcome === "failure");
  check(event.outcome === "success" ? event.error === null : typeof event.error === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(event.error));
  height(event.transactionSlot); height(event.contextSlot);
  check(BigInt(event.contextSlot) >= BigInt(event.transactionSlot), "invalid_slot");
  if (old.finality > 0) check(old.outcome === event.outcome && old.error === event.error
    && old.transactionSlot === event.transactionSlot && BigInt(event.contextSlot) >= BigInt(old.contextSlot!), "contradictory_observation");
  const phase: ExecutionPhase = event.finality === 1 ? "confirmation_pending"
    : event.finality === 2 ? (event.outcome === "success" ? "confirmed_success_observed" : "confirmed_failure_observed")
    : event.outcome === "success" ? "finalized_success_observed" : "finalized_failure_observed";
  return {...next,phase,finality:event.finality,outcome:event.outcome,error:event.error,
    transactionSlot:event.transactionSlot,contextSlot:event.contextSlot,uncertain:event.finality !== 3};
}
const snapshots = new WeakSet<object>();
export function sealSnapshot<T extends ExecutionAttempt>(value: T): T { snapshots.add(value); return Object.freeze(value); }
export function requireSnapshot(value: ExecutionAttempt): void { check(snapshots.has(value), "untrusted_execution_snapshot"); }
