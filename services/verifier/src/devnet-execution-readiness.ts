/** Internal read-only acceptance checks. Passing data comparisons never enables an effect. */
import { LifecycleStore, LifecycleError } from "@proofwork/lifecycle";
import { validateAdmission, validateSigningOutcome, validateSubmission, validateSubmissionOutcome,
  protocolDataDigest, ProtocolDataError, type SigningOutcome, type SubmissionOutcome } from "./operational-protocol.js";
import { validateOfflineReadPlan, correlateExecution, reconcileOfflineReadEvidence } from "./read-only-evidence.js";
import { record, list, check, freeze, OfflineReadError } from "./read-only-observation-data.js";
import type { ReconciliationClassification } from "./read-only-observation-types.js";

const blockers = Object.freeze([
  "fresh_authorization_not_carried_by_data", "authenticated_custody_unavailable", "authenticated_operator_policy_unavailable",
  "authenticated_payer_consent_unavailable", "external_fencing_unavailable", "operational_journal_requires_approval",
  "first_submission_reservation_unavailable", "authenticated_rpc_provenance_unavailable", "verified_deployment_unavailable",
  "demo_setup_not_authorized", "reconciliation_policy_unapproved", "emergency_shutdown_unavailable", "activation_approval_absent",
]);
export interface DevnetReadinessResult {
  readonly kind: "devnet_execution_readiness";
  readonly readiness: "NOT_READY";
  readonly code: string;
  readonly operationalAuthorization: false;
  readonly signingAuthorization: "not_granted";
  readonly submissionAuthorized: false;
  readonly retryAuthorized: false;
  readonly reservationReleaseAuthorized: false;
  readonly rpcAuthenticated: false;
  readonly onChainStateVerified: false;
  readonly operationalStateMutationAuthorized: false;
  readonly reconciliationRequired: true;
  readonly blockers: readonly string[];
  readonly operationKey: string | null;
  readonly attemptId: string | null;
  readonly comparisons: Readonly<{
    localHistoryCorrelated: boolean;
    currentWorkerFenceMatches: boolean;
    freshAdmissionDataConsistent: boolean;
    roleStates: readonly SigningOutcome["state"][];
    completeWireRoleCorrelation: boolean;
    reportedSubmissionState: SubmissionOutcome["state"] | null;
    observationClassification: ReconciliationClassification | null;
  }>;
}
/**
 * Reads the supplied trusted local store only. No signer, transport, credential,
 * callback, activation flag or persistence writer is accepted. The existing
 * protocol snapshot is caller comparison data, NOT a current clock/epoch oracle.
 * Full signed wire is accepted internally for existing validators, never returned.
 */
export function reviewDevnetExecutionReadiness(store: LifecycleStore, input: unknown): DevnetReadinessResult {
  let operationKey: string | null = null, attemptId: string | null = null;
  const comparisons: { -readonly [K in keyof DevnetReadinessResult["comparisons"]]: DevnetReadinessResult["comparisons"][K] } = {
    localHistoryCorrelated: false, currentWorkerFenceMatches: false, freshAdmissionDataConsistent: false,
    roleStates: [], completeWireRoleCorrelation: false, reportedSubmissionState: null, observationClassification: null,
  };
  const result = (code: string): DevnetReadinessResult => freeze({
    kind: "devnet_execution_readiness", readiness: "NOT_READY", code, operationKey, attemptId, comparisons, blockers,
    operationalAuthorization: false, signingAuthorization: "not_granted", submissionAuthorized: false, retryAuthorized: false,
    reservationReleaseAuthorized: false, rpcAuthenticated: false, onChainStateVerified: false,
    operationalStateMutationAuthorized: false, reconciliationRequired: true,
  });
  let request: Record<string, any>;
  try {
    request = record(input, ["mode", "plan", "roleRequests", "signingOutcomes", "submissionOutcome", "bundles"]);
    check(request.mode === "offline-review" && store instanceof LifecycleStore);
  } catch { return result("invalid_readiness_request"); }
  try {
    const plan = validateOfflineReadPlan(request.plan);
    const before = store.executionAttempts.get(plan.attempt.attemptId);
    if (!before) return result("missing_execution_history");
    correlateExecution(plan, before);
    check(before.revision === plan.attempt.revision, "stale_execution_revision");
    const job = store.jobs.getJob(before.intent.jobId);
    check(job && job.identity === before.intent.jobIdentity && job.operationKey === before.intent.operationKey
      && protocolDataDigest(job.bindings) === protocolDataDigest(before.intent.bindings), "job_identity_mismatch");
    operationKey = before.intent.operationKey; attemptId = before.attemptId;
    comparisons.localHistoryCorrelated = true;
    const fenceMatches = () => {
      const current = store.jobs.getJob(job.jobId);
      return !!current && current.identity === job.identity && current.revision === before.intent.jobRevision
        && current.workerId === before.intent.workerId && current.generation === before.intent.generation
        && current.state === "authorization_pending";
    };
    comparisons.currentWorkerFenceMatches = fenceMatches();
    // Reuse historical role validation so uncertainty remains inspectable after expiry.
    const roles = list(request.roleRequests, 2), outcomes = list(request.signingOutcomes, 2);
    check(roles.length === 2 && outcomes.length === 2, "incomplete_role_evidence");
    const states = outcomes.map((value, n) => validateSigningOutcome(value, roles[n], plan.admission, plan.anchor, plan.snapshot).data);
    check(states[0]!.role === "verifier" && states[1]!.role === "fee_payer"
      && states[0]!.requestId !== states[1]!.requestId, "incorrect_role_binding");
    comparisons.roleStates = states.map(s => s.state);
    try {
      validateAdmission(plan.admission, plan.anchor, plan.snapshot);
      comparisons.freshAdmissionDataConsistent = true;
    } catch (error) {
      if (!(error instanceof ProtocolDataError)) throw error;
      // No clock rewind, renewed deadline or epoch substitution to make history executable.
    }
    if (comparisons.freshAdmissionDataConsistent && states.every(s => s.state === "signature_observed")) {
      validateSubmission(plan.submission, plan.admission, roles, outcomes, plan.anchor, plan.snapshot);
      comparisons.completeWireRoleCorrelation = true;
    }
    if (request.submissionOutcome !== null) comparisons.reportedSubmissionState = validateSubmissionOutcome(
      request.submissionOutcome, plan.submission, plan.admission, plan.anchor, plan.snapshot).data.state;
    const observation = reconcileOfflineReadEvidence(plan, request.bundles, before, store.executionAttempts.get(before.attemptId));
    comparisons.observationClassification = observation.classification;
    comparisons.currentWorkerFenceMatches = comparisons.currentWorkerFenceMatches && fenceMatches();
    const code = !comparisons.currentWorkerFenceMatches ? "stale_worker"
      : !comparisons.freshAdmissionDataConsistent ? "fresh_comparison_failed"
      : !comparisons.completeWireRoleCorrelation ? "incomplete_signing_evidence" : "operational_controls_unavailable";
    return result(code);
  } catch (error) {
    return result(error instanceof LifecycleError ? "invalid_local_history"
      : error instanceof OfflineReadError ? (["execution_identity_mismatch", "job_identity_mismatch", "incomplete_role_evidence",
        "incorrect_role_binding", "stale_execution_revision"].includes(error.code) ? error.code : "invalid_readiness_data")
      : error instanceof ProtocolDataError ? "invalid_protocol_data" : "readiness_dependency_failure");
  }
}
