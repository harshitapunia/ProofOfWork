import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, SETTLEMENT_DEVNET_GENESIS, deriveInternship, deriveMilestone, deriveSubmission } from "@proofwork/finance-client";
import { address, check, exact, LifecycleError, u64 } from "./common.js";
export interface JobBindings {
  readonly cluster: "devnet"; readonly genesisHash: string; readonly programId: string;
  readonly sponsor: string; readonly internshipId: string; readonly internship: string;
  readonly milestoneId: string; readonly milestone: string; readonly submission: string;
  readonly student: string; readonly verifier: string; readonly requirementsHash: string;
  readonly evidenceHash: string; readonly repositoryId: string; readonly contributorId: string;
  readonly commit: string; readonly verificationSpecHash: string;
}
export const BINDING_FIELDS = ["cluster","genesisHash","programId","sponsor","internshipId","internship",
  "milestoneId","milestone","submission","student","verifier","requirementsHash","evidenceHash",
  "repositoryId","contributorId","commit","verificationSpecHash"] as const;
export type JobState = "created" | "claimed" | "verification_running" | "verification_completed"
  | "verification_rejected" | "authorization_pending" | "recovery_required" | "closed";
export type JobStep = "verification_running" | "verification_completed" | "verification_rejected" | "authorization_pending" | "closed";
export interface JobClaim {
  readonly jobId: string; readonly identity: string; readonly workerId: string; readonly generation: number;
}
export interface JobMutable {
  readonly state: JobState; readonly revision: number; readonly generation: number; readonly workerId: string | null;
  readonly verificationOutcome: "none" | "passed" | "rejected"; readonly recoveryReason: string | null;
}
export interface VerificationJob extends JobMutable {
  readonly jobId: string; readonly creationId: string; readonly operationKey: string; readonly identity: string;
  readonly bindings: Readonly<JobBindings>; readonly signingAuthorization: "not_granted";
}
export interface JobHistoryEntry extends JobMutable { readonly event: readonly (string | number)[] }
export const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export function identifier(s: unknown): asserts s is string {
  check(typeof s === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(s));
}
export function jobId(s: unknown): asserts s is string {
  check(typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s));
}
export function integer(n: unknown, max: number): asserts n is number {
  check(typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= max);
}
export function publicBindings(value: JobBindings): Readonly<JobBindings> {
  try {
    exact(value, BINDING_FIELDS); value = structuredClone(value);
    check(BINDING_FIELDS.every(k => typeof value[k] === "string"));
    check(value.cluster === "devnet" && value.programId === PROGRAM_ID && value.genesisHash === SETTLEMENT_DEVNET_GENESIS);
    for (const k of ["sponsor","internship","milestone","submission","student","verifier"] as const) address(value[k]);
    for (const k of ["internshipId","milestoneId","repositoryId","contributorId"] as const) {
      check(/^(0|[1-9][0-9]{0,19})$/.test(value[k])); u64(BigInt(value[k]));
    }
    check(BigInt(value.repositoryId) > 0n && BigInt(value.contributorId) > 0n);
    check(deriveInternship(value.sponsor,BigInt(value.internshipId))[0].toBase58() === value.internship
      && deriveMilestone(value.internship,BigInt(value.milestoneId))[0].toBase58() === value.milestone
      && deriveSubmission(value.milestone)[0].toBase58() === value.submission);
    check(PublicKey.isOnCurve(new PublicKey(value.student).toBytes())
      && PublicKey.isOnCurve(new PublicKey(value.verifier).toBytes())
      && value.student !== value.verifier && value.student !== value.sponsor && value.verifier !== value.sponsor);
    for (const k of ["requirementsHash","evidenceHash","verificationSpecHash"] as const)
      check(/^[0-9a-f]{64}$/.test(value[k]) && /[1-9a-f]/.test(value[k]));
    check(/^[0-9a-f]{40}$/.test(value.commit) && /[1-9a-f]/.test(value.commit));
    check(value.verificationSpecHash === value.requirementsHash);
    return Object.freeze(Object.fromEntries(BINDING_FIELDS.map(k => [k,value[k]])) as unknown as JobBindings);
  } catch { throw new LifecycleError("invalid_input"); }
}
export const bindingText = (b: JobBindings) => JSON.stringify(BINDING_FIELDS.map(k => b[k]));
export const operationKey = (b: JobBindings) => "devnet:" + b.programId + ":" + b.milestone;
export const identity = (id: string, creation: string, b: JobBindings) => sha(JSON.stringify(["proofwork:job:v1",id,creation,...BINDING_FIELDS.map(k => b[k])]));
export function hydrateBindings(text: unknown): Readonly<JobBindings> {
  check(typeof text === "string" && text.length <= 2048);
  const a: unknown = JSON.parse(text);
  check(Array.isArray(a) && a.length === BINDING_FIELDS.length && a.every(v => typeof v === "string"));
  const b = publicBindings(Object.fromEntries(BINDING_FIELDS.map((k,n) => [k,a[n]])) as unknown as JobBindings);
  check(bindingText(b) === text); return b;
}
export function claimInput(value: JobClaim): Readonly<JobClaim> {
  try {
    exact(value,["jobId","identity","workerId","generation"]); value = structuredClone(value);
    jobId(value.jobId); identifier(value.workerId); integer(value.generation,2147483647);
    check(typeof value.identity === "string" && /^[0-9a-f]{64}$/.test(value.identity));
    return Object.freeze(value);
  } catch { throw new LifecycleError("invalid_input"); }
}
/** Pure pre-transaction bookkeeping; never creates or restores a verifier ticket. */
export function apply(previous: JobMutable | undefined, event: readonly unknown[]): JobMutable {
  check(Array.isArray(event) && event.length >= 1 && event.length <= 3);
  if (!previous) {
    check(event.length === 1 && event[0] === "created", "corrupt_store");
    return {state:"created",revision:0,generation:0,workerId:null,verificationOutcome:"none",recoveryReason:null};
  }
  check(previous.revision < 256, "job_exhausted");
  const next = {...previous,revision:previous.revision+1};
  if (event[0] === "claimed") {
    check(event.length === 2); identifier(event[1]);
    check(previous.state === "created" || (previous.state === "recovery_required"
      && ["claim_interrupted","verification_interrupted"].includes(previous.recoveryReason!)), "invalid_transition");
    check(previous.generation < 2147483647, "job_exhausted");
    return {...next,state:"claimed",generation:previous.generation+1,workerId:event[1],verificationOutcome:"none",recoveryReason:null};
  }
  if (event[0] === "interrupted") {
    check(event.length === 2); identifier(event[1]);
    const reasons: Partial<Record<JobState,string>> = {claimed:"claim_interrupted",verification_running:"verification_interrupted",
      verification_completed:"completed_interrupted",authorization_pending:"authorization_uncertain"};
    check(reasons[previous.state], "invalid_transition");
    check(previous.generation < 2147483647, "job_exhausted");
    return {...next,state:"recovery_required",generation:previous.generation+1,workerId:null,recoveryReason:reasons[previous.state]!};
  }
  check(event.length === 3); identifier(event[1]); integer(event[2],2147483647);
  check(previous.workerId === event[1] && previous.generation === event[2], "stale_claim");
  switch(event[0]) {
    case "verification_running": check(previous.state === "claimed","invalid_transition"); return {...next,state:"verification_running"};
    case "verification_completed": check(previous.state === "verification_running","invalid_transition");
      return {...next,state:"verification_completed",verificationOutcome:"passed"};
    case "verification_rejected": check(previous.state === "verification_running","invalid_transition");
      return {...next,state:"verification_rejected",verificationOutcome:"rejected"};
    case "authorization_pending": check(previous.state === "verification_completed","invalid_transition");
      return {...next,state:"authorization_pending"};
    case "closed": check(previous.state === "verification_rejected","invalid_transition"); return {...next,state:"closed"};
    default: throw new LifecycleError("invalid_transition");
  }
}
