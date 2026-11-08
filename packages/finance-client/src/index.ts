import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { Buffer } from "buffer";

// Fixed Devnet target identities, not evidence that the program is deployed. Strings avoid mutable shared keys.
export const PROGRAM_ID = "J2FkqDuuuHT14gxjVMhSryrX3Bs4Knct45NMLA79dGdZ";
export const DEMO_MINT = "GoXZxB3gErYYQ3UPKghpTwNPkcqWH1qoNbyU2VTD8Bty";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const DEMO_DECIMALS = 6;
/** Public address methods shared by PublicKey objects from independent SDK installations. */
export type PublicKeyInput = string | Pick<PublicKey, "toBytes" | "toBase58">;
export class FinanceClientError extends Error {
  /** Exposes a stable validation code without retaining caller input. */
  constructor(public readonly code: string) { super(code); }
}
/** Rejects invalid public input with a stable client error code. */
function check(ok: unknown, code: string): asserts ok { if (!ok) throw new FinanceClientError(code); }
/** Requires a canonical 32-byte public address; copies PublicKey inputs to avoid caller aliasing. */
function key(value: PublicKeyInput): PublicKey {
  try {
    check(typeof value === "string" || (typeof value === "object" && value !== null
      && typeof value.toBytes === "function" && typeof value.toBase58 === "function"), "invalid_public_key");
    const bytes = typeof value === "string" ? value : value.toBytes();
    check(typeof value === "string" || (bytes instanceof Uint8Array && bytes.byteLength === 32), "invalid_public_key");
    const parsed = new PublicKey(bytes);
    check(parsed.toBase58() === (typeof value === "string" ? value : value.toBase58()), "invalid_public_key");
    return parsed;
  } catch { throw new FinanceClientError("invalid_public_key"); }
}
/** Bigint only: never rounds number inputs or interprets UI decimal amounts as raw token units. */
function u64(value: bigint): Buffer {
  check(typeof value === "bigint" && value >= 0n && value <= 0xffffffffffffffffn, "invalid_u64");
  const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(value); return bytes;
}
/** Encodes bigint Unix seconds as signed 64-bit little-endian; rejects overflow and number coercion. */
function i64(value: bigint): Buffer {
  check(typeof value === "bigint" && value >= -0x8000000000000000n && value <= 0x7fffffffffffffffn, "invalid_i64");
  const bytes = Buffer.alloc(8); bytes.writeBigInt64LE(value); return bytes;
}
/** Copies a nonzero 32-byte requirements commitment from raw bytes or exactly 64 hexadecimal characters. */
function hash(value: Uint8Array | string): Buffer {
  check(typeof value === "string" ? /^[0-9a-fA-F]{64}$/.test(value) : value instanceof Uint8Array && value.byteLength === 32, "invalid_requirements_hash");
  const bytes = typeof value === "string" ? Buffer.from(value, "hex") : Buffer.from(value);
  check(bytes.some(b => b !== 0), "invalid_requirements_hash"); return bytes;
}
/** Validates the sponsor public address and rejects the unset all-zero key; chain signatures remain authoritative. */
function sponsor(value: PublicKeyInput): PublicKey {
  const address = key(value); check(!address.equals(PublicKey.default), "invalid_sponsor"); return address;
}
export interface TokenConfig { rewardMint?: PublicKeyInput; tokenProgram?: PublicKeyInput }
/** Rejects mint or token-program overrides that differ from the approved classic SPL DEMO configuration. */
function tokenConfig(config: TokenConfig): void {
  check(key(config.rewardMint === undefined ? DEMO_MINT : config.rewardMint).toBase58() === DEMO_MINT, "incorrect_mint");
  check(key(config.tokenProgram === undefined ? TOKEN_PROGRAM_ID : config.tokenProgram).toBase58() === TOKEN_PROGRAM_ID, "incorrect_token_program");
}
/** Returns the canonical PDA and bump using the immutable program ID and approved u64 seed encoding. */
export function deriveInternship(sponsorAddress: PublicKeyInput, internshipId: bigint): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("internship"), sponsor(sponsorAddress).toBuffer(), u64(internshipId)], key(PROGRAM_ID));
}
/** Derives a milestone PDA and canonical bump from its parent internship and lossless u64 ID. */
export function deriveMilestone(internship: PublicKeyInput, milestoneId: bigint): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("milestone"), key(internship).toBuffer(), u64(milestoneId)], key(PROGRAM_ID));
}
/** Derives the dedicated milestone escrow address without allocating or funding an account. */
export function deriveVault(milestone: PublicKeyInput): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), key(milestone).toBuffer()], key(PROGRAM_ID));
}
/** Derives the milestone-specific PDA that authorizes escrow token transfers on-chain. */
export function deriveVaultAuthority(milestone: PublicKeyInput): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("vault_authority"), key(milestone).toBuffer()], key(PROGRAM_ID));
}
/** Derives the sponsor's classic SPL ATA for the fixed DEMO mint; does not create the account. */
export function deriveSponsorAta(sponsorAddress: PublicKeyInput): PublicKey {
  return PublicKey.findProgramAddressSync([sponsor(sponsorAddress).toBuffer(), key(TOKEN_PROGRAM_ID).toBuffer(), key(DEMO_MINT).toBuffer()], key(ASSOCIATED_TOKEN_PROGRAM_ID))[0];
}
/** Builds an account entry with explicit permissions; accounts default to readonly and nonsigning. */
function meta(pubkey: PublicKey, isWritable = false, isSigner = false): AccountMeta { return { pubkey, isWritable, isSigner }; }
/** Wraps encoded data and ordered accounts in an unsigned instruction for the fixed ProofOfWork program. */
function instruction(keys: AccountMeta[], data: Buffer): TransactionInstruction {
  return new TransactionInstruction({ programId: key(PROGRAM_ID), keys, data });
}
export interface InternshipInput { sponsor: PublicKeyInput; internshipId: bigint }
export interface MilestoneInput extends InternshipInput, TokenConfig {
  milestoneId: bigint; rewardAmount: bigint; requirementsHash: Uint8Array | string;
  assignBy: bigint; submitBy: bigint; verifier: PublicKeyInput;
  nowUnixSeconds: bigint; // Client-side reference time only; the program's Clock remains authoritative.
}
/** Builds an unsigned sponsor-paid creation instruction. The caller supplies a wallet-adapter transaction. */
export function createInternshipInstruction(input: InternshipInput): TransactionInstruction {
  const owner = sponsor(input.sponsor), [internship] = deriveInternship(owner, input.internshipId);
  return instruction([meta(owner, true, true), meta(internship, true), meta(SystemProgram.programId)],
    Buffer.concat([Buffer.from("1b75300046d791e5", "hex"), u64(input.internshipId)]));
}
/** Validates proposed terms locally; chain time, authorization and mint state are still checked on-chain. */
export function createMilestoneInstruction(input: MilestoneInput): TransactionInstruction {
  tokenConfig(input);
  const owner = sponsor(input.sponsor), verifier = key(input.verifier);
  const reward = u64(input.rewardAmount), assign = i64(input.assignBy), submit = i64(input.submitBy);
  i64(input.nowUnixSeconds);
  check(input.rewardAmount > 0n, "invalid_reward_amount");
  check(input.nowUnixSeconds > 0n && input.nowUnixSeconds < input.assignBy && input.assignBy < input.submitBy, "invalid_deadlines");
  check(!verifier.equals(PublicKey.default) && PublicKey.isOnCurve(verifier.toBytes()) && !verifier.equals(owner), "invalid_verifier");
  const [internship] = deriveInternship(owner, input.internshipId), [milestone] = deriveMilestone(internship, input.milestoneId);
  return instruction([meta(owner, true, true), meta(internship), meta(milestone, true), meta(key(DEMO_MINT)), meta(key(TOKEN_PROGRAM_ID)), meta(SystemProgram.programId)],
    Buffer.concat([Buffer.from("ef3ac91c28baad30", "hex"), u64(input.milestoneId), reward, hash(input.requirementsHash), assign, submit, verifier.toBuffer()]));
}
export interface FundingInput extends InternshipInput, TokenConfig { milestoneId: bigint }
/** Builds exact-reward funding; amount and deadlines come from validated on-chain state, not client overrides. */
export function fundMilestoneInstruction(input: FundingInput): TransactionInstruction {
  tokenConfig(input);
  const owner = sponsor(input.sponsor), [internship] = deriveInternship(owner, input.internshipId);
  const [milestone] = deriveMilestone(internship, input.milestoneId);
  return instruction([meta(owner, true, true), meta(internship), meta(milestone, true), meta(key(DEMO_MINT)),
    meta(deriveSponsorAta(owner), true), meta(deriveVault(milestone)[0], true), meta(deriveVaultAuthority(milestone)[0]),
    meta(key(TOKEN_PROGRAM_ID)), meta(SystemProgram.programId)], Buffer.from("6882484c543a25b5", "hex"));
}
