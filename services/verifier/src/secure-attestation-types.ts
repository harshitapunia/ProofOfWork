/** Internal offline composition contracts. No request can supply custody, RPCs or authorization. */
import type { ExecutionAttempt } from "@proofwork/lifecycle";
import type { VerificationResult } from "./service.js";
import type { TransactionPolicyConfig } from "./transaction-policy.js";
import type { OfflineSimulationEvidence } from "./offline-signature-simulation.js";
import type { OfflineReadSource, OfflineReconciliation } from "./read-only-observation.js";

export interface OfflineIntegrationConfig {
  readonly mode: "offline-only";
  readonly workerId: string;
  readonly policy: TransactionPolicyConfig;
  /** Explicit existing test-observation public identity, never an operational RPC identity. */
  readonly observationAuthority: string;
}
export interface OfflineIntegrationObservation {
  readonly sources: readonly OfflineReadSource[];
  readonly readTimeoutMs: number;
  /** Synchronous trusted fixture composition. Returned data is revalidated, not trusted. */
  readonly planFor: (attempt: ExecutionAttempt) => unknown;
}
export interface OfflineInvestigationRequest {
  readonly mode: "offline-only";
  readonly requestId: string;
  readonly evidence: unknown;
}
export interface OfflineInspectionRequest {
  readonly mode: "offline-only";
  readonly attemptId: string;
  readonly identity: string;
  readonly revision: number;
}
export type IntegrationStage = "job_identity_resolved" | "verification_completed" | "authorization_consumed" | "preparation_recorded"
  | "offline_signature_evidence_observed" | "execution_bookkeeping_recorded" | "observation_classified";
export interface IntegrationExecution {
  readonly attemptId: string; readonly identity: string; readonly revision: number;
  readonly jobId: string; readonly jobIdentity: string; readonly intentId: string; readonly intentIdentity: string;
  readonly preparationIdentity: string; readonly phase: ExecutionAttempt["phase"];
  readonly invocationRecorded: boolean; readonly uncertain: boolean; readonly reconciliationRequired: boolean;
}
export interface OfflineIntegrationResult {
  readonly kind: "offline_attestation_integration";
  readonly mode: "offline-only";
  readonly code: string;
  readonly stages: readonly IntegrationStage[];
  readonly verification: VerificationResult | null;
  readonly jobId: string | null;
  readonly intentId: string | null;
  readonly simulation: OfflineSimulationEvidence | null;
  readonly execution: IntegrationExecution | null;
  readonly observation: OfflineReconciliation | null;
  readonly bookkeepingError: string | null;
  readonly boundaries: readonly string[];
  readonly operationalAuthorization: false;
  readonly signingAuthorization: "not_granted";
  readonly submissionAuthorized: false;
  readonly retryAuthorized: false;
  readonly reservationReleaseAuthorized: false;
  readonly rpcAuthenticated: false;
  readonly onChainStateVerified: false;
  readonly settlementPermission: false;
  readonly reconciliationRequired: true;
}
