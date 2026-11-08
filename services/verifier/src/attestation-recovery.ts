/** OFFLINE ONLY: observation classification, not a recovery executor or authorization service. */
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, key, hex, sha256 } from "./commitments.js";

const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export class RecoveryError extends Error {
  constructor(public readonly code: string) { super(code); }
}
function check(value: unknown, code: string): asserts value { if (!value) throw new RecoveryError(code); }
export interface RecoveryBindings {
  readonly cluster: "devnet"; readonly genesisHash: string; readonly programId: string;
  readonly milestone: string; readonly submission: string; readonly student: string;
  readonly verifier: string; readonly feePayer: string;
  readonly requirementsHash: string; readonly evidenceHash: string; readonly messageDigest: string;
  readonly blockhash: string; readonly lastValidBlockHeight: number;
}
export type RecoveryState = "authorization_prepared" | "signing_initiated" | "submission_initiated"
  | "submission_uncertain" | "confirmation_pending" | "success_observed" | "failure_observed" | "recovery_blocked";
type Phase = "authorization" | "signing" | "submission";
type Finality = "processed" | "confirmed" | "finalized";
interface TransactionObservation { readonly outcome: "success" | "failure"; readonly finality: "confirmed" | "finalized"; readonly slot: number }
export interface RecoveryAttempt {
  readonly attemptId: string; readonly identity: string; readonly operationKey: string;
  readonly bindings: Readonly<RecoveryBindings>; readonly revision: number; readonly events: readonly string[];
  readonly state: RecoveryState; readonly phase: Phase; readonly transactionId?: string;
  readonly transaction?: Readonly<TransactionObservation>; readonly reason?: string;
}
export type RecoveryEvent =
  | { readonly kind: "signing_started" }
  | { readonly kind: "submission_started"; readonly transactionId: string }
  | { readonly kind: "submission_acknowledged"; readonly transactionId: string }
  | { readonly kind: "submission_timeout" | "submission_side_effects_unknown" }
  | { readonly kind: "signing_timeout" | "preparation_failed" | "signing_failed" }
  | { readonly kind: "rpc_timeout" | "unknown_status" | "null_lookup" | "history_missing" | "crash" }
  | { readonly kind: "blockhash_expired"; readonly currentBlockHeight: number }
  | { readonly kind: "transaction_status"; readonly transactionId: string; readonly finality: Finality;
      readonly outcome: "success" | "failure"; readonly slot: number };
export interface ObservationInput {
  readonly attemptId: string; readonly expectedRevision: number; readonly bindings: RecoveryBindings;
  readonly eventId: string; readonly event: RecoveryEvent;
}
// Tokens establish local source provenance only, NOT authenticity of RPC data or authorization.
export interface RecoveryObservation { readonly __recoveryObservation: unique symbol }
const observations = new WeakMap<object, Readonly<ObservationInput>>();
const attempts = new WeakSet<object>();
function sealAttempt(a: RecoveryAttempt): RecoveryAttempt { const result=Object.freeze(a);attempts.add(result);return result; }
/** Accepts only enumerable own data properties, never accessors, symbols or array-shaped records. */
function dataObject(value: unknown): boolean {
  return value!==null && typeof value==="object" && !Array.isArray(value)
    && Reflect.ownKeys(value).every(k=>{
      const d=Object.getOwnPropertyDescriptor(value,k);
      return typeof k==="string" && d?.enumerable===true && Object.hasOwn(d,"value");
    });
}
function exactFields(value: unknown, fields: readonly string[]): boolean {
  return dataObject(value) && Reflect.ownKeys(value as object).length===fields.length
    && fields.every(k=>Object.hasOwn(value as object,k));
}
const bindingFields = ["cluster","genesisHash","programId","milestone","submission","student","verifier","feePayer",
  "requirementsHash","evidenceHash","messageDigest","blockhash","lastValidBlockHeight"] as const;
