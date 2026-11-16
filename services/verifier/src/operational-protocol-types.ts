/** Offline protocol DATA ONLY. No transport, credentials, tickets or authenticated authority. */
import type { JobBindings } from "@proofwork/lifecycle";
export const PROTOCOL_VERSION = "proofwork-operational-contracts-v1" as const;
export const PROTOCOL_POLICY = "attest-canonical-legacy-v1" as const;
export type Role = "verifier" | "fee_payer";
export interface ProtocolAnchor {
  readonly bindings: JobBindings; readonly jobId: string; readonly jobIdentity: string;
  readonly intentId: string; readonly intentIdentity: string; readonly feePayer: string;
  readonly messageDigest: string; readonly snapshotDigest: string; readonly blockhash: string;
  readonly lastValidBlockHeight: string; readonly preparedAtBlockHeight: string;
  readonly issuedAtUnixMs: string; readonly deadlineUnixMs: string; readonly epoch: string;
  readonly policyVersion: typeof PROTOCOL_POLICY; readonly operatorApprovalRef: string;
  readonly verifierApprovalRef: string; readonly payerApprovalRef: string; readonly submissionApprovalRef: string;
}
/** Caller-supplied comparison snapshot, NOT an authenticated clock/control/source oracle. */
export interface ProtocolSnapshot {
  readonly nowUnixMs: string; readonly blockHeight: string; readonly currentEpoch: string; readonly minRemainingBlockHeights: string; readonly sourceIds: readonly string[];
}
export interface AdmissionRequest {
  readonly version: typeof PROTOCOL_VERSION; readonly kind: "offline_admission_data"; readonly admissionId: string;
  readonly operationKey: string; readonly jobId: string; readonly jobIdentity: string;
  readonly intentId: string; readonly intentIdentity: string; readonly bindings: JobBindings;
  readonly feePayer: string; readonly messageDigest: string; readonly messageBase64: string; readonly snapshotDigest: string;
  readonly policyVersion: typeof PROTOCOL_POLICY; readonly issuedAtUnixMs: string; readonly deadlineUnixMs: string;
  readonly blockhash: string; readonly lastValidBlockHeight: string; readonly preparedAtBlockHeight: string;
  readonly operatorApprovalRef: string; readonly epoch: string;
}
export interface CustodyRoleRequest {
  readonly version: typeof PROTOCOL_VERSION; readonly kind: "offline_verifier_request" | "offline_fee_payer_request";
  readonly requestId: string; readonly admissionId: string; readonly admissionDigest: string; readonly operationKey: string;
  readonly role: Role; readonly publicKey: string; readonly messageDigest: string; readonly messageBase64: string;
  readonly deadlineUnixMs: string; readonly epoch: string; readonly roleApprovalRef: string;
}
export type SigningState = "not_admitted" | "admission_accepted" | "signature_observed" | "signing_rejected" | "signing_uncertain";
interface SigningBase {
  readonly version: typeof PROTOCOL_VERSION; readonly kind: "offline_signing_outcome"; readonly state: SigningState;
  readonly requestId: string; readonly requestDigest: string; readonly admissionId: string; readonly operationKey: string;
  readonly role: Role; readonly publicKey: string; readonly messageDigest: string;
}
export type SigningOutcome = SigningBase & (
  | {readonly state:"signature_observed";readonly receiptRef:string;readonly signatureBase64:string}
  | {readonly state:"admission_accepted";readonly receiptRef:string}
  | {readonly state:"not_admitted" | "signing_rejected";readonly reason:string}
  | {readonly state:"signing_uncertain";readonly reason:string;readonly receiptRef:string|null}
);
export interface SubmissionRequest {
  readonly version: typeof PROTOCOL_VERSION; readonly kind:"offline_first_submission_data"; readonly senderAdmissionId:string;
  readonly admissionId:string;readonly admissionDigest:string;readonly operationKey:string;readonly messageDigest:string;
  readonly wireBase64:string;readonly wireDigest:string;readonly transactionId:string;readonly submissionApprovalRef:string;
  readonly deadlineUnixMs:string;readonly epoch:string;
}
export type SubmissionState = "not_admitted" | "intent_recorded" | "invocation_potentially_occurred" | "acknowledgment_received" | "submission_uncertain";
export interface SubmissionOutcome {
  readonly version:typeof PROTOCOL_VERSION;readonly kind:"offline_submission_outcome";readonly state:SubmissionState;
  readonly senderAdmissionId:string;readonly submissionDigest:string;readonly transactionId:string;
  readonly acknowledgmentTransactionId:string|null;readonly reason:string|null;
}
export type Finality = "processed" | "confirmed" | "finalized";
export interface StatusClaim {
  readonly kind:"status_claim";readonly transactionId:string;readonly messageDigest:string;readonly wireDigest:string;
  readonly finality:Finality;readonly outcome:"success"|"failure";readonly errorCode:string|null;
  readonly transactionSlot:string;readonly contextSlot:string;readonly observedBlockHeight:string;
}
export type TransactionEvidence = StatusClaim
  | {readonly kind:"missing";readonly reason:"null_lookup"|"history_missing"|"rpc_timeout"}
  | {readonly kind:"conflict";readonly left:StatusClaim;readonly right:StatusClaim};
export type AccountEvidence =
  | {readonly kind:"not_supplied"|"incomplete"|"mismatched";readonly reason:string}
  | {readonly kind:"matching_candidate";readonly programId:string;readonly milestone:string;readonly submission:string;
     readonly student:string;readonly verifier:string;readonly requirementsHash:string;readonly evidenceHash:string;
     readonly milestoneStatus:"Verified"|"Settled";readonly submittedAt:string;readonly verifiedAt:string;
     readonly contextSlot:string;readonly accountSetDigest:string;readonly completionDigest:string|null};
export interface SourceProvenance {
  readonly kind:"offline_fixture"|"unverified_reference";readonly sourceId:string;
  readonly cluster:"devnet";readonly genesisHash:string;readonly requestId:string;readonly eventId:string;readonly contextSlot:string;
}
export interface ObservationContract {
  readonly version:typeof PROTOCOL_VERSION;readonly kind:"offline_observation_data";
  readonly senderAdmissionId:string;readonly submissionDigest:string;readonly operationKey:string;
  readonly provenance:SourceProvenance;readonly transaction:TransactionEvidence;readonly accounts:AccountEvidence;
}
export interface ValidatedProtocolData<T> {
  readonly kind:"validated_offline_contract_data";readonly data:T;
  readonly operationalAuthorization:false;readonly authenticated:false;readonly retryAuthorized:false;
  readonly reservationReleaseAuthorized:false;
}
