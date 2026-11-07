import crypto from "node:crypto";
import { Message, Transaction } from "@solana/web3.js";
import { AttestationTransactionCoordinator } from "./transaction-coordinator.js";
import type { AttestationStateReader } from "./attestation-chain.js";
import type { VerifierService } from "./service.js";
import type { TransactionPolicyConfig, TrustedBlockhashSource } from "./transaction-policy.js";
import { key } from "./commitments.js";
import { DEVNET_RPC, DEVNET_GENESIS } from "./devnet-blockhash.js";

/** Canonical transaction ID from its first 64-byte signature; no dependency on wallet utilities. */
export function transactionId(bytes: Uint8Array): string {
  let value = BigInt("0x" + Buffer.from(bytes).toString("hex")), encoded = "";
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  while (value > 0n) { encoded = alphabet[Number(value % 58n)]! + encoded; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; encoded = "1" + encoded; }
  return encoded;
}
export class ExecutionError extends Error {
  constructor(public readonly code: string) { super(code); }
}
function requireExecution(ok: unknown, code: string): asserts ok {
  if (!ok) throw new ExecutionError(code);
}
/** Inject only deterministic doubles today. Credential custody and real signing are not implemented. */
export interface TestMessageSigner {
  readonly mode: "test-only";
  readonly publicKey: string;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}
export interface ExecutionTransport {
  readonly mode: "test-only" | "disabled";
  readonly rpc: typeof DEVNET_RPC;
  genesis(): Promise<string>;
  fee(message: Uint8Array): Promise<number | null>;
  valid(blockhash: string): Promise<boolean>;
  submit(wire: Uint8Array): Promise<string>;
  status(signature: string): Promise<"confirmed" | "failed" | "unknown">;
}
export interface ExecutionConfig extends TransactionPolicyConfig {
  mode: "disabled" | "test-only";
  maxFeeLamports: number;
  timeoutMs: number;
}

/**
 * Server-internal TEST execution harness around the existing coordinator. Live execution is unavailable.
 * All adapters/configuration are trusted server dependencies, never request data. No HTTP route or keys.
 * A consumed reservation stays burned on every signer/submission/confirmation failure; never retries.
 * Unknown outcomes require operator reconciliation, not another execution or automatic reauthorization.
 */
export class DevnetExecutionWorkflow {
  readonly #coordinator: AttestationTransactionCoordinator;
  readonly #config: Readonly<ExecutionConfig>;
  constructor(service: Pick<VerifierService, "verify">, chain: AttestationStateReader,
    config: ExecutionConfig, private readonly verifier: TestMessageSigner | undefined,
    private readonly payer: TestMessageSigner | undefined, private readonly transport: ExecutionTransport,
    blockhashes: TrustedBlockhashSource, private readonly now: () => number = () => performance.now()) {
    this.#config = Object.freeze({ ...config });
    requireExecution(config.mode === "disabled" || config.mode === "test-only", "live_execution_disabled");
    requireExecution(Number.isSafeInteger(config.maxFeeLamports) && config.maxFeeLamports >= 0, "invalid_fee_limit");
    requireExecution(Number.isInteger(config.timeoutMs) && config.timeoutMs > 0 && config.timeoutMs <= 10_000, "invalid_timeout");
    this.#coordinator = new AttestationTransactionCoordinator(service, chain, config, {
      mode: "offline-mock", publicKey: config.verifier,
      acceptAuthorizedMessage: message => this.#handoff(Buffer.from(message)),
    }, blockhashes, now);
  }
  /** No production enable flag exists. Test-only adapters are an explicit trusted-code boundary, not a sandbox. */
  private authorities(): void {
    requireExecution(this.#config.mode === "test-only" && this.transport.mode === "test-only", "live_execution_disabled");
    requireExecution(this.transport.rpc === DEVNET_RPC, "invalid_rpc");
    requireExecution(this.verifier && this.payer, "missing_signing_authority");
    requireExecution(this.verifier.mode === "test-only" && this.payer.mode === "test-only", "live_execution_disabled");
    requireExecution(this.verifier.publicKey === this.#config.verifier, "incorrect_verifier");
    requireExecution(this.payer.publicKey === this.#config.feePayer, "incorrect_fee_payer");
  }
  /** Bounds waits; timed-out side effects are uncertain and may finish later, so no retry is permitted. */
  private async bounded<T>(operation: () => Promise<T>, failure: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ExecutionError(failure)), this.#config.timeoutMs);
      })]);
    } catch { throw new ExecutionError(failure); }
    finally { clearTimeout(timer); }
  }
  /** Releases no bytes/results to a caller; only the trusted coordinator can invoke this private handoff. */
  async #handoff(message: Buffer): Promise<void> {
    const started = this.now();
    const fresh = () => {
      const age = this.now() - started;
      requireExecution(Number.isFinite(age) && age >= 0 && age < this.#config.maxAgeMs, "expired_execution");
    };
    this.authorities();
    requireExecution(await this.bounded(() => this.transport.genesis(), "rpc_failure") === DEVNET_GENESIS, "wrong_cluster");
    const parsed = Message.from(message);
    requireExecution(parsed.serialize().equals(message) && parsed.header.numRequiredSignatures === 2
      && parsed.accountKeys[0]?.toBase58() === this.#config.feePayer
      && parsed.accountKeys[1]?.toBase58() === this.#config.verifier, "transaction_substitution");
    const checkFee = async () => {
      const fee = await this.bounded(() => this.transport.fee(Buffer.from(message)), "rpc_failure");
      requireExecution(typeof fee === "number" && Number.isSafeInteger(fee) && fee >= 0
        && fee <= this.#config.maxFeeLamports, "fee_limit_exceeded");
    };
    const valid = async () => requireExecution(await this.bounded(() => this.transport.valid(parsed.recentBlockhash), "rpc_failure") === true, "expired_blockhash");
    await checkFee(); await valid(); fresh(); this.authorities();
    const transaction = Transaction.populate(parsed);
    for (const signer of [this.payer!, this.verifier!]) {
      this.authorities(); fresh();
      const signature = Buffer.from(await this.bounded(() => signer.signMessage(Buffer.from(message)), "signing_failed"));
      this.authorities(); fresh();
      const publicKey = key(signer.publicKey);
      const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicKey.toBuffer()]);
      requireExecution(signature.length === 64 && crypto.verify(null, message,
        crypto.createPublicKey({ key: der, format: "der", type: "spki" }), signature), "invalid_signature");
      transaction.addSignature(publicKey, signature);
    }
    this.authorities(); fresh();
    requireExecution(transaction.serializeMessage().equals(message), "transaction_substitution");
    await checkFee(); await valid(); fresh(); this.authorities();
    const wire = transaction.serialize({ requireAllSignatures: true, verifySignatures: false });
    // Signatures were individually verified above over exactly the policy message. No replacement message.
    const expected = transaction.signature;
    requireExecution(expected, "invalid_signature");
    const submitted = await this.bounded(() => this.transport.submit(Buffer.from(wire)), "submission_uncertain");
    requireExecution(submitted === transactionId(expected), "submission_uncertain");
    const outcome = await this.bounded(() => this.transport.status(submitted), "confirmation_uncertain");
    requireExecution(outcome !== "failed", "transaction_failed");
    requireExecution(outcome === "confirmed", "confirmation_uncertain");
  }
  /** Runs only with explicitly injected test doubles; default disabled configuration rejects before verification. */
  async execute(input: unknown, githubToken: string): Promise<void> {
    this.authorities();
    await this.#coordinator.coordinate(input, githubToken);
  }
}
