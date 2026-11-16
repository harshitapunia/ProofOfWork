import { LifecycleStore, LifecycleError, type ExecutionAttempt, type JobClaim, type VerificationJob } from "@proofwork/lifecycle";
import { DurableOfflineCoordinator, OfflineAuthorizationError, type OfflineCoordinationAuditEvent } from "./durable-offline-coordinator.js";
import { VerifierService, parseRequest, type VerificationResult } from "./service.js";
import { AttestationError } from "./attestation.js";
import { TransactionPolicyError, type TrustedBlockhashSource } from "./transaction-policy.js";
import type { AttestationStateReader } from "./attestation-chain.js";
import { OfflineDualSignatureSimulation, OfflineSimulationError, type OfflineSimulationEvidence } from "./offline-signature-simulation.js";
import { OfflineReadOnlyObservationAdapter, validateOfflineReadPlan, OfflineReadError } from "./read-only-observation.js";
import { record, check, freeze } from "./read-only-observation-data.js";
import type { OfflineIntegrationConfig, OfflineIntegrationObservation, OfflineIntegrationResult, IntegrationStage, IntegrationExecution } from "./secure-attestation-types.js";
export * from "./secure-attestation-types.js";

const evidenceFields = ["manifestBase64", "milestone", "student", "repositoryId", "contributorId", "commit", "nonce", "owner", "repository", "pullRequest"];
const boundaries = Object.freeze(["operational_effects_disabled", "simulation_does_not_export_signed_wire",
  "fixture_observation_cannot_mutate_execution_ledger", "full_verification_result_is_not_durable"]);
type Context = { job: VerificationJob; claim: JobClaim };
interface Progress {
  stages: IntegrationStage[]; verification: VerificationResult | null; context: Context | null; jobId: string | null;
  intentId: string | null; simulation: OfflineSimulationEvidence | null; attempt: ExecutionAttempt | null;
}
function progress(): Progress { return { stages: [], verification: null, context: null, jobId: null, intentId: null, simulation: null, attempt: null }; }
function stage(p: Progress, value: IntegrationStage): void { if (!p.stages.includes(value)) p.stages.push(value); }
function execution(a: ExecutionAttempt): IntegrationExecution {
  return { attemptId: a.attemptId, identity: a.identity, revision: a.revision, jobId: a.intent.jobId, jobIdentity: a.intent.jobIdentity,
    intentId: a.intent.intentId, intentIdentity: a.intent.identity, preparationIdentity: a.intent.preparation!.identity,
    phase: a.phase, invocationRecorded: a.invocationRecorded, uncertain: a.uncertain, reconciliationRequired: a.reconciliationRequired };
}
/** Return only the existing service response fields, never arbitrary dependency properties or request preimages. */
function verificationSummary(v: VerificationResult): VerificationResult {
  return structuredClone({ status: v.status, approved: v.approved, outcomes: v.outcomes.map(o => ({ id: o.id, passed: o.passed })),
    startedAt: v.startedAt, finishedAt: v.finishedAt,
    ...(v.reason === undefined ? {} : { reason: v.reason }),
    ...Object.fromEntries((["milestone", "student", "repositoryId", "contributorId", "commit", "requirementsHash", "evidenceHash"] as const)
      .filter(k => v[k] !== undefined).map(k => [k, v[k]])) });
}
function errorCode(error: unknown, p: Progress): string {
  if (error instanceof LifecycleError) {
    if (["corrupt_store", "foreign_store", "unsupported_schema"].includes(error.code)) return "inconsistent_history";
    if (["stale_claim", "conflict", "job_conflict"].includes(error.code)) return "stale_worker";
    if (["invalid_transition", "intent_conflict", "execution_conflict"].includes(error.code)) return "duplicate_operation";
    if (error.code === "not_found") return "missing_job";
    return "bookkeeping_unavailable";
  }
  if (error instanceof OfflineSimulationError) return error.code === "simulation_timeout" ? "signing_timeout"
    : error.code === "duplicate_simulation" ? "duplicate_operation" : "signing_uncertain";
  if (error instanceof AttestationError) return error.code === "verification_failed" ? "verification_failed"
    : error.code.includes("expired") ? "expired_authorization" : "authorization_rejected";
  if (error instanceof TransactionPolicyError) return error.code.includes("stale") || error.code.includes("expired")
    ? "expired_authorization" : "invalid_message";
  if (error instanceof OfflineAuthorizationError) return error.code === "stale_worker" ? "stale_worker"
    : error.code === "simulation_intent_already_exists" ? "existing_permanent_intent"
    : error.code === "existing_execution_attempt" ? "existing_execution_attempt" : "preparation_uncertain";
  if (error instanceof OfflineReadError) return error.code === "stale_execution_revision" ? "stale_worker" : "evidence_incomplete";
  return p.stages.includes("authorization_consumed") ? "preparation_uncertain" : "internal_dependency_failure";
}

