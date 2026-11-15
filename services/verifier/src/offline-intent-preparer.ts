import { createHash } from "node:crypto";
import { Transaction, PublicKey } from "@solana/web3.js";
import { LifecycleStore, LifecycleError, INTENT_FORMAT, type JobClaim, type TransactionIntent } from "@proofwork/lifecycle";
import { SETTLEMENT_DEVNET_GENESIS, SETTLEMENT_DEVNET_RPC } from "@proofwork/finance-client";
import { buildAttestMilestoneInstruction } from "./attestation.js";
import type { AttestationStateReader } from "./attestation-chain.js";
import type { TransactionPolicyConfig, TrustedBlockhashSource } from "./transaction-policy.js";

export class IntentPreparationError extends Error {
  constructor(public readonly code: string) { super(code); }
}
function check(ok: unknown, code: string): asserts ok { if (!ok) throw new IntentPreparationError(code); }
export interface PrepareIntentInput { readonly claim: JobClaim; readonly jobRevision: number; readonly requestId: string }
export interface OfflinePreparedIntent {
  readonly intent: TransactionIntent;
  readonly message: Buffer;
  readonly signingAuthorization: "not_granted";
  readonly submissionAuthorized: false;
}
/**
 * Separate offline preparation, NOT verification or authorization.
 * Existing authorizers/coordinators never consume these records as tickets.
 * Dependencies/configuration are trusted server capabilities; no HTTP route imports this class.
 */
export class OfflineTransactionPreparer {
  readonly #config: Readonly<TransactionPolicyConfig>;
  constructor(private readonly store: LifecycleStore, private readonly chain: AttestationStateReader,
    private readonly blockhashes: TrustedBlockhashSource, config: TransactionPolicyConfig,
    private readonly now: () => number = () => performance.now()) {
    try {
      check(config !== null && typeof config === "object" && Reflect.ownKeys(config).length === 4
        && ["verifier", "feePayer", "maxAgeMs", "minRemainingBlockHeights"].every(k => {
          const d = Object.getOwnPropertyDescriptor(config, k); return d?.enumerable && Object.hasOwn(d, "value");
        }), "invalid_preparation_config");
      config = structuredClone(config);
      check(typeof config.verifier === "string" && typeof config.feePayer === "string"
        && new PublicKey(config.verifier).toBase58() === config.verifier
        && new PublicKey(config.feePayer).toBase58() === config.feePayer, "invalid_preparation_config");
    } catch { throw new IntentPreparationError("invalid_preparation_config"); }
    check(config.verifier !== config.feePayer && Number.isFinite(config.maxAgeMs) && config.maxAgeMs > 0
      && config.maxAgeMs <= 30_000 && Number.isSafeInteger(config.minRemainingBlockHeights)
      && config.minRemainingBlockHeights > 0, "invalid_preparation_config");
    this.#config = Object.freeze({ ...config });
  }
  async prepare(input: PrepareIntentInput): Promise<OfflinePreparedIntent> {
    try { check(input !== null && typeof input === "object" && Reflect.ownKeys(input).length === 3
      && ["claim", "jobRevision", "requestId"].every(k => {
        const d = Object.getOwnPropertyDescriptor(input, k); return d?.enumerable && Object.hasOwn(d, "value");
      }), "invalid_preparation_input");
    input = structuredClone(input);
    } catch { throw new IntentPreparationError("invalid_preparation_input"); }
    // Creation is the durable once-only start marker. Existing created rows are not resumable here:
    // a previous process may already have computed a message without committing its digest.
    const created = this.store.transactionIntents.createIntent(input.claim, input.jobRevision, input.requestId, this.#config.feePayer);
    check(created.created, "preparation_already_started");
    const intent = created.intent;
    const current = () => {
      const job = this.store.jobs.getJob(intent.jobId), row = this.store.transactionIntents.getIntent(intent.intentId);
      check(job && row && job.identity === intent.jobIdentity && job.revision === input.jobRevision
        && job.generation === input.claim.generation && job.workerId === input.claim.workerId
        && job.state === "authorization_pending" && row.identity === intent.identity && row.revision === 0
        && row.state === "created", "stale_preparation");
    };
    try {
      current();
      const state = structuredClone(await this.chain.read(intent.bindings.milestone));
      current();
      const b = intent.bindings;
      check(b.verifier === this.#config.verifier && [
        "sponsor", "internshipId", "internship", "milestoneId", "milestone", "submission", "student", "verifier",
        "requirementsHash", "evidenceHash",
      ].every(k => state[k as keyof typeof state] === b[k as keyof typeof b]), "changed_preparation_bindings");
      const observation = structuredClone(await this.blockhashes.read());
      current();
      const age = this.now() - observation.observedAtMs;
      check(observation.rpc === SETTLEMENT_DEVNET_RPC && observation.genesisHash === SETTLEMENT_DEVNET_GENESIS
        && observation.valid === true && Number.isSafeInteger(observation.currentBlockHeight) && observation.currentBlockHeight >= 0
        && Number.isSafeInteger(observation.lastValidBlockHeight) && observation.lastValidBlockHeight >= 0
        && observation.lastValidBlockHeight - observation.currentBlockHeight >= this.#config.minRemainingBlockHeights
        && Number.isFinite(age) && age >= 0 && age < this.#config.maxAgeMs, "invalid_preparation_lease");
      const finalState = structuredClone(await this.chain.read(intent.bindings.milestone));
      current();
      check(JSON.stringify(Object.entries(finalState).sort()) === JSON.stringify(Object.entries(state).sort()), "changed_preparation_bindings");
      const finalAge = this.now() - observation.observedAtMs;
      check(Number.isFinite(finalAge) && finalAge >= 0 && finalAge < this.#config.maxAgeMs, "invalid_preparation_lease");
      const instruction = buildAttestMilestoneInstruction(finalState, this.#config.verifier);
      const transaction = new Transaction({ feePayer: new PublicKey(this.#config.feePayer), recentBlockhash: observation.blockhash })
        .add(instruction);
      const message = Buffer.from(transaction.serializeMessage());
      const record = this.store.transactionIntents.recordPreparation(input.claim, input.jobRevision,
        intent.intentId, intent.identity, intent.revision, { messageDigest: createHash("sha256").update(message).digest("hex"),
          format: INTENT_FORMAT, blockhash: observation.blockhash, lastValidBlockHeight: String(observation.lastValidBlockHeight),
          observedBlockHeight: String(observation.currentBlockHeight) });
      return Object.freeze({ intent: record, message: Buffer.from(message), signingAuthorization: "not_granted", submissionAuthorized: false });
    } catch (error) {
      // Uncertainty stays permanently consumed. A revoked worker cannot append even this outcome.
      current();
      this.store.transactionIntents.markPreparationUncertain(input.claim, input.jobRevision, intent.intentId, intent.identity, 0);
      if (error instanceof LifecycleError || error instanceof IntentPreparationError) throw error;
      throw new IntentPreparationError("preparation_failed");
    }
  }
}
