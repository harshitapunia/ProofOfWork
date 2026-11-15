import { createHash, createPublicKey, verify } from "node:crypto";
import { Message } from "@solana/web3.js";
import { key } from "./commitments.js";
import { takeOfflinePolicyMessage, type OfflinePolicyMessage } from "./transaction-policy.js";

export class OfflineSimulationError extends Error {
  constructor(public readonly code: string) { super(code); }
}
function check(ok: unknown, code: string): asserts ok { if (!ok) throw new OfflineSimulationError(code); }
export type SimulationRole = "verifier" | "fee_payer";
export interface OfflineRoleRequest { readonly __offlineRoleRequest: unique symbol }
export interface EphemeralRoleSimulation {
  readonly mode: "ephemeral-offline-test";
  readonly publicKey: string;
  simulateAttestation(request: OfflineRoleRequest): Promise<Uint8Array>;
}
interface RoleRecord {
  readonly role: SimulationRole; readonly publicKey: string; readonly message: Buffer;
  readonly check: () => void; active: boolean; consumed: boolean;
}
const requests = new WeakMap<object, RoleRecord>();
/** Test-provider entry only: exact role/key and live one-shot request; never a generic sign(bytes) API. */
export function takeOfflineRoleMessage(input: unknown, role: SimulationRole, publicKey: string): Buffer {
  check(typeof input === "object" && input !== null, "invalid_offline_role_request");
  const record = requests.get(input); requests.delete(input);
  check(record?.active && record.role === role && record.publicKey === publicKey, "invalid_offline_role_request");
  record.check(); record.consumed = true;
  return Buffer.from(record.message);
}
export interface SimulationContext {
  readonly operationKey: string; readonly milestone: string; readonly programId: string;
  readonly messageDigest: string; readonly verifier: string; readonly feePayer: string; readonly blockhash: string;
  readonly lastValidBlockHeight: number; readonly observedBlockHeight: number;
}
export interface OfflineSimulationEvidence {
  readonly mode: "ephemeral-offline-test"; readonly messageDigest: string;
  readonly verifier: string; readonly feePayer: string;
  readonly requiredSignatureCount: 2; readonly verifiedSignatureCount: 2;
  readonly operationalSigningAuthorized: false; readonly submissionAuthorized: false;
}
export interface SimulationCheckpoints {
  checkpoint(): void;
  /** Synchronous trusted durable intent/fencing write before any provider is called. No message bytes. */
  prepare(context: SimulationContext): void;
  beforeProviders?(): Promise<void>;
}
function ownData(input: unknown, fields: readonly string[]): void {
  try {
    check(input !== null && typeof input === "object" && Reflect.ownKeys(input).length === fields.length
      && fields.every(k => {
        const d = Object.getOwnPropertyDescriptor(input, k); return d?.enumerable && Object.hasOwn(d, "value");
      }), "invalid_simulation_config");
  } catch { throw new OfflineSimulationError("invalid_simulation_config"); }
}
function provider(input: EphemeralRoleSimulation): EphemeralRoleSimulation {
  ownData(input, ["mode", "publicKey", "simulateAttestation"]);
  check(input.mode === "ephemeral-offline-test" && typeof input.simulateAttestation === "function", "invalid_simulation_config");
  key(input.publicKey);
  return Object.freeze({ mode: "ephemeral-offline-test", publicKey: input.publicKey,
    simulateAttestation: input.simulateAttestation.bind(input) });
}
/** Public-key verification only. Private-key generation/use lives exclusively in test fixtures. */
function validSignature(message: Buffer, publicKey: string, signature: Uint8Array): boolean {
  try {
    if (!(signature instanceof Uint8Array) || signature.byteLength !== 64) return false;
    // RFC 8410 Ed25519 SubjectPublicKeyInfo prefix, followed by the raw 32-byte public key.
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key(publicKey).toBuffer()]);
    return verify(null, message, createPublicKey({ key: spki, format: "der", type: "spki" }), signature);
  } catch { return false; }
}
/**
 * Internal test-only authorization adapter. No credentials, key loader, signer implementation,
 * signed-transaction output or transport. Mode labels are not proof of provider custody;
 * providers must be trusted ephemeral test fixtures, never application/request dependencies.
 */
