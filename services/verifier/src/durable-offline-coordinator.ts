import { createHash } from "node:crypto";
import { LifecycleStore, type JobBindings, type JobClaim, type VerificationJob } from "@proofwork/lifecycle";
import { PROGRAM_ID, SETTLEMENT_DEVNET_GENESIS } from "@proofwork/finance-client";
import { AttestationError, buildAttestMilestoneInstruction } from "./attestation.js";
import type { AttestationStateReader } from "./attestation-chain.js";
import { evidenceHash } from "./commitments.js";
import { parseManifest } from "./manifest.js";
import { parseRequest, type VerifierService } from "./service.js";
import { AttestationTransactionCoordinator, type CoordinationGuard } from "./transaction-coordinator.js";
import type { TransactionPolicyConfig, TrustedBlockhashSource } from "./transaction-policy.js";

export class OfflineAuthorizationError extends Error {
  constructor(public readonly code: string) { super(code); }
}
function check(ok: unknown, code: string): asserts ok { if (!ok) throw new OfflineAuthorizationError(code); }
export interface OfflineMockOptions {
  readonly mode: "offline-mock";
  readonly outcome?: "record" | "reject" | "failure";
  readonly timeoutMs?: number;
  /** Test scheduling only. Receives no message, job, ticket, approval or signing capability. */
  readonly gate?: Readonly<{ wait(): Promise<void> }>;
}
export interface OfflineMockReceipt {
  readonly mode: "offline-mock";
  readonly receiptId: string;
  readonly jobId: string;
  readonly messageDigest: string;
  readonly signingAuthorization: "not_granted";
}
/**
 * Trusted server-internal composition only; not imported by HTTP routes.
 * Request input is evidence, never a job, transaction or verification result.
 * The sole durable mock effect is a fenced local SQLite receipt, not an external signer.
 */