/**
 * Thin server-internal OFFLINE composition; no HTTP import, network default, signer or sender.
 * Supplied service/read/provider callbacks are trusted composition code, not sandboxed request dependencies.
 */
export class SecureOfflineAttestationIntegration {
  readonly #config: OfflineIntegrationConfig;
  readonly #observer: OfflineReadOnlyObservationAdapter | undefined;
  readonly #planFor: OfflineIntegrationObservation["planFor"] | undefined;
  constructor(private readonly store: LifecycleStore, private readonly service: VerifierService,
    private readonly chain: AttestationStateReader, private readonly blockhashes: TrustedBlockhashSource,
    config: OfflineIntegrationConfig, private readonly simulation: OfflineDualSignatureSimulation,
    private readonly now: () => number, observation?: OfflineIntegrationObservation) {
    const c = record(config, ["mode", "workerId", "policy", "observationAuthority"]);
    check(c.mode === "offline-only" && typeof c.workerId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(c.workerId)
      && typeof c.observationAuthority === "string" && service instanceof VerifierService && simulation instanceof OfflineDualSignatureSimulation);
    const policy = record(c.policy, ["verifier", "feePayer", "maxAgeMs", "minRemainingBlockHeights"]);
    this.#config = freeze(structuredClone({ ...c, policy }) as OfflineIntegrationConfig);
    // Reuse the existing coordinator's config/identity validation without creating a job.
    new DurableOfflineCoordinator(store, service, chain, this.#config.policy, c.workerId, blockhashes, now,
      { mode: "offline-mock" }, simulation);
    if (observation !== undefined) {
      const o = record(observation, ["sources", "readTimeoutMs", "planFor"]);
      check(typeof o.planFor === "function");
      this.#planFor = o.planFor.bind(observation);
      this.#observer = new OfflineReadOnlyObservationAdapter(o.sources, { get: id => store.executionAttempts.get(id) }, { readTimeoutMs: o.readTimeoutMs });
    }
  }
  private current(c: Context): void {
    const j = this.store.jobs.getJob(c.job.jobId);
    if (!(j && j.identity === c.claim.identity && j.revision === c.job.revision && j.generation === c.claim.generation
      && j.workerId === c.claim.workerId && j.state === "authorization_pending")) throw new OfflineAuthorizationError("stale_worker");
  }
  private snapshot(p: Progress): ExecutionAttempt | null {
    if (!p.attempt) return null;
    const a = this.store.executionAttempts.get(p.attempt.attemptId);
    if (!a || a.identity !== p.attempt.identity) throw new LifecycleError("corrupt_store");
    return a;
  }
  private hold(p: Progress): string | null {
    if (!p.attempt || !p.context) return null;
    try {
      this.current(p.context);
      const a = this.snapshot(p)!;
      // A hold is bookkeeping, not a claim that submission occurred. No invocation is recorded.
      if (a.phase === "execution_record_created") p.attempt = this.store.executionAttempts.markUncertain(p.context.claim,
        p.context.job.revision, { attemptId: a.attemptId, identity: a.identity, revision: a.revision }, "integration_uncertainty");
      return null;
    } catch (e) { return errorCode(e, p); } // Revocation/corruption must never be bypassed by a recovery-control write.
  }
  private result(p: Progress, code: string, observation: OfflineIntegrationResult["observation"] = null,
    bookkeepingError: string | null = null): OfflineIntegrationResult {
    let a: ExecutionAttempt | null = null;
    try { a = this.snapshot(p); } catch (e) { code = "inconsistent_history"; bookkeepingError = errorCode(e, p); }
    return freeze({ kind: "offline_attestation_integration", mode: "offline-only", code, stages: [...p.stages],
      verification: p.verification, jobId: p.jobId ?? a?.intent.jobId ?? null, intentId: p.intentId, simulation: p.simulation,
      execution: a ? execution(a) : null, observation, bookkeepingError, boundaries,
      operationalAuthorization: false, signingAuthorization: "not_granted", submissionAuthorized: false, retryAuthorized: false,
      reservationReleaseAuthorized: false, rpcAuthenticated: false, onChainStateVerified: false, settlementPermission: false,
      reconciliationRequired: true });
  }
  private async observe(p: Progress): Promise<OfflineIntegrationResult> {
    if (!this.#observer || !this.#planFor) return this.result(p, "observation_pending");
    let observation: OfflineIntegrationResult["observation"] = null;
    try {
      const a = this.snapshot(p)!;
      const plan = validateOfflineReadPlan(this.#planFor(a));
      check(plan.attempt.attemptId === a.attemptId && plan.attempt.identity === a.identity && plan.attempt.revision === a.revision,
        "observation_attempt_mismatch");
      observation = await this.#observer.observe(plan);
      stage(p, "observation_classified");
      // This is a read check, not external fencing. Inspection after restart/revocation stays read-only.
      if (p.context) this.current(p.context);
      return this.result(p, observation.classification, observation);
    } catch (e) { return this.result(p, errorCode(e, p), observation); }
  }
  async investigate(input: unknown, githubToken: string): Promise<OfflineIntegrationResult> {
    const p = progress();
    let requestId: string, evidence: unknown;
    try {
      const r = record(input, ["mode", "requestId", "evidence"]);
      check(r.mode === "offline-only" && typeof r.requestId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(r.requestId));
      requestId = r.requestId;
      evidence = parseRequest(record(r.evidence, evidenceFields));
      check(typeof githubToken === "string" && githubToken.length > 0 && githubToken.length <= 1024 && !/[\r\n]/.test(githubToken));
    } catch { return this.result(p, "invalid_request"); }
    const audit = (e: OfflineCoordinationAuditEvent): void => {
      if (e.kind === "job_resolved") {
        p.jobId = e.job.jobId; stage(p, "job_identity_resolved");
      } else if (e.kind === "verification_result") {
        p.verification = verificationSummary(e.result); stage(p, "verification_completed");
      } else if (e.kind === "policy_consumed") {
        p.context = { job: e.job, claim: e.claim }; this.current(p.context); stage(p, "authorization_consumed");
      } else if (e.kind === "preparation_recorded") {
        p.context = { job: e.job, claim: e.claim }; this.current(p.context); p.intentId = e.intent.intentId;
        stage(p, "preparation_recorded");
        const created = this.store.executionAttempts.create(e.claim, e.job.revision, requestId, e.intent.intentId,
          e.intent.identity, this.#config.observationAuthority);
        if (!created.created) throw new OfflineAuthorizationError("existing_execution_attempt");
        p.attempt = created.attempt; stage(p, "execution_bookkeeping_recorded");
      } else {
        p.simulation = structuredClone(e.evidence); stage(p, "offline_signature_evidence_observed");
      }
    };
    const coordinator = new DurableOfflineCoordinator(this.store, this.service, this.chain, this.#config.policy,
      this.#config.workerId, this.blockhashes, this.now, { mode: "offline-mock" }, this.simulation, audit);
    try {
      await coordinator.coordinate(requestId, evidence, githubToken);
      check(p.context && p.attempt && p.simulation, "incomplete_integration");
      this.current(p.context);
      const holdError = this.hold(p);
      if (holdError) return this.result(p, holdError, null, holdError);
      return await this.observe(p);
    } catch (e) {
      const code = errorCode(e, p), holdError = this.hold(p);
      return this.result(p, code, null, holdError);
    }
  }
  /** Read-only historical inspection. Never repeats verification, consumes policy or calls signature providers. */
  async inspect(input: unknown): Promise<OfflineIntegrationResult> {
    const p = progress();
    let r: Record<string, any>;
    try {
      r = record(input, ["mode", "attemptId", "identity", "revision"]);
      check(r.mode === "offline-only" && typeof r.attemptId === "string" && typeof r.identity === "string"
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.attemptId)
        && /^[0-9a-f]{64}$/.test(r.identity) && Number.isSafeInteger(r.revision) && r.revision >= 0 && r.revision <= 32);
    } catch { return this.result(p, "invalid_request"); }
    try {
      const a = this.store.executionAttempts.get(r.attemptId);
      if (!a) return this.result(p, "missing_job");
      if (a.identity !== r.identity || a.revision !== r.revision) return this.result(p, "stale_worker");
      p.attempt = a; p.intentId = a.intent.intentId;
      // Historical metadata is not added to completedStages or promoted to fresh simulation/verification evidence.
      return await this.observe(p);
    } catch (e) { return this.result(p, errorCode(e, p)); }
  }
}
