import {AttestationError} from "./attestation.js";
/** Thin production handoff: the existing verifier, authorizer and exact-message policy remain authoritative.
 * The two human signers use separate authenticated Phantom sessions. No server key custody.
 */
import { randomUUID } from "node:crypto";
import { Transaction, PublicKey, Message } from "@solana/web3.js";
import {
  LifecycleStore,
  type VerificationJob,
  type JobClaim,
} from "@proofwork/lifecycle";
import {
  PROGRAM_ID,
  SETTLEMENT_DEVNET_GENESIS,
} from "@proofwork/finance-client";
import {
  ControlledActions,
  scopeDigest,
  type ApprovedScope,
  type ApprovalSnapshot,
} from "./controlled-actions.js";
import {
  ReadOnlyWalletRpc,
  observeDeployment,
  reviewedArtifact,
  validTransactionError,
  requireExpiredLease,
  type ApprovedArtifact,
} from "./devnet-wallet-review.js";
import { AttestationTransactionCoordinator } from "./transaction-coordinator.js";
import {
  takePolicyMessage,
  type OfflinePolicyMessage,
  type TrustedBlockhashSource,
} from "./transaction-policy.js";
import { DevnetBlockhashSource } from "./devnet-blockhash.js";
import type {
  AttestationStateReader,
  AttestationState,
} from "./attestation-chain.js";
import { WorkflowStateReader } from "./workflow-state.js";
import {
  admitContributorWithDeadline, type ContributorAdmission,
  type WorkflowVerificationJob,
} from "./workflow-verification.js";
import type { VerifierService } from "./service.js";
import { WalletAuthError } from "./wallet-sessions.js";
import { transactionId as base58 } from "./devnet-execution.js";
function check(v: unknown, code = "attestation_unavailable"): asserts v {
  if (!v) throw new WalletAuthError(code, 403);
}
export const attestationScope = (s: AttestationState, payer: string) =>
  scopeDigest({ operation: "attest_milestone", state: s, feePayer: payer });
