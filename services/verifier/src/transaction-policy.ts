import { Transaction, type TransactionInstruction } from "@solana/web3.js";
import { AttestationAuthorizer, buildAttestMilestoneInstruction } from "./attestation.js";
import type { AttestationState, AttestationStateReader } from "./attestation-chain.js";
import { PROGRAM_ID, key } from "./commitments.js";

export class TransactionPolicyError extends Error {
  constructor(public readonly code: string) { super(code); }
}
function requirePolicy(ok: unknown, code: string): asserts ok {
  if (!ok) throw new TransactionPolicyError(code);
}
export interface BlockhashObservation {
  rpc: "https://api.devnet.solana.com";
  genesisHash: string;
  blockhash: string;
  lastValidBlockHeight: number;
  currentBlockHeight: number;
  observedAtMs: number; // Same trusted monotonic clock as the policy, never client wall time.
  valid: boolean;
}
/** Trusted server dependency. No live RPC implementation is included in this offline component. */
export interface TrustedBlockhashSource { read(): Promise<BlockhashObservation> }
export interface TransactionPolicyConfig {
  verifier: string;
  feePayer: string; // Explicit approved separate payer; no fallback or inferred wallet.
  maxAgeMs: number; // Applies to observations and approvals; must be <= 30 seconds.
  minRemainingBlockHeights: number;
}
interface Record {
  state: AttestationState; wire: Buffer; message: Buffer;
  blockhash: string; lastValidBlockHeight: number; height: number; issued: number;
}
function sameState(a: AttestationState, b: AttestationState): boolean {
  return JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
}
function sameInstruction(a: TransactionInstruction, b: TransactionInstruction): boolean {
  return a.programId.equals(b.programId) && a.data.equals(b.data) && a.keys.length === b.keys.length
    && a.keys.every((k, n) => { const x = b.keys[n]; return x && k.pubkey.equals(x.pubkey)
      && k.isSigner === x.isSigner && k.isWritable === x.isWritable; });
}

