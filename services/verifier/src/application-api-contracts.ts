import { randomUUID } from "node:crypto";
import type { VerificationJob, ExecutionAttempt, Milestone, TransactionIntent } from "@proofwork/lifecycle";
export const APPLICATION_API_VERSION = "proofwork-application-api-v1" as const;
export type ApplicationResource = "job" | "milestone" | "execution";
export type ApiProvenance = "none" | "process_health" | "lifecycle_v5_offline" | "offline_fixture" | "unverified_devnet_rpc";
export const READ_ONLY_PERMISSIONS = Object.freeze({ operationalAuthorization: false as const,
  signingAuthorization: "not_granted" as const, submissionAuthorized: false as const, retryAuthorized: false as const,
  reservationReleaseAuthorized: false as const, rpcAuthenticated: false as const, onChainStateVerified: false as const,
  operationalStateMutationAuthorized: false as const });
export interface VerificationJobView {
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
  readonly authentication: "application_adapter_not_registered"; readonly applicationReads: "http_routes_not_registered";
  readonly storage: "not_probed"; readonly chain: "not_probed"; readonly execution: "disabled";
}
export type ApplicationView = VerificationJobView | ExecutionStatusView | MilestoneStateView | HealthView;
export interface ApiReply<T extends ApplicationView = ApplicationView> {
  readonly statusCode: number;
  readonly body: Readonly<{ apiVersion: typeof APPLICATION_API_VERSION; requestId: string; cluster: "devnet";
    resource: Readonly<{ kind: ApplicationResource | "health" | "unknown"; id: string | null }>;
    availability: "available" | "unavailable" | "limited"; provenance: ApiProvenance;
    data: T | null; error: Readonly<{ code: string }> | null; permissions: typeof READ_ONLY_PERMISSIONS }>;
}
/** Server-generated tracing ID, never an identity/authentication token or caller echo. */
export const applicationRequestId = () => randomUUID();
export function applicationReply<T extends ApplicationView>(requestId: string, kind: ApplicationResource | "health" | "unknown", id: string | null,
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