function integer(n: unknown): boolean { return typeof n === "number" && Number.isSafeInteger(n) && n >= 0; }
function identifier(s: unknown): boolean { return typeof s === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(s); }
/** Validates public shapes and canonical submission derivation; does not assert live account validity. */
function bindings(input: RecoveryBindings): Readonly<RecoveryBindings> {
  try {
    check(exactFields(input,bindingFields),"invalid_bindings");
    input=structuredClone(input); // Validate exactly the data that will be retained; proxies cannot be cloned.
    check(exactFields(input,bindingFields),"invalid_bindings");
    check(input.cluster === "devnet" && input.genesisHash === GENESIS && input.programId === PROGRAM_ID.toBase58(),"invalid_cluster");
    for (const field of ["milestone","submission","student","verifier","feePayer","blockhash"] as const) key(input[field]);
    check(input.verifier !== input.feePayer,"invalid_bindings");
    const submission=PublicKey.findProgramAddressSync([Buffer.from("submission"),key(input.milestone).toBuffer()],PROGRAM_ID)[0];
    check(submission.toBase58()===input.submission,"invalid_bindings");
    for (const field of ["requirementsHash","evidenceHash","messageDigest"] as const) check(hex(input[field],32).some(b=>b!==0),"invalid_bindings");
    check(integer(input.lastValidBlockHeight),"invalid_expiry");
    return Object.freeze(Object.fromEntries(bindingFields.map(k=>[k,input[k]])) as unknown as RecoveryBindings);
  } catch(e) { if(e instanceof RecoveryError) throw e; throw new RecoveryError("invalid_bindings"); }
}
function identity(id: string, b: RecoveryBindings): string { return sha256(Buffer.from(JSON.stringify([id,...bindingFields.map(k=>b[k])]))).toString("hex"); }
/** Checks canonical 64-byte base58 transaction identifiers without loading a signer or wallet utility. */
function transactionId(value: unknown): asserts value is string {
  check(typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value),"invalid_transaction_id");
  let n=0n;const alphabet="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  for(const c of value) n=n*58n+BigInt(alphabet.indexOf(c));
  const zeroes=value.length-value.replace(/^1+/,"").length;
  const bytes=n===0n?0:Math.ceil(n.toString(16).length/2);
  check(bytes+zeroes===64 && n!==0n,"invalid_transaction_id");
}
/** Creates an immutable classification record only; never prepares or grants an actual authorization. */
export function createRecoveryAttempt(attemptId: string, input: RecoveryBindings): RecoveryAttempt {
  check(identifier(attemptId),"invalid_attempt_id");const b=bindings(input);
  return sealAttempt({attemptId,identity:identity(attemptId,b),operationKey:`devnet:${b.programId}:${b.milestone}`,
    bindings:b,revision:0,events:Object.freeze([] as string[]),state:"authorization_prepared",phase:"authorization"});
}
function validateAttempt(a: RecoveryAttempt): void {
  check(a && attempts.has(a) && identifier(a.attemptId) && integer(a.revision) && a.revision <= 128 && Array.isArray(a.events)
    && a.events.length===a.revision && Array.from(a.events).every(identifier) && new Set(a.events).size===a.events.length,"invalid_attempt");
  const b=bindings(a.bindings);
  check(a.identity===identity(a.attemptId,b) && a.operationKey===`devnet:${b.programId}:${b.milestone}`,"changed_bindings");
  check(["authorization_prepared","signing_initiated","submission_initiated","submission_uncertain","confirmation_pending",
    "success_observed","failure_observed","recovery_blocked"].includes(a.state)
    && ["authorization","signing","submission"].includes(a.phase),"invalid_attempt");
  if(a.transactionId!==undefined) transactionId(a.transactionId);
  if(a.phase==="submission") check(a.transactionId!==undefined,"missing_transaction_evidence");
}
/**
 * Inject a trusted server-internal observation source, never an HTTP/request adapter.
 * No RPC is performed here. Sealed tokens cannot be forged by supplying or serializing status JSON.
 * The future source must independently authenticate chain/transaction evidence; this factory cannot do so.
 */
export function createOfflineRecoveryObserver(read: (attempt: RecoveryAttempt)=>Promise<ObservationInput>) {
  return Object.freeze({observe:async(attempt: RecoveryAttempt):Promise<RecoveryObservation>=>{
    validateAttempt(attempt);
    const raw=await read(attempt);
    check(exactFields(raw,["attemptId","expectedRevision","bindings","eventId","event"]),"invalid_observation");
    check(exactFields(raw.bindings,bindingFields) && dataObject(raw.event),"invalid_observation");
    const input=structuredClone(raw);
    check(exactFields(input,["attemptId","expectedRevision","bindings","eventId","event"]),"invalid_observation");
    check(input && input.attemptId===attempt.attemptId && input.expectedRevision===attempt.revision,"observation_conflict");
    check(identity(input.attemptId,bindings(input.bindings))===attempt.identity,"changed_bindings");
    check(identifier(input.eventId),"invalid_event_id");
    const token=Object.freeze({});observations.set(token,input);return token as RecoveryObservation;
  }});
}
/**
 * Pure revisioned evaluation: historical snapshots can fork; only an atomic store may choose the accepted head.
 * Rejects stale events against the supplied head, not against an unseen global head. Never releases reservations.
 */