export class DurableOfflineCoordinator {
  readonly #config: Readonly<TransactionPolicyConfig>;
  readonly #options: Readonly<OfflineMockOptions>;
  readonly #messages = new WeakMap<object, Buffer>();
  constructor(private readonly store: LifecycleStore, private readonly service: Pick<VerifierService, "verify">,
    private readonly chain: AttestationStateReader, config: TransactionPolicyConfig,
    private readonly workerId: string, private readonly blockhashes: TrustedBlockhashSource,
    private readonly now: () => number = () => performance.now(), options: OfflineMockOptions = { mode: "offline-mock" }) {
    check(/^[A-Za-z0-9_-]{1,80}$/.test(workerId), "invalid_worker");
    check(Object.keys(options).every(k => ["mode", "outcome", "timeoutMs", "gate"].includes(k))
      && options.mode === "offline-mock" && ["record", "reject", "failure"].includes(options.outcome ?? "record")
      && Number.isSafeInteger(options.timeoutMs ?? 1000) && (options.timeoutMs ?? 1000) > 0
      && (options.timeoutMs ?? 1000) <= 1000, "invalid_mock_configuration");
    check(options.gate === undefined || (Object.keys(options.gate).length === 1 && typeof options.gate.wait === "function"),
      "invalid_mock_configuration");
    this.#config = Object.freeze({ ...config });
    // Capture the test scheduler, so configuration mutation cannot swap the boundary.
    this.#options = Object.freeze({ mode: "offline-mock", outcome: options.outcome, timeoutMs: options.timeoutMs,
      gate: options.gate ? Object.freeze({ wait: options.gate.wait.bind(options.gate) }) : undefined });
  }
  /** Only original process-local receipts can retrieve defensive copies. Stored metadata is not authorization. */
  readMockMessage(receipt: OfflineMockReceipt): Buffer {
    const message = this.#messages.get(receipt);
    check(message, "invalid_mock_receipt"); return Buffer.from(message);
  }
  async coordinate(creationId: string, input: unknown, githubToken: string): Promise<OfflineMockReceipt> {
    const request = parseRequest(structuredClone(input));
    const bytes = Buffer.from(request.manifestBase64, "base64");
    check(bytes.toString("base64") === request.manifestBase64, "invalid_manifest");
    const manifest = parseManifest(bytes);
    const initial = structuredClone(await this.chain.read(request.milestone));
    buildAttestMilestoneInstruction(initial, this.#config.verifier);
    check(initial.milestone === request.milestone && initial.student === request.student
      && initial.requirementsHash === manifest.hash.toString("hex") && manifest.manifest.repositoryId === request.repositoryId
      && initial.evidenceHash === evidenceHash({ ...request, requirementsHash: initial.requirementsHash }).toString("hex"),
      "request_binding_mismatch");
    const bindings: JobBindings = { cluster: "devnet", genesisHash: SETTLEMENT_DEVNET_GENESIS, programId: PROGRAM_ID,
      sponsor: initial.sponsor, internshipId: initial.internshipId, internship: initial.internship,
      milestoneId: initial.milestoneId, milestone: initial.milestone, submission: initial.submission,
      student: initial.student, verifier: initial.verifier, requirementsHash: initial.requirementsHash,
      evidenceHash: initial.evidenceHash, repositoryId: request.repositoryId, contributorId: request.contributorId,
      commit: request.commit, verificationSpecHash: initial.requirementsHash };
    let job: VerificationJob = this.store.jobs.createOrGetJob(creationId, bindings);
    const claimed = this.store.jobs.claimJob(job.jobId, job.identity, job.revision, this.workerId);
    job = claimed.job;
    const claim: JobClaim = claimed.claim;
    const current = () => {
      const value = this.store.jobs.getJob(job.jobId);
      check(value && value.identity === claim.identity && value.revision === job.revision
        && value.generation === claim.generation && value.workerId === claim.workerId
        && value.state === job.state, "stale_worker");
    };
    const step = (to: "verification_running" | "verification_completed" | "authorization_pending") => {
      current(); job = this.store.jobs.transitionJob(claim, job.revision, to);
    };
    const guard: CoordinationGuard = { assertCurrent: current, verified: () => {
      step("verification_completed"); step("authorization_pending");
    } };
    const chain: AttestationStateReader = { read: async milestone => {
      current();
      const value = structuredClone(await this.chain.read(milestone));
      current();
      check(Object.keys(initial).length === Object.keys(value).length
        && (Object.keys(initial) as (keyof typeof initial)[]).every(k => initial[k] === value[k]), "changed_chain_state");
      return value;
    } };
    const service: Pick<VerifierService, "verify"> = { verify: async (value, token) => {
      current(); const result = await this.service.verify(value, token, current); current(); return result;
    } };
    const blockhashes: TrustedBlockhashSource = { read: async () => {
      current(); const result = await this.blockhashes.read(); current(); return result;
    } };
    let receipt: OfflineMockReceipt | undefined;
    const boundary = { mode: "offline-mock" as const, publicKey: this.#config.verifier,
      acceptAuthorizedMessage: async (message: Uint8Array) => {
        current();
        const copy = Buffer.from(message), messageDigest = createHash("sha256").update(copy).digest("hex");
        this.store.offlineHandoffs.begin(claim, job.revision, messageDigest);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          if (this.#options.gate) await Promise.race([
            this.#options.gate.wait(),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new OfflineAuthorizationError("mock_timeout")),
              this.#options.timeoutMs ?? 1000); }),
          ]);
          current();
          if (this.#options.outcome === "reject") throw new OfflineAuthorizationError("mock_rejected");
          if (this.#options.outcome === "failure") throw new OfflineAuthorizationError("mock_failure");
          // Sole mock side effect: fencing and receipt insertion share BEGIN IMMEDIATE.
          // No DB lock is held across the scheduling gate; no external signer is called.
          this.store.offlineHandoffs.finish(claim, job.revision, messageDigest, "recorded", "acknowledged");
          receipt = Object.freeze({ mode: "offline-mock", receiptId: "offline-mock:" + job.jobId, jobId: job.jobId,
            messageDigest, signingAuthorization: "not_granted" });
          this.#messages.set(receipt, copy);
        } catch (error) {
          // A revoked worker cannot write even a failure outcome. Its durable pending intent remains uncertain.
          current();
          const reason = error instanceof OfflineAuthorizationError && error.code === "mock_rejected" ? "mock_rejected"
            : error instanceof OfflineAuthorizationError && error.code === "mock_timeout" ? "mock_timeout" : "mock_failure";
          this.store.offlineHandoffs.finish(claim, job.revision, messageDigest,
            reason === "mock_rejected" ? "rejected" : "uncertain", reason);
          throw error;
        } finally { if (timer !== undefined) clearTimeout(timer); }
      } };
    try {
      step("verification_running");
      const coordinator = new AttestationTransactionCoordinator(service, chain, this.#config, boundary, blockhashes, this.now, guard);
      await coordinator.coordinate(request, githubToken);
      check(receipt, "missing_mock_receipt"); return receipt;
    } catch (error) {
      const actual = this.store.jobs.getJob(job.jobId);
      if (actual?.identity === claim.identity && actual.revision === job.revision
        && actual.generation === claim.generation && actual.workerId === claim.workerId) {
        // Never overwrite a committed mock receipt or a newer worker's history.
        const handoff = this.store.offlineHandoffs.get(job.jobId);
        if (!handoff && job.state === "verification_running" && error instanceof AttestationError
          && error.code === "verification_failed" && error.verificationReason !== undefined
          && ["invalid_request", "invalid_manifest", "requirements_mismatch", "evidence_mismatch",
            "repository_mismatch", "commit_mismatch", "provenance_mismatch", "tests_failed"].includes(error.verificationReason))
          this.store.jobs.transitionJob(claim, job.revision, "verification_rejected");
        else if (!handoff || handoff.outcome === "intent")
          this.store.jobRecovery.interruptJob(job.jobId, job.identity, job.revision, this.workerId);
      }
      throw error;
    }
  }
}