interface Candidate {
  id: string;
  job: VerificationJob;
  claim: JobClaim;
  policy: OfflinePolicyMessage;
  scope: ApprovedScope;
  approval: ApprovalSnapshot;
  signatures: Map<string, Buffer>;
  authorized: Set<string>;
}
export interface AttestationReview {
  kind: "attestation_review";
  jobId: string;
  reviewId: string;
  wallet: string;
  feePayer: string;
  verifier: string;
  messageBase58: string;
  expiresAt: string;
  liveExecution: boolean;
  signatureCount: number;
  feeLamports: number;
  scopeDigest: string;
  operationKey: string;
}
export class ControlledAttestation {
  readonly #confirmations=new Map<string,{kind:"attestation_confirmation";state:"confirmed"|"failed";signature:string;retryAuthorized:false}>();
  readonly #tasks = new Map<string, Promise<void>>();
  readonly #candidates = new Map<string, Candidate>();
  constructor(
    private readonly reader: WorkflowStateReader,
    private readonly store: LifecycleStore,
    private readonly service: Pick<VerifierService, "verify">,
    private readonly chain: AttestationStateReader,
    private readonly actions: ControlledActions,
    private readonly admit: ContributorAdmission,
    private readonly rpc = new ReadOnlyWalletRpc(),
    private readonly blockhashes: TrustedBlockhashSource = new DevnetBlockhashSource(),
    private readonly artifact: () => Promise<ApprovedArtifact> = reviewedArtifact,
    private readonly now = () => performance.now(),
    private readonly wall = () => Date.now()
  ) {}
  private view(job: VerificationJob): WorkflowVerificationJob {
    return {
      kind: "workflow_verification_job",
      jobId: job.jobId,
      generation: job.generation,
      milestone: job.bindings.milestone,
      state: job.state,
      verificationOutcome: job.verificationOutcome,
      mode: "controlled-devnet",
      persisted: true,
      attestation: "not_authorized",
      rewardPayment: "not_established",
      retryAuthorized: false,
    };
  }
  async dispatch(
    input: unknown,
    wallet: string,
    assertSession: () => void
  ): Promise<WorkflowVerificationJob> {
    assertSession();
    const handoff = await this.reader.handoff(structuredClone(input), wallet);
    assertSession();
    const request = handoff.request;
    const state = await this.chain.read(request.milestone);
    assertSession();
    const configuration = await this.actions.configuration();
    const operationKey = "attest_milestone:" + state.milestone,
      approval = configuration.actions.find(
        (a) => a.operationKey === operationKey
      );
    check(
      approval &&
        approval.additionalSigner === state.verifier &&
        approval.wallet !== state.student &&
        approval.wallet !== state.sponsor
    );
    const scope: ApprovedScope = {
      operationKey,
      scopeDigest: attestationScope(state, approval.wallet),
      wallet: approval.wallet,
      additionalSigner: state.verifier,
      fee: 0,
      rent: 0,
    };
    const expected=await this.actions.approval(scope,configuration);
    assertSession();
    check(this.#tasks.size < 4, "verification_capacity");
    let token: string | null = await admitContributorWithDeadline(this.admit,
      Object.freeze({
        milestone: request.milestone,
        student: request.student,
        repositoryId: request.repositoryId,
        contributorId: request.contributorId,
        commit: request.commit,
      })
    );
    assertSession();
    check(
      typeof token === "string" &&
        token.length > 0 &&
        token.length <= 1024 &&
        !/[\r\n]/.test(token),
      "github_contributor_admission_required"
    );
    await this.reader.handoff(structuredClone(input), wallet);
    assertSession();
    await this.actions.assertApproval(scope,expected);
    assertSession();
    const job = this.store.jobs.createOrGetJob(
      "controlled_" + scopeDigest(state.milestone),
      {
        cluster: "devnet",
        genesisHash: SETTLEMENT_DEVNET_GENESIS,
        programId: PROGRAM_ID,
        sponsor: state.sponsor,
        internshipId: state.internshipId,
        internship: state.internship,
        milestoneId: state.milestoneId,
        milestone: state.milestone,
        submission: state.submission,
        student: state.student,
        verifier: state.verifier,
        requirementsHash: state.requirementsHash,
        evidenceHash: state.evidenceHash,
        repositoryId: request.repositoryId,
        contributorId: request.contributorId,
        commit: request.commit,
        verificationSpecHash: state.requirementsHash,
      }
    );
    if (this.#tasks.has(job.jobId) || (job.state!=="created" && !expected.reopensJob)) return this.view(job);
    const existing=this.#candidates.get(job.jobId);
    if(existing && this.now()<existing.policy.expiresAtMs) return this.view(job);
    await this.actions.requireUnsent(scope,expected,lease=>requireExpiredLease(this.rpc,lease));
    await this.actions.assertApproval(scope,expected);
    assertSession();
    if(this.#tasks.has(job.jobId))return this.view(this.store.jobs.getJob(job.jobId)!);
    check(this.#tasks.size<4,"verification_capacity");
    const claimed=this.store.jobRecovery.claimControlled(job.jobId,job.identity,job.revision,expected.id,expected.reopensJob,expected.reopensAttempt);
    this.#candidates.delete(job.jobId);
    let current = claimed.job;
    const fence = () => {
      const j = this.store.jobs.getJob(job.jobId);
      check(
        j &&
          j.identity === claimed.claim.identity &&
          j.revision === current.revision &&
          j.generation === claimed.claim.generation &&
          j.workerId === claimed.claim.workerId &&
          j.state === current.state,
        "stale_worker"
      );
    };
    const step = (
      to:
        | "verification_running"
        | "verification_completed"
        | "authorization_pending"
    ) => {
      fence();
      current = this.store.jobs.transitionJob(
        claimed.claim,
        current.revision,
        to
      );
    };
    step("verification_running");
    const task = (async () => {
      try {
        const boundChain:AttestationStateReader={read:async milestone=>{fence();const observed=await this.chain.read(milestone);fence();check(scopeDigest(observed)===scopeDigest(state),"changed_chain_state");return observed;}};
        const boundService:Pick<VerifierService,"verify">={verify:async(value,credential)=>{fence();await this.actions.assertApproval(scope,expected);assertSession();fence();const result=await this.service.verify(value,credential,fence);fence();return result;}};
        const coordinator = new AttestationTransactionCoordinator(
          boundService,
          boundChain,
          {
            verifier: state.verifier,
            feePayer: scope.wallet,
            maxAgeMs: 30000,
            minRemainingBlockHeights: 5,
          },
          {
            mode: "controlled-phantom",
            publicKey: state.verifier,
            feePayer: scope.wallet,
            acceptPolicyConsumedMessage: async (original) => {
              const policy = takePolicyMessage(original);
              fence();
              check(
                policy.milestone === state.milestone &&
                  policy.verifier === state.verifier &&
                  policy.feePayer === scope.wallet
              );
              const deploymentApproval=await this.actions.assertApproval(scope,expected);
              const deployed = await observeDeployment(
                this.rpc,
                await this.artifact(),
                undefined,
                deploymentApproval.upgradeAuthority
              );
              check(deployed.blockers.length === 0&&deployed.approvedArtifactSha256===deploymentApproval.artifactSha256, "deployment_unverified");
              const fee = await this.rpc.call("getFeeForMessage", [
                policy.message.toString("base64"),
                { commitment: "confirmed", minContextSlot: deployed.slot },
              ]);
              check(
                Number.isSafeInteger(fee?.context?.slot) &&
                  fee.context.slot >= deployed.slot &&
                  Number.isSafeInteger(fee.value) &&
                  fee.value >= 0,
                "fee_unavailable"
              );
              scope.fee = fee.value;
              const batch = await this.rpc.accounts(
                  [scope.wallet],
                  deployed.slot
                ),
                payer = batch.values[0];
              check(
                payer?.owner === PublicKey.default.toBase58() &&
                  payer.executable === false &&
                  JSON.stringify(payer.data) === '["","base64"]' &&
                  Number.isSafeInteger(payer.lamports) &&
                  payer.lamports >= scope.fee,
                "invalid_payer"
              );
              await this.actions.assertApproval(scope,expected);
              await policy.revalidate();
              policy.assertFresh();
              fence();
              for(const [id,c]of this.#candidates){if(this.now()>=c.policy.expiresAtMs&&!this.store.applicationTransactions.get(c.id)?.sendReserved)this.#candidates.delete(id);}
              check(this.#candidates.size < 64, "review_capacity");
              this.#candidates.set(job.jobId, {
                id: randomUUID(),
                job: current,
                claim: claimed.claim,
                policy,
                scope,
                approval:expected,
                signatures: new Map(),
                authorized: new Set(),
              });
            },
          },
          this.blockhashes,
          this.now,
          {
            assertCurrent: fence,
            verified: () => {
              step("verification_completed");
              step("authorization_pending");
            },
          }
        );
        await coordinator.coordinate(request, token!);
      } catch (error) {
        // Match the existing durable coordinator: invalid work is rejected; infrastructure outages require recovery.
        try {
          fence();
          if(current.state==="verification_running" && error instanceof AttestationError && error.code==="verification_failed" && error.verificationReason!==undefined && ["invalid_request","invalid_manifest","requirements_mismatch","evidence_mismatch","repository_mismatch","commit_mismatch","provenance_mismatch","tests_failed"].includes(error.verificationReason)){
            current=this.store.jobs.transitionJob(claimed.claim,current.revision,"verification_rejected");
          }else current = this.store.jobRecovery.interruptJob(
            current.jobId,
            current.identity,
            current.revision,
            "controlled_phantom"
          );
        } catch {}
      } finally {
        token = null;
        this.#tasks.delete(job.jobId);
      }
    })();
    this.#tasks.set(job.jobId, task);
    return this.view(this.store.jobs.getJob(job.jobId)!);
  }
  private candidate(jobId: string, wallet: string) {
    const c = this.#candidates.get(jobId);
    check(
      c && (wallet === c.scope.wallet || wallet === c.scope.additionalSigner)
    );
    const j = this.store.jobs.getJob(jobId);
    check(
      j &&
        j.identity === c.claim.identity &&
        j.generation === c.claim.generation &&
        j.workerId === c.claim.workerId &&
        j.revision === c.job.revision &&
        j.state === "authorization_pending",
      "stale_worker"
    );
    return c;
  }
  requireReview(jobId:string,wallet:string,reviewId:string) {
    check(this.candidate(jobId,wallet).id===reviewId,"review_changed");
  }
  private guard(c: Candidate, active:()=>void=()=>{}) {
    active();
    check(this.candidate(c.job.jobId,c.scope.wallet)===c,"review_changed");
    c.policy.assertFresh();
  }
  private async fresh(c: Candidate) {
    c.policy.assertFresh();
    const deploymentApproval=await this.actions.assertApproval(c.scope,c.approval);
    const deployment = await observeDeployment(
      this.rpc,
      await this.artifact(),
      undefined,
      deploymentApproval.upgradeAuthority
    );
    check(deployment.blockers.length === 0&&deployment.approvedArtifactSha256===deploymentApproval.artifactSha256, "deployment_changed");
    await c.policy.revalidate();
    const fee = await this.rpc.call("getFeeForMessage", [
      c.policy.message.toString("base64"),
      { commitment: "confirmed", minContextSlot: deployment.slot },
    ]);
    check(
      Number.isSafeInteger(fee?.context?.slot) &&
        fee.context.slot >= deployment.slot &&
        fee.value === c.scope.fee,
      "fee_changed"
    );
    const payer = (await this.rpc.accounts([c.scope.wallet], deployment.slot))
      .values[0];
    check(
      payer?.owner === PublicKey.default.toBase58() &&
        payer.executable === false &&
        JSON.stringify(payer.data) === '["","base64"]' &&
        Number.isSafeInteger(payer.lamports) &&
        payer.lamports >= c.scope.fee,
      "invalid_payer"
    );
    this.guard(c);
  }
  async review(jobId: string, wallet: string): Promise<AttestationReview> {
    const c = this.candidate(jobId, wallet);
    await this.fresh(c);
    return {
      kind: "attestation_review",
      jobId,
      reviewId: c.id,
      wallet,
      feePayer: c.scope.wallet,
      verifier: c.scope.additionalSigner!,
      messageBase58: base58(c.policy.message),
      expiresAt: new Date(
        this.wall() + c.policy.expiresAtMs - this.now()
      ).toISOString(),
      liveExecution: true,
      signatureCount: c.signatures.size,
      feeLamports: c.scope.fee,
      scopeDigest: c.scope.scopeDigest,
      operationKey: c.scope.operationKey,
    };
  }
  async authorize(jobId: string, wallet: string, assertActive: () => void) {
    const c = this.candidate(jobId, wallet);
    await this.fresh(c);
    this.guard(c,assertActive);
    check(!c.authorized.has(wallet), "attempt_consumed");
    if (c.authorized.size === 0)
      await this.actions.reserve(c.id,c.scope,c.policy.message,()=>this.guard(c,assertActive),{
        expected:c.approval,context:{blockhash:c.policy.blockhash,lastValidBlockHeight:c.policy.lastValidBlockHeight,
          job:{id:c.job.jobId,generation:c.job.generation,revision:c.job.revision}},
        expire:lease=>requireExpiredLease(this.rpc,lease),
      });
    else await this.actions.current(c.id,c.scope,c.policy.message,c.approval);
    this.guard(c,assertActive);
    check(!c.authorized.has(wallet),"attempt_consumed");
    c.authorized.add(wallet);
    return {
      kind: "wallet_execution_authorization" as const,
      liveExecution: true as const,
    };
  }
  async validate(jobId: string, wallet: string, wireBase64: string,assertActive:()=>void=()=>{}) {
    const c = this.candidate(jobId, wallet);
    await this.fresh(c);
    check(c.authorized.has(wallet), "signing_not_authorized");
    check(typeof wireBase64 === "string" && wireBase64.length <= 1700);
    const wire = Buffer.from(wireBase64, "base64"),
      tx = Transaction.from(wire);
    check(
      wire.toString("base64") === wireBase64 &&
        wire.length <= 1232 &&
        tx.serializeMessage().equals(c.policy.message) &&
        tx.signatures.length === 2 &&
        tx.signatures[0]!.publicKey.toBase58() === c.scope.wallet &&
        tx.signatures[1]!.publicKey.toBase58() === c.scope.additionalSigner &&
        tx.verifySignatures(false) &&
        tx
          .serialize({ requireAllSignatures: false, verifySignatures: false })
          .equals(wire),
      "transaction_substitution"
    );
    const signature = tx.signatures.find(
      (s) => s.publicKey.toBase58() === wallet
    )?.signature;
    check(signature, "missing_signature");
    check(!c.signatures.has(wallet), "attempt_consumed");
    await this.actions.current(c.id,c.scope,c.policy.message,c.approval);
    this.guard(c,assertActive);
    check(!c.signatures.has(wallet),"attempt_consumed");
    const proposed = new Map(c.signatures).set(wallet, Buffer.from(signature));
    if (proposed.size === 2) {
      const complete = this.wire(c, proposed);
      await this.actions.signed(c.id, c.scope, c.policy.message, base58(complete.subarray(1, 65)),
        c.approval, () => this.guard(c, assertActive));
      this.guard(c, assertActive);
    }
    check(!c.signatures.has(wallet), "attempt_consumed");
    c.signatures.set(wallet, Buffer.from(signature));
    return {
      kind: "attestation_signature" as const,
      signatureCount: c.signatures.size,
    };
  }
  private wire(c: Candidate, signatures = c.signatures) {
    const tx = Transaction.populate(Message.from(c.policy.message));
    for (const [wallet, signature] of signatures)
      tx.addSignature(new PublicKey(wallet), signature);
    check(
      signatures.size === 2 && tx.verifySignatures(),
      "missing_signature"
    );
    return tx.serialize();
  }
  async broadcast(jobId: string, wallet: string, assertActive: () => void) {
    const c = this.candidate(jobId, wallet);
    check(wallet === c.scope.wallet, "incorrect_required_signer");
    await this.fresh(c);
    const wire = this.wire(c);
    const recorded=await this.actions.current(c.id,c.scope,c.policy.message,c.approval);
    check(recorded.state==="signed","attempt_consumed");
    this.guard(c,assertActive);
    return this.actions.send(
      c.id,
      c.scope,
      c.policy.message,
      wire,
      base58(wire.subarray(1, 65)),
      ()=>this.guard(c,assertActive),c.approval
    );
  }
  async confirm(jobId: string, wallet: string) {
    const c = this.candidate(jobId, wallet),
      wire = this.wire(c),
      signature = base58(wire.subarray(1, 65));
    const known=this.#confirmations.get(jobId);if(known){check(known.signature===signature,"transaction_substitution");return structuredClone(known);}
    let state: "confirmed" | "failed" | "unknown" = "unknown";
    try {
      check(
        (await this.rpc.call("getGenesisHash")) === SETTLEMENT_DEVNET_GENESIS
      );
      const statuses = await this.rpc.call("getSignatureStatuses", [
          [signature],
          { searchTransactionHistory: true },
        ]),
        s = statuses?.value?.[0];
      if (
        s &&
        ["confirmed", "finalized"].includes(s.confirmationStatus) &&
        Number.isSafeInteger(s.slot) &&
        s.slot >= 0 &&
        statuses.context?.slot >= s.slot &&
        validTransactionError(s.err)
      ) {
        const tx = await this.rpc.call("getTransaction", [
          signature,
          {
            encoding: "base64",
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          },
        ]);
        check(
          tx?.slot === s.slot &&
            tx.transaction?.[1] === "base64" &&
            tx.transaction[0] === wire.toString("base64") &&
            tx.meta &&
            validTransactionError(tx.meta.err) &&
            JSON.stringify(tx.meta.err) === JSON.stringify(s.err)
        );
        if (s.err !== null) state = "failed";
        else {
          check(tx.meta.fee === c.scope.fee);
          const binding = c.job.bindings,
            observed = await this.reader.read(
              {
                apiVersion: "proofwork-application-api-v1",
                cluster: "devnet",
                sponsor: binding.sponsor,
                internshipId: binding.internshipId,
                milestoneId: binding.milestoneId,
              },
              binding.sponsor
            );
          check(
            observed.slot >= s.slot &&
              ["Verified","Settled"].includes(observed.status??"") &&
              observed.student === binding.student &&
              observed.verifier === binding.verifier &&
              observed.requirementsHash === binding.requirementsHash &&
              observed.evidenceHash === binding.evidenceHash &&
              observed.verifiedAt
          );
          state = "confirmed";
        }
      }
    } catch {}
    state=this.actions.recordConfirmation(c.id, signature, state);
    if(state!=="unknown")this.#confirmations.set(jobId,{kind:"attestation_confirmation",state,signature,retryAuthorized:false});
    return {
      kind: "attestation_confirmation" as const,
      state,
      signature,
      retryAuthorized: false as const,
    };
  }
  async drain() {
    await Promise.all(this.#tasks.values());
  }
}
