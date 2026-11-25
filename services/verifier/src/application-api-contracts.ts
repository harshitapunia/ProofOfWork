import type {AttestationReview} from "./controlled-attestation.js";
import type { WorkflowVerificationJob } from "./workflow-verification.js";
import type { WorkflowState, VerificationHandoff } from "./workflow-state.js";
import type { WalletReview, WalletConfirmation } from "./devnet-wallet-review.js";
import type { WorkflowPreparation } from "./workflow-preparation.js";
import { randomUUID } from "node:crypto";
import type { VerificationJob, ExecutionAttempt, Milestone, TransactionIntent } from "@proofwork/lifecycle";
export const APPLICATION_API_VERSION = "proofwork-application-api-v1" as const;
export type ApplicationResource = "job" | "milestone" | "execution";
export type ApiProvenance = "none" | "process_health" | "lifecycle_v5_offline" | "offline_fixture" | "unverified_devnet_rpc" | "server_challenge" | "wallet_signature_session" | "unsigned_finance_client";
export const READ_ONLY_PERMISSIONS = Object.freeze({ operationalAuthorization: false as const,
  signingAuthorization: "not_granted" as const, submissionAuthorized: false as const, retryAuthorized: false as const,
  reservationReleaseAuthorized: false as const, rpcAuthenticated: false as const, onChainStateVerified: false as const,
  operationalStateMutationAuthorized: false as const });
export interface VerificationJobView {
  readonly controlledRecovery?: Readonly<{generation:number;attemptId:string|null;attemptState:string|null}>;
  readonly kind: "verification_job"; readonly jobId: string; readonly identity: string; readonly milestone: string;
  readonly state: VerificationJob["state"]; readonly verificationOutcome: VerificationJob["verificationOutcome"];
  readonly reconciliationRequired: boolean; readonly errorClassification: "verification_rejected" | "reconciliation_required" | null;
  readonly fullVerificationResult: "not_persisted";
  readonly timestamps: Readonly<{ createdAt: null; startedAt: null; finishedAt: null }>;
}
export interface ExecutionStatusView {
  readonly kind: "execution_status"; readonly jobId: string; readonly milestone: string;
  readonly intentId: string | null; readonly intentState: TransactionIntent["state"] | null;
  readonly preparation: "recorded" | "unavailable"; readonly attemptId: string | null;
  readonly mode: "offline-test-model"; readonly phase: ExecutionAttempt["phase"] | null;
  readonly uncertain: boolean; readonly reconciliationRequired: boolean;
  readonly offlineObservation: "unavailable" | "test_evidence_only";
  readonly operationalExecution: "unavailable"; readonly liveTransactionId: null;
  readonly rewardPayment: "not_established";
}
export interface MilestoneStateView {
  readonly kind: "milestone_state"; readonly address: string; readonly internship: string;
  readonly sponsor: string; readonly student: string; readonly verifier: string; readonly rewardMint: string;
  readonly status: Milestone["status"]; readonly rewardAmountRaw: string; readonly milestoneId: string;
  readonly assignBy: string; readonly submitBy: string; readonly submittedAt: string | null;
  readonly verifiedAt: string | null; readonly settledAt: string | null;
  readonly slot: number; readonly commitment: "confirmed" | "finalized";
  readonly programDeployment: "not_verified"; readonly rewardPayment: "not_established";
}
export interface HealthView {
  readonly kind: "health"; readonly process: "serving"; readonly readiness: "limited";
  readonly authentication: "application_adapter_not_registered" | "wallet_signature_single_instance"; readonly applicationReads: "http_routes_not_registered" | "authenticated_read_routes";
  readonly storage: "not_probed"; readonly chain: "not_probed"; readonly execution: "disabled"|"action_approval_required";
}
export interface WalletChallengeView {
  readonly kind: "wallet_challenge"; readonly challengeId: string; readonly wallet: string;
  readonly issuedAt: string; readonly expiresAt: string; readonly message: string;
  readonly signedMessageFormat: "siws-raw-ed25519"; readonly signInInput: Readonly<Record<string, string>>;
}
export interface WalletSessionView {
  readonly kind: "wallet_session"; readonly wallet: string; readonly sessionId: string;
  readonly authenticationMethod: "siws-raw-ed25519"; readonly origin: string; readonly domain: string;
  readonly cluster: "devnet"; readonly authenticatedAt: string; readonly expiresAt: string;
}
export interface WalletLogoutView { readonly kind: "wallet_logout"; readonly revoked: true }
export type ApplicationView = {kind:"wallet_execution_recovery";operationKey:string;attemptId:string;signature:string|null;recordedState:string;confirmation:WalletConfirmation|null;retryAuthorized:false;liveExecution:false} | AttestationReview | {kind:"attestation_signature";signatureCount:number} | {kind:"attestation_confirmation";state:"confirmed"|"failed"|"unknown";signature:string;retryAuthorized:false} | {kind:"wallet_execution_authorization";liveExecution:true} | {kind:"wallet_execution_submission";state:"submitted"|"unknown";signature:string;retryAuthorized:false} | WorkflowVerificationJob | WorkflowState | VerificationHandoff | {kind:"wallet_execution_signature";signature:string;liveExecution:false} | WalletReview | WalletConfirmation | {kind:"wallet_execution_revalidation";liveExecution:false;state:"ready_for_review"} | WorkflowPreparation | WalletChallengeView | WalletSessionView | WalletLogoutView | VerificationJobView | ExecutionStatusView | MilestoneStateView | HealthView;
export interface ApiReply<T extends ApplicationView = ApplicationView> {
  readonly statusCode: number;
  readonly body: Readonly<{ apiVersion: typeof APPLICATION_API_VERSION; requestId: string; cluster: "devnet";
    resource: Readonly<{ kind: ApplicationResource | "authentication" | "health" | "unknown"; id: string | null }>;
    availability: "available" | "unavailable" | "limited"; provenance: ApiProvenance;
    data: T | null; error: Readonly<{ code: string }> | null; permissions: typeof READ_ONLY_PERMISSIONS }>;
}
/** Server-generated tracing ID, never an identity/authentication token or caller echo. */
export const applicationRequestId = () => randomUUID();
export function applicationReply<T extends ApplicationView>(requestId: string, kind: ApplicationResource | "authentication" | "health" | "unknown", id: string | null,
  statusCode: number, data: T | null, provenance: ApiProvenance, code: string | null = null,
  availability: ApiReply["body"]["availability"] = code ? "unavailable" : "available"): ApiReply<T> {
  return Object.freeze({ statusCode, body: Object.freeze({ apiVersion: APPLICATION_API_VERSION, requestId, cluster: "devnet",
    resource: Object.freeze({ kind, id }), availability, provenance, data,
    error: code === null ? null : Object.freeze({ code }), permissions: READ_ONLY_PERMISSIONS }) });
}
export function applicationHealth(): ApiReply<HealthView> {
  return applicationReply(applicationRequestId(), "health", null, 200, Object.freeze({ kind: "health", process: "serving",
    readiness: "limited", authentication: "application_adapter_not_registered", applicationReads: "http_routes_not_registered",
    storage: "not_probed", chain: "not_probed", execution: "disabled" }), "process_health", null, "limited");
}