/** Offline final-message gate, NOT a signer. Construct only inside a trusted server coordinator. */
export class AttestationTransactionPolicy {
  readonly #approvals = new WeakMap<object, Record>();
  readonly #config: Readonly<TransactionPolicyConfig>;
  constructor(private readonly authorizer: AttestationAuthorizer, private readonly chain: AttestationStateReader,
    private readonly blockhashes: TrustedBlockhashSource, config: TransactionPolicyConfig,
    private readonly now: () => number = () => performance.now()) {
    key(config.verifier); key(config.feePayer);
    requirePolicy(config.verifier !== config.feePayer, "separate_fee_payer_required");
    requirePolicy(Number.isFinite(config.maxAgeMs) && config.maxAgeMs > 0 && config.maxAgeMs <= 30_000, "invalid_age_policy");
    requirePolicy(Number.isSafeInteger(config.minRemainingBlockHeights) && config.minRemainingBlockHeights > 0, "invalid_height_policy");
    this.#config = Object.freeze({ ...config });
  }
  private fresh(issued: number): void {
    const age = this.now() - issued;
    requirePolicy(Number.isFinite(age) && age >= 0 && age < this.#config.maxAgeMs, "stale_authorization_or_blockhash");
  }
  private async observation(): Promise<BlockhashObservation> {
    const o = structuredClone(await this.blockhashes.read());
    requirePolicy(o.rpc === "https://api.devnet.solana.com"
      && o.genesisHash === "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "invalid_cluster");
    key(o.blockhash);
    requirePolicy(o.valid === true && Number.isSafeInteger(o.currentBlockHeight) && o.currentBlockHeight >= 0
      && Number.isSafeInteger(o.lastValidBlockHeight) && o.lastValidBlockHeight >= 0
      && o.lastValidBlockHeight - o.currentBlockHeight >= this.#config.minRemainingBlockHeights, "invalid_or_expired_blockhash");
    this.fresh(o.observedAtMs);
    return o;
  }
  private parse(wire: Buffer): Transaction {
    requirePolicy(wire.length > 0 && wire.length <= 1232, "unsupported_transaction");
    try {
      const tx = Transaction.from(wire); // Versioned messages are intentionally unsupported.
      requirePolicy(tx.signatures.every(s => s.signature === null), "signed_transaction_not_supported");
      requirePolicy(!tx.nonceInfo && tx.instructions.length === 1, "unauthorized_instructions");
      requirePolicy(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).equals(wire), "noncanonical_transaction");
      return tx;
    } catch (error) {
      if (error instanceof TransactionPolicyError) throw error;
      throw new TransactionPolicyError("unsupported_transaction");
    }
  }
  private expected(ix: TransactionInstruction, o: BlockhashObservation): Transaction {
    requirePolicy(ix.programId.equals(PROGRAM_ID) && ix.data.length === 104
      && ix.keys[0]?.pubkey.toBase58() === this.#config.verifier, "incorrect_authorized_instruction");
    const payer = key(this.#config.feePayer);
    requirePolicy(!payer.equals(ix.programId) && ix.keys.every(k => !payer.equals(k.pubkey)), "fee_payer_alias");
    return new Transaction({ feePayer: payer, recentBlockhash: o.blockhash }).add(ix);
  }
  /** Input bytes are an untrusted proposal; the original process-local evidence ticket is mandatory. */
  async authorize(evidenceTicket: unknown, proposal: Uint8Array): Promise<object> {
    requirePolicy(proposal instanceof Uint8Array && proposal.byteLength > 0 && proposal.byteLength <= 1232, "unsupported_transaction");
    const issued = this.now();
    const wire = Buffer.from(proposal); // Snapshot before the first await.
    const candidate = this.parse(wire);
    const candidateIx = candidate.instructions[0]!;
    const milestone = candidateIx.keys[2]?.pubkey.toBase58();
    requirePolicy(milestone, "incorrect_accounts");
    const initial = structuredClone(await this.chain.read(milestone));
    const ix = await this.authorizer.takeInstruction(evidenceTicket); // Burns the evidence handle and revalidates chain state.
    requirePolicy(initial.verifier === this.#config.verifier, "incorrect_verifier");
    requirePolicy(sameInstruction(ix, buildAttestMilestoneInstruction(initial, this.#config.verifier)), "changed_onchain_bindings");
    requirePolicy(sameInstruction(candidateIx, ix), "transaction_substitution");
    const current = structuredClone(await this.chain.read(milestone));
    requirePolicy(sameState(initial, current), "changed_onchain_bindings");
    const o = await this.observation();
    const finalState = structuredClone(await this.chain.read(milestone));
    requirePolicy(sameState(current, finalState), "changed_onchain_bindings");
    const expected = this.expected(ix, o);
    requirePolicy(candidate.feePayer?.toBase58() === this.#config.feePayer, "incorrect_fee_payer");
    requirePolicy(candidate.recentBlockhash === o.blockhash, "unapproved_blockhash");
    const message = expected.serializeMessage();
    // Compare compiled message AND unsigned wire: catches unused keys, elevated permissions,
    // header/index changes, signature slots, noncanonical encodings and trailing bytes.
    requirePolicy(candidate.serializeMessage().equals(message)
      && expected.serialize({ requireAllSignatures: false, verifySignatures: false }).equals(wire), "transaction_substitution");
    this.fresh(issued); this.fresh(o.observedAtMs);
    const approval = Object.freeze({});
    this.#approvals.set(approval, { state: current, wire, message: Buffer.from(message), blockhash: o.blockhash,
      lastValidBlockHeight: o.lastValidBlockHeight, height: o.currentBlockHeight, issued });
    return approval;
  }
  /** Future signer must call this internally, then sign EXACTLY these bytes; no signing occurs here. */
  async consume(approval: unknown): Promise<Buffer> {
    requirePolicy(typeof approval === "object" && approval !== null, "invalid_transaction_authorization");
    const record = this.#approvals.get(approval);
    requirePolicy(record, "invalid_transaction_authorization");
    this.#approvals.delete(approval); // Burn before awaits, including on failures.
    this.fresh(record.issued);
    const current = structuredClone(await this.chain.read(record.state.milestone));
    requirePolicy(sameState(record.state, current), "changed_onchain_bindings");
    const o = await this.observation();
    requirePolicy(o.blockhash === record.blockhash && o.lastValidBlockHeight === record.lastValidBlockHeight
      && o.currentBlockHeight >= record.height, "changed_blockhash_lease");
    const finalState = structuredClone(await this.chain.read(record.state.milestone));
    requirePolicy(sameState(record.state, finalState), "changed_onchain_bindings");
    const expected = this.expected(buildAttestMilestoneInstruction(current, this.#config.verifier), o);
    requirePolicy(expected.serializeMessage().equals(record.message)
      && expected.serialize({ requireAllSignatures: false, verifySignatures: false }).equals(record.wire), "transaction_substitution");
    this.fresh(record.issued); this.fresh(o.observedAtMs);
    return Buffer.from(record.message); // Private snapshot; no caller transaction object is reused.
  }
}