export class OfflineDualSignatureSimulation {
  readonly mode = "ephemeral-offline-test" as const;
  readonly #reserved = new Set<string>();
  readonly #verifier: EphemeralRoleSimulation; readonly #payer: EphemeralRoleSimulation;
  get verifier(): string { return this.#verifier.publicKey; }
  get feePayer(): string { return this.#payer.publicKey; }
  constructor(verifier: EphemeralRoleSimulation, feePayer: EphemeralRoleSimulation,
    private readonly now: () => number = () => performance.now(), private readonly timeoutMs = 1000) {
    this.#verifier = provider(verifier); this.#payer = provider(feePayer);
    check(this.verifier !== this.feePayer && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 1000,
      "invalid_simulation_config");
  }
  /** Accepts ONLY the original one-shot result of real policy consumption, never byte clones or persisted metadata. */
  async simulate(input: unknown, checkpoints: SimulationCheckpoints): Promise<OfflineSimulationEvidence> {
    const context = takeOfflinePolicyMessage(input); // Burns even if a later identity, fence or provider check fails.
    check(context.verifier === this.verifier && context.feePayer === this.feePayer, "simulation_identity_mismatch");
    const message = Buffer.from(context.message);
    const decoded = Message.from(message);
    check(decoded.header.numRequiredSignatures === 2 && decoded.accountKeys[0]?.toBase58() === this.feePayer
      && decoded.accountKeys[1]?.toBase58() === this.verifier, "incorrect_required_signers");
    check(!this.#reserved.has(context.operationKey), "duplicate_simulation");
    this.#reserved.add(context.operationKey); // Never release, even on failure/timeout or a fresh later approval.
    const current = () => { checkpoints.checkpoint(); context.assertFresh(); };
    current();
    const publicContext = Object.freeze({ operationKey: context.operationKey, milestone: context.milestone,
      programId: context.programId, messageDigest: createHash("sha256").update(message).digest("hex"),
      verifier: this.verifier, feePayer: this.feePayer, blockhash: context.blockhash,
      lastValidBlockHeight: context.lastValidBlockHeight, observedBlockHeight: context.observedBlockHeight });
    check(checkpoints.prepare(publicContext) === undefined, "asynchronous_preparation_not_supported");
    current();
    if (checkpoints.beforeProviders) { await checkpoints.beforeProviders(); current(); }
    await this.role("verifier", this.#verifier, context, current);
    await this.role("fee_payer", this.#payer, context, current);
    await context.revalidate(); current();
    return Object.freeze({ mode: "ephemeral-offline-test", messageDigest: publicContext.messageDigest,
      verifier: this.verifier, feePayer: this.feePayer, requiredSignatureCount: 2, verifiedSignatureCount: 2,
      operationalSigningAuthorized: false, submissionAuthorized: false });
  }
  private async role(role: SimulationRole, source: EphemeralRoleSimulation, context: OfflinePolicyMessage,
    current: () => void): Promise<void> {
    current(); await context.revalidate(); current();
    const token = Object.freeze({}) as OfflineRoleRequest;
    const record: RoleRecord = { role, publicKey: source.publicKey, message: Buffer.from(context.message),
      check: current, active: true, consumed: false };
    requests.set(token, record);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        Promise.resolve().then(() => { current(); return source.simulateAttestation(token); }),
        new Promise<never>((_, reject) => { timer = setTimeout(
          () => reject(new OfflineSimulationError("simulation_timeout")),
          Math.max(1, Math.min(this.timeoutMs, context.expiresAtMs - this.now()))); }),
      ]);
      current();
      check(record.consumed, "unconsumed_offline_role_request");
      const copy = response instanceof Uint8Array ? Buffer.from(response) : new Uint8Array();
      check(validSignature(context.message, source.publicKey, copy), "invalid_" + role + "_signature");
      await context.revalidate(); current();
    } catch (error) {
      if (error instanceof OfflineSimulationError) throw error;
      throw new OfflineSimulationError("simulation_failure");
    } finally {
      record.active = false; requests.delete(token);
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
