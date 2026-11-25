/** Internal authorized read model. No authentication provider or sensitive HTTP route is shipped. */
import { LifecycleStore, LifecycleError, DevnetLifecycleReader, type VerificationJob, type TransactionIntent,
  type ExecutionAttempt, type LifecycleView } from "@proofwork/lifecycle";
import { key } from "./commitments.js";
import { record, check, freeze } from "./read-only-observation-data.js";
import { APPLICATION_API_VERSION, applicationReply, applicationRequestId, type ApiReply, type ApiProvenance,
  type ApplicationResource, type ApplicationView, type VerificationJobView, type ExecutionStatusView, type MilestoneStateView } from "./application-api-contracts.js";
export interface ApplicationPrincipal { readonly subject: string; readonly role: "organization" | "student" | "operator" | "wallet"; readonly wallet: string | null }
/** Trusted per-request composition dependency. A production implementation/identity policy is NOT provided. */
export interface ApplicationAuthentication { resolve(): Promise<unknown> }
export interface ApplicationChainSource { readonly reader: DevnetLifecycleReader; readonly provenance: "offline_fixture" | "unverified_devnet_rpc" }
interface Bundle { job: VerificationJob; intent: TransactionIntent | undefined; attempt: ExecutionAttempt | undefined }
class QueryError extends Error { constructor(readonly code: string, readonly status: number) { super(code); } }
export class ApplicationQueries {
  readonly #resolve: (() => Promise<unknown>) | undefined;
  readonly #chain: ApplicationChainSource | undefined;
  readonly #timeout: number;
  constructor(private readonly store: LifecycleStore, options: { timeoutMs: number; authentication?: ApplicationAuthentication; chain?: ApplicationChainSource }) {
    check(store instanceof LifecycleStore);
    const o = record(options, ["timeoutMs", ...(Object.hasOwn(options, "authentication") ? ["authentication"] : []), ...(Object.hasOwn(options, "chain") ? ["chain"] : [])]);
    check(Number.isSafeInteger(o.timeoutMs) && o.timeoutMs > 0 && o.timeoutMs <= 10000); this.#timeout = o.timeoutMs;
    if (o.authentication !== undefined) { const a = record(o.authentication, ["resolve"]); check(typeof a.resolve === "function"); this.#resolve = a.resolve.bind(o.authentication); }
    if (o.chain !== undefined) { const c = record(o.chain, ["reader", "provenance"]);
      check(c.reader instanceof DevnetLifecycleReader && ["offline_fixture", "unverified_devnet_rpc"].includes(c.provenance));
      this.#chain = Object.freeze({ reader: c.reader, provenance: c.provenance }); }
  }
  private async bounded<T>(fn: () => Promise<T>, code: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([Promise.resolve().then(fn), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new QueryError(code, 503)), this.#timeout);
    })]); } finally { clearTimeout(timer); }
  }
  private async principal(): Promise<ApplicationPrincipal> {
    if (!this.#resolve) throw new QueryError("authentication_unavailable", 503);
    let raw: unknown;
    try { raw = await this.bounded(this.#resolve, "authentication_unavailable"); }
    catch { throw new QueryError("authentication_unavailable", 503); }
    if (raw === null) throw new QueryError("authentication_required", 401);
    try { const p = record(raw, ["subject", "role", "wallet"]);
      check(typeof p.subject === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(p.subject)
        && ["organization", "student", "operator", "wallet"].includes(p.role));
      if (p.role === "operator") check(p.wallet === null);
      else check(key(p.wallet).toBytes().some(n => n !== 0));
      return freeze(structuredClone(p) as unknown as ApplicationPrincipal);
    } catch { throw new QueryError("authentication_required", 401); }
  }
  private allowed(p: ApplicationPrincipal, j: VerificationJob): boolean {
    if (p.role === "wallet") return p.wallet === j.bindings.sponsor || p.wallet === j.bindings.student;
    return p.role === "operator" || p.wallet === (p.role === "organization" ? j.bindings.sponsor : j.bindings.student);
  }
  private bundle(id: string, p: ApplicationPrincipal): Bundle {
    const job = this.store.jobs.getJob(id);
    // Unknown and other users' resources share a response; do not expose an existence oracle.
    if (!job || !this.allowed(p, job)) throw new QueryError("resource_not_found", 404);
    const intent = this.store.transactionIntents.getForJob(id);
    const attempt = intent ? this.store.executionAttempts.getForIntent(intent.intentId) : undefined;
    check(!intent || (intent.jobId === id && intent.jobIdentity === job.identity));
    check(!attempt || (attempt.intent.intentId === intent!.intentId && attempt.intent.identity === intent!.identity));
    return { job, intent, attempt };
  }
  private stamp(b: Bundle): string {
    return JSON.stringify([b.job.jobId, b.job.identity, b.job.revision, b.job.generation, b.job.workerId,
      b.intent?.intentId, b.intent?.identity, b.intent?.revision, b.intent?.reconciliationRequired,
      b.attempt?.attemptId, b.attempt?.identity, b.attempt?.revision, b.attempt?.reconciliationRequired]);
  }
  private reconciliation(b: Bundle): boolean {
    return b.job.state === "authorization_pending" || b.job.state === "recovery_required"
      || b.intent?.reconciliationRequired === true || b.attempt?.reconciliationRequired === true;
  }
  private jobView(b: Bundle): VerificationJobView {
    const controlled=b.job.creationId.startsWith("controlled_");
    const attempt=controlled?this.store.applicationTransactions.getForOperation("attest_milestone:"+b.job.bindings.milestone):undefined;
    const controlledRecovery=controlled?{generation:b.job.generation,attemptId:attempt?.id??null,attemptState:attempt?.state??null}:undefined;
    return freeze({ ...(controlledRecovery?{controlledRecovery}:{}), kind: "verification_job", jobId: b.job.jobId, identity: b.job.identity, milestone: b.job.bindings.milestone,
      state: b.job.state, verificationOutcome: b.job.verificationOutcome, reconciliationRequired: this.reconciliation(b),
      errorClassification: b.job.verificationOutcome === "rejected" ? "verification_rejected" : b.job.state === "recovery_required" ? "reconciliation_required" : null,
      fullVerificationResult: "not_persisted", timestamps: { createdAt: null, startedAt: null, finishedAt: null } });
  }
  private executionView(b: Bundle): ExecutionStatusView {
    return freeze({ kind: "execution_status", jobId: b.job.jobId, milestone: b.job.bindings.milestone,
      intentId: b.intent?.intentId ?? null, intentState: b.intent?.state ?? null,
      preparation: b.intent?.preparation ? "recorded" : "unavailable", attemptId: b.attempt?.attemptId ?? null,
      mode: "offline-test-model", phase: b.attempt?.phase ?? null, uncertain: b.attempt?.uncertain ?? true,
      reconciliationRequired: this.reconciliation(b), offlineObservation: b.attempt && b.attempt.finality > 0 ? "test_evidence_only" : "unavailable",
      operationalExecution: "unavailable", liveTransactionId: null, rewardPayment: "not_established" });
  }
  private milestoneView(b: Bundle, v: LifecycleView): MilestoneStateView {
    const m = v.milestone, bindings = b.job.bindings;
    if (m.address !== bindings.milestone || m.internship !== bindings.internship || m.sponsor !== bindings.sponsor
      || m.student !== bindings.student || m.verifier !== bindings.verifier || m.requirementsHash !== bindings.requirementsHash
      || !v.submission || v.submission.address !== bindings.submission || v.submission.evidenceHash !== bindings.evidenceHash)
      throw new QueryError("chain_state_mismatch", 503);
    return freeze({ kind: "milestone_state", address: m.address, internship: m.internship, sponsor: m.sponsor, student: m.student,
      verifier: m.verifier, rewardMint: m.rewardMint, status: m.status, rewardAmountRaw: m.rewardAmount.toString(), milestoneId: m.milestoneId.toString(),
      assignBy: m.assignBy.toString(), submitBy: m.submitBy.toString(), submittedAt: v.submission.submittedAt.toString(),
      verifiedAt: m.verifiedAt === 0n ? null : m.verifiedAt.toString(), settledAt: v.completion?.settledAt.toString() ?? null,
      slot: v.slot, commitment: v.commitment, programDeployment: "not_verified", rewardPayment: "not_established" });
  }
  async read(input: unknown): Promise<ApiReply> {
    const requestId = applicationRequestId(); let resource: ApplicationResource | "unknown" = "unknown", id: string | null = null;
    let provenance: ApiProvenance = "none";
    try {
      try { const r = record(input, ["apiVersion", "cluster", "resource", "jobId"]);
        check(r.apiVersion === APPLICATION_API_VERSION && r.cluster === "devnet" && ["job", "milestone", "execution"].includes(r.resource)
          && typeof r.jobId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.jobId));
        resource = r.resource; id = r.jobId;
      } catch { throw new QueryError("invalid_request", 400); }
      const p = await this.principal(), before = this.bundle(id!, p);
      let data: ApplicationView;
      if (resource === "milestone") {
        if (!this.#chain) throw new QueryError("chain_reader_unavailable", 503);
        provenance = this.#chain.provenance;
        const b = before.job.bindings;
        const v = await this.bounded(() => this.#chain!.reader.readMilestone(b.sponsor, BigInt(b.internshipId), BigInt(b.milestoneId)), "chain_timeout");
        data = this.milestoneView(before, v);
      } else { provenance = "lifecycle_v5_offline"; data = resource === "job" ? this.jobView(before) : this.executionView(before); }
      const current = await this.principal();
      if (p.subject !== current.subject || p.role !== current.role || p.wallet !== current.wallet) throw new QueryError("authentication_changed", 401);
      if (this.stamp(before) !== this.stamp(this.bundle(id!, current))) throw new QueryError("resource_changed", 503);
      return applicationReply(requestId, resource, id, 200, data, provenance);
    } catch (e) {
      let code = "dependency_unavailable", status = 503;
      if (e instanceof QueryError) { code = e.code; status = e.status; }
      else if (e instanceof LifecycleError) code = e.code === "corrupt_store" ? "storage_integrity_failure"
        : e.code === "missing_account" ? "chain_state_unavailable" : e.code === "invalid_account" ? "chain_state_invalid"
        : e.code === "wrong_cluster" ? "chain_context_invalid" : e.code === "rpc_failure" ? "chain_unavailable" : "storage_unavailable";
      return applicationReply(requestId, resource, id, status, null, provenance, code);
    }
  }
}