export function transitionRecovery(a: RecoveryAttempt, observation: RecoveryObservation): RecoveryAttempt {
  validateAttempt(a);
  const input=observation && typeof observation==="object" ? observations.get(observation) : undefined;
  check(input,"untrusted_observation");
  check(input.attemptId===a.attemptId && input.expectedRevision===a.revision,"observation_conflict");
  check(identity(input.attemptId,input.bindings)===a.identity,"changed_bindings");
  check(!a.events.includes(input.eventId),"duplicate_event");check(a.revision<128,"observation_limit");
  const e=input.event;check(e && typeof e==="object","invalid_observation");
  const fields=e.kind==="transaction_status"?["kind","transactionId","finality","outcome","slot"]:
    e.kind==="submission_started"||e.kind==="submission_acknowledged"?["kind","transactionId"]:
    e.kind==="blockhash_expired"?["kind","currentBlockHeight"]:["kind"];
  check(exactFields(e,fields),"invalid_observation");
  // Observed confirmed outcomes may only be strengthened to identical finalized evidence.
  if(a.state==="failure_observed" && !a.transaction) throw new RecoveryError("invalid_transition");
  if(a.transaction) check(e.kind==="transaction_status" && a.transaction.finality==="confirmed","consumed_state");
  let state=a.state,phase=a.phase,tx=a.transactionId,transaction=a.transaction;
  switch(e.kind) {
    case "signing_started":check(a.state==="authorization_prepared","invalid_transition");state="signing_initiated";phase="signing";break;
    case "submission_started":
      check(a.state==="signing_initiated","invalid_transition");transactionId(e.transactionId);
      check(tx===undefined || tx===e.transactionId,"transaction_substitution");tx=e.transactionId;state="submission_initiated";phase="submission";break;
    case "submission_acknowledged":
      check(phase==="submission" && ["submission_initiated","submission_uncertain","recovery_blocked"].includes(state),"invalid_transition");
      transactionId(e.transactionId);check(e.transactionId===tx,"transaction_substitution");state="confirmation_pending";break;
    case "submission_timeout":case "submission_side_effects_unknown":
      check(phase==="submission" && state==="submission_initiated","invalid_transition");state="submission_uncertain";break;
    case "preparation_failed":check(state==="authorization_prepared","invalid_transition");state="failure_observed";break;
    case "signing_failed":check(state==="signing_initiated","invalid_transition");state="failure_observed";break;
    case "signing_timeout":check(state==="signing_initiated","invalid_transition");state="recovery_blocked";break;
    case "rpc_timeout":case "unknown_status":case "null_lookup":case "history_missing":case "crash":state="recovery_blocked";break;
    case "blockhash_expired":check(integer(e.currentBlockHeight) && e.currentBlockHeight>a.bindings.lastValidBlockHeight,"invalid_expiry");state="recovery_blocked";break;
    case "transaction_status":
      check(phase==="submission" && tx!==undefined,"missing_transaction_evidence");transactionId(e.transactionId);
      check(tx===e.transactionId,"transaction_substitution");
      check(["processed","confirmed","finalized"].includes(e.finality) && ["success","failure"].includes(e.outcome) && integer(e.slot),"invalid_observation");
      if(a.transaction) check(e.finality==="finalized" && e.outcome===a.transaction.outcome && e.slot===a.transaction.slot,"contradictory_observation");
      if(e.finality==="processed") state=e.outcome==="failure"?"recovery_blocked":"confirmation_pending";
      else { transaction=Object.freeze({outcome:e.outcome,finality:e.finality,slot:e.slot});state=e.outcome==="success"?"success_observed":"failure_observed"; }
      break;
    default:throw new RecoveryError("invalid_observation");
  }
  return sealAttempt({...a,bindings:bindings(a.bindings),state,phase,transactionId:tx,transaction,
    reason:e.kind,revision:a.revision+1,events:Object.freeze([...a.events,input.eventId])});
}
/** Observations are not authorization: even finalized success/failure retains the existing reservation. */
export function classifyRecovery(a: RecoveryAttempt) {
  validateAttempt(a);
  return Object.freeze({kind:a.state==="success_observed"?"success_observed":a.state==="failure_observed"?"failure_observed":
    ["recovery_blocked","submission_uncertain"].includes(a.state)?"reconciliation_required":"in_progress",
    finality:a.transaction?.finality,observationsOnly:true as const,reservation:"retained" as const,
    retryAuthorized:false as const,submissionAuthorized:false as const});
}
/**
 * FUTURE storage contract only: this interface supplies no durability, uniqueness or cross-process exclusion.
 * Implementations must make insert unique by operationKey (not attemptId); no delete/unlock API.
 * CAS must atomically check revision, immutable identity/bindings and valid transition; false means conflict.
 * Hydration, durable adapters, worker fencing and authenticated evidence ingestion remain unimplemented.
 */
export interface RecoveryStore {
  insertIfAbsent(attempt: RecoveryAttempt):Promise<boolean>;
  read(operationKey:string):Promise<RecoveryAttempt|undefined>;
  compareAndSwap(previous: RecoveryAttempt, next: RecoveryAttempt):Promise<boolean>;
}
