import { Transaction } from "@solana/web3.js";
import { AttestationAuthorizer, buildAttestMilestoneInstruction } from "./attestation.js";
import type { AttestationStateReader } from "./attestation-chain.js";
import { key } from "./commitments.js";
import { DevnetBlockhashSource } from "./devnet-blockhash.js";
import type { Request, VerifierService } from "./service.js";
import { AttestationTransactionPolicy, type TransactionPolicyConfig, type TrustedBlockhashSource } from "./transaction-policy.js";

/** Test double only: receives authorized message bytes, never a transaction replacement or credentials. */
export interface MockMessageBoundary {
  readonly mode: "offline-mock";
  readonly publicKey: string;
  acceptAuthorizedMessage(message: Uint8Array): Promise<void>;
}
export class CoordinatorError extends Error {
  constructor(public readonly code: string) { super(code); }
}

/**
 * Server-internal offline composition. All dependencies and configuration are trusted, not request inputs.
 * No signing/transport API is exposed. Reuse this instance to retain its process-local replay reservations.
 * A future real signer needs a separately reviewed boundary, custody, payer and confirmation policy.
 */
export class AttestationTransactionCoordinator {
  readonly #authorizer: AttestationAuthorizer;
  readonly #policy: AttestationTransactionPolicy;
  readonly #config: Readonly<TransactionPolicyConfig>;
  constructor(service: Pick<VerifierService, "verify">, private readonly chain: AttestationStateReader,
    config: TransactionPolicyConfig, private readonly boundary: MockMessageBoundary,
    private readonly blockhashes: TrustedBlockhashSource = new DevnetBlockhashSource(),
    now: () => number = () => performance.now()) {
    this.#config = Object.freeze({ ...config });
    this.checkBoundary();
    this.#authorizer = new AttestationAuthorizer(service, chain, this.#config.verifier, now);
    this.#policy = new AttestationTransactionPolicy(this.#authorizer, chain, blockhashes, this.#config, now);
  }
  /** Rechecks the mock's identity immediately before handoff; no payer signing authority is implied. */
  private checkBoundary(): void {
    if (this.boundary.mode !== "offline-mock" || this.boundary.publicKey !== this.#config.verifier)
      throw new CoordinatorError("incorrect_mock_signer");
  }
  /**
   * Runs trusted verification, builds the sole permitted proposal and consumes both single-use gates.
   * Failures after ticket issuance remain reserved, including ambiguous mock-boundary failures; no retry.
   * State can still change after the final read. Reservations are neither durable nor cross-process.
   */
  async coordinate(input: unknown, githubToken: string): Promise<void> {
    this.checkBoundary();
    let request: Request;
    try { request = structuredClone(input) as Request; }
    catch { throw new CoordinatorError("invalid_request"); }
    const ticket = await this.#authorizer.prepare(request, githubToken);
    const state = await this.chain.read(request.milestone);
    const instruction = buildAttestMilestoneInstruction(state, this.#config.verifier);
    const observation = await this.blockhashes.read();
    const transaction = new Transaction({ feePayer: key(this.#config.feePayer), recentBlockhash: observation.blockhash })
      .add(instruction);
    const proposal = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
    const expectedMessage = transaction.serializeMessage();
    const approval = await this.#policy.authorize(ticket, proposal);
    const message = await this.#policy.consume(approval);
    if (!message.equals(expectedMessage)) throw new CoordinatorError("transaction_substitution");
    this.checkBoundary();
    // No intervening await or externally supplied bytes between final checks and the mock call.
    await this.boundary.acceptAuthorizedMessage(Buffer.from(message));
  }
}
