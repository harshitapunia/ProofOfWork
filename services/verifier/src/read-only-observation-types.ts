/** Offline evidence contracts only. No network, signer, storage writer or operational authority. */
import type { ExecutionAttempt } from "@proofwork/lifecycle";
import type { AdmissionRequest, SubmissionRequest, ProtocolAnchor, ProtocolSnapshot, SourceProvenance,
  StatusClaim, TransactionEvidence, ObservationContract, Finality } from "./operational-protocol.js";
export interface ExecutionReadReference {readonly attemptId:string;readonly identity:string;readonly revision:number}
export type ExecutionReadView=Pick<ExecutionAttempt,"attemptId"|"identity"|"revision"|"intent"|"mode"|"wireDigest"|"testTransactionId">;
export interface ReadOnlyExecutionLookup { get(id:string):ExecutionReadView|undefined }
export interface SourceEventReference {readonly sourceId:string;readonly eventId:string}
export interface PriorObservationEvent extends SourceEventReference {readonly contextSlot:string}
export interface OfflineReadPlan {
 readonly kind:"offline_read_plan";readonly attempt:ExecutionReadReference;readonly admission:AdmissionRequest;
 readonly submission:SubmissionRequest;readonly anchor:ProtocolAnchor;readonly snapshot:ProtocolSnapshot;
 readonly requestId:string;readonly minimumContextSlot:string;readonly events:readonly SourceEventReference[];
 readonly priorEvents:readonly PriorObservationEvent[];
}
export interface OfflineReadQuery {
 readonly mode:"offline_mock";readonly sourceId:string;readonly requestId:string;readonly eventId:string;
 readonly attemptId:string;readonly attemptIdentity:string;readonly operationKey:string;readonly transactionId:string;
 readonly minimumContextSlot:string;readonly addresses:Readonly<{internship:string;milestone:string;submission:string;completion:string}>;
}
export interface StatusRead {
 readonly kind:"status_read";readonly provenance:SourceProvenance;readonly currentBlockHeight:string;
 readonly evidence:TransactionEvidence;
}
export type DetailRead =
 | {readonly kind:"transaction_read";readonly provenance:SourceProvenance;readonly commitment:Finality;
    readonly transactionId:string;readonly wireBase64:string;readonly wireDigest:string;readonly transactionSlot:string;
    readonly outcome:"success"|"failure";readonly errorCode:string|null}
 | {readonly kind:"transaction_missing";readonly provenance:SourceProvenance;readonly reason:"null_lookup"|"history_missing"};
export interface RawProgramAccount {readonly owner:string;readonly executable:boolean;readonly data:readonly [string,"base64"]}
export interface RawAccountEntry {readonly address:string;readonly account:RawProgramAccount|null}
export interface RawAccountSet {
 readonly internship:RawAccountEntry;readonly milestone:RawAccountEntry;readonly submission:RawAccountEntry;readonly completion:RawAccountEntry;
}
export type AccountRead =
 | {readonly kind:"accounts_read";readonly provenance:SourceProvenance;readonly commitment:Finality;readonly accounts:RawAccountSet}
 | {readonly kind:"accounts_missing";readonly provenance:SourceProvenance;readonly reason:"missing_accounts"|"history_missing"};
/** Read DTOs are untrusted fixtures. A mode string never authenticates an RPC source. */
export interface OfflineReadSource {
 readonly mode:"offline_mock";readonly sourceId:string;
 readStatus(query:OfflineReadQuery):Promise<unknown>;
 readTransaction(query:OfflineReadQuery):Promise<unknown>;
 readAccounts(query:OfflineReadQuery):Promise<unknown>;
}
export interface OfflineReadOptions {readonly readTimeoutMs:number}
export interface OfflineSourceBundle extends SourceEventReference {
 readonly status:unknown|null;readonly transaction:unknown|null;readonly accounts:unknown|null;
 readonly interruption:null|"before_read"|"status_timeout"|"status_exception"|"transaction_timeout"|"transaction_exception"|"accounts_timeout"|"accounts_exception";
}
export type ReconciliationClassification="missing_evidence"|"incomplete_evidence"|"conflicting_evidence"|"provisional_observation"
 |"confirmed_observation"|"finalized_failure"|"finalized_success_candidate"|"account_state_mismatch"
 |"matching_finalized_candidate"|"reconciliation_required";
export interface OfflineSourceObservation extends SourceEventReference {
 readonly classification:ReconciliationClassification;readonly reasons:readonly string[];readonly protocol:ObservationContract|null;
 readonly transactionEvidenceConsistent:boolean;readonly rawFixtureAccountsMatch:boolean;readonly evidenceDigest:string;
 readonly status:StatusClaim|null;readonly accountCommitment:Finality|null;
}
export interface OfflineReconciliation {
 readonly mode:"offline_mock";readonly attempt:ExecutionReadReference;readonly operationKey:string;readonly transactionId:string;
 readonly classification:ReconciliationClassification;readonly reasons:readonly string[];readonly observations:readonly OfflineSourceObservation[];
 readonly rpcAuthenticated:false;readonly onChainStateVerified:false;readonly operationalStateMutationAuthorized:false;
 readonly signingAuthorization:"not_granted";readonly submissionAuthorized:false;readonly retryAuthorized:false;
 readonly reservationReleaseAuthorized:false;readonly settlementPermission:false;readonly operationalUncertaintyClearAuthorized:false;
 readonly reconciliationRequired:true;
}
