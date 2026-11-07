import crypto from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { ExecutionError, type TestMessageSigner } from "../src/devnet-execution.js";

/**
 * Local integration tests only. Supply a disposable in-memory Ed25519 key, never an operational wallet.
 * This adapter is not an authorization gate: inject only into the trusted coordinator/execution workflow.
 * No secret export, credential loader, HTTP handler or transport is provided. Key memory is GC-managed.
 */
export class LocalTestSigner implements TestMessageSigner {
  readonly mode = "test-only" as const;
  readonly #privateKey: crypto.KeyObject;
  readonly #publicKey: string;
  constructor(privateKey: crypto.KeyObject) {
    if (!(privateKey instanceof crypto.KeyObject) || privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519")
      throw new ExecutionError("invalid_test_key");
    this.#privateKey = privateKey;
    const publicKey = crypto.createPublicKey(privateKey).export({ format: "jwk" });
    this.#publicKey = new PublicKey(Buffer.from(publicKey.x!, "base64url")).toBase58();
    Object.freeze(this);
  }
  get publicKey(): string { return this.#publicKey; }
  /** Signs a defensive copy of the exact message; callers must already hold trusted authorization. */
  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    if (!(message instanceof Uint8Array) || message.byteLength === 0 || message.byteLength > 1232)
      throw new ExecutionError("invalid_signing_message");
    try { return crypto.sign(null, Buffer.from(message), this.#privateKey); }
    catch { throw new ExecutionError("signing_failed"); }
  }
}
