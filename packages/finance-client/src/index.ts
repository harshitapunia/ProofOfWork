import { PublicKey, SystemProgram, TransactionInstruction, Transaction, type AccountInfo, type AccountMeta } from "@solana/web3.js";
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
function hash(value: Uint8Array | string, errorCode = "invalid_requirements_hash"): Buffer {
  check(typeof value === "string" ? /^[0-9a-fA-F]{64}$/.test(value) : value instanceof Uint8Array && value.byteLength === 32, errorCode);
  const bytes = typeof value === "string" ? Buffer.from(value, "hex") : Buffer.from(value);
  check(bytes.some(b => b !== 0), errorCode); return bytes;
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

// Settlement Destination Policy v2 is approved and implemented by merged PR #24.
export const SETTLEMENT_DEVNET_RPC = "https://api.devnet.solana.com";
export const SETTLEMENT_DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const TOKEN_ACCOUNT_SPACE = 165;

/** Derives the immutable submission PDA; does not allocate storage. */
export function deriveSubmission(milestone: PublicKeyInput): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("submission"), key(milestone).toBuffer()], key(PROGRAM_ID));
}
/** Derives the unique completion PDA; does not initialize a record. */
export function deriveCompletion(milestone: PublicKeyInput): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("completion"), key(milestone).toBuffer()], key(PROGRAM_ID));
}
/** Derives the assigned student's canonical classic SPL ATA. */
export function deriveStudentAta(student: PublicKeyInput): PublicKey {
  return deriveSponsorAta(settlementRole(student));
}
function settlementRole(value: PublicKeyInput): PublicKey {
  const address = key(value);
  check(!address.equals(PublicKey.default) && PublicKey.isOnCurve(address.toBytes()), "invalid_settlement_role");
  return address;
}
export interface SettlementInput extends FundingInput {
  caller: PublicKeyInput;
  student: PublicKeyInput;
  /** Existing initialized sponsor-owned account; defaults to the canonical sponsor ATA. */
  sponsorDestination?: PublicKeyInput;
}
/** Unsigned ABI serializer. It cannot authenticate input state or token ownership without an RPC read. */
export function settleMilestoneInstruction(input: SettlementInput): TransactionInstruction {
  tokenConfig(input);
  const owner = sponsor(input.sponsor), caller = settlementRole(input.caller), student = settlementRole(input.student);
  check(!student.equals(owner), "invalid_settlement_role");
  const [internship] = deriveInternship(owner, input.internshipId);
  const [milestone] = deriveMilestone(internship, input.milestoneId);
  const studentAta = deriveStudentAta(student), vault = deriveVault(milestone)[0];
  const destination = input.sponsorDestination === undefined ? deriveSponsorAta(owner) : key(input.sponsorDestination);
  check(!destination.equals(PublicKey.default) && !destination.equals(vault) && !destination.equals(studentAta), "invalid_destination");
  return instruction([
    meta(caller, true, true), meta(internship), meta(milestone, true), meta(deriveSubmission(milestone)[0]),
    meta(deriveCompletion(milestone)[0], true), meta(key(DEMO_MINT)), meta(vault, true),
    meta(deriveVaultAuthority(milestone)[0]), meta(studentAta, true), meta(destination, true),
    meta(owner, true), meta(key(TOKEN_PROGRAM_ID)), meta(SystemProgram.programId),
  ], Buffer.from("00ef34aaafd1cde0", "hex"));
}
function fallbackSeed(value: unknown): string {
  check(typeof value === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(value), "invalid_fallback_seed");
  return value;
}
/** Public seeded address using the existing caller as System base; no keypair or program PDA is created. */
export async function deriveSponsorFallbackDestination(caller: PublicKeyInput, seed: string): Promise<PublicKey> {
  return PublicKey.createWithSeed(settlementRole(caller), fallbackSeed(seed), key(TOKEN_PROGRAM_ID));
}
export interface SettlementReadRpc {
  readonly rpcEndpoint: string;
  getGenesisHash(): Promise<string>;
  getMultipleAccountsInfo(addresses: PublicKey[], commitment?: "confirmed"): Promise<(AccountInfo<Buffer> | null)[]>;
  getMinimumBalanceForRentExemption(space: number, commitment?: "confirmed"): Promise<number>;
}
export interface PrepareSettlementInput extends SettlementInput {
  /** Public caller-scoped reservation, not a secret. Use a fresh seed after an address collision. */
  fallbackSeed?: string;
}
export interface PreparedSettlement {
  transaction: Transaction;
  sponsorDestination: PublicKey;
  destinationKind: "canonical" | "existing" | "created" | "prefunded";
}
function accountCopy(account: AccountInfo<Buffer> | null): AccountInfo<Buffer> | null {
  if (account === null) return null;
  check(account && Buffer.isBuffer(account.data) && typeof account.executable === "boolean"
    && Number.isSafeInteger(account.lamports) && account.lamports >= 0, "invalid_rpc_account");
  return { ...account, owner: key(account.owner), data: Buffer.from(account.data) };
}
function tokenDestination(account: AccountInfo<Buffer> | null, authority: PublicKey): boolean {
  if (!account || account.executable || !account.owner.equals(key(TOKEN_PROGRAM_ID)) || account.data.length !== TOKEN_ACCOUNT_SPACE) return false;
  const d = account.data;
  return new PublicKey(d.subarray(0, 32)).equals(key(DEMO_MINT))
    && new PublicKey(d.subarray(32, 64)).equals(authority) && d[108] === 1
    && d.readUInt32LE(109) === 0
    && [0, 1].includes(d.readUInt32LE(72)) && [0, 1].includes(d.readUInt32LE(129));
}
function programData(account: AccountInfo<Buffer> | null, size: number, discriminator: readonly number[]): Buffer {
  check(account && !account.executable && account.owner.equals(key(PROGRAM_ID))
    && account.data.length === size && account.data.subarray(0, 8).equals(Buffer.from(discriminator)), "invalid_settlement_state");
  return account.data;
}
function boundKey(data: Buffer, offset: number, expected: PublicKey): boolean {
  return new PublicKey(data.subarray(offset, offset + 32)).equals(expected);
}
/**
 * Reads only the approved Devnet RPC; returns one unsigned transaction, never signs or sends.
 * RPC observations may become stale. On-chain validation remains the security boundary.
 * Missing/invalid canonical ATA falls back to an explicit valid account or atomic seeded provisioning.
 */
export async function prepareSettlementTransaction(input: PrepareSettlementInput, rpc: SettlementReadRpc): Promise<PreparedSettlement> {
  // Snapshot every caller input before the first await; wallet-adapter keys may be mutable.
  const normalized: SettlementInput = {
    sponsor: key(input.sponsor), caller: settlementRole(input.caller), student: settlementRole(input.student),
    internshipId: input.internshipId, milestoneId: input.milestoneId,
    rewardMint: input.rewardMint === undefined ? DEMO_MINT : key(input.rewardMint),
    tokenProgram: input.tokenProgram === undefined ? TOKEN_PROGRAM_ID : key(input.tokenProgram),
    ...(input.sponsorDestination === undefined ? {} : { sponsorDestination: key(input.sponsorDestination) }),
  };
  const seed = input.fallbackSeed === undefined ? undefined : fallbackSeed(input.fallbackSeed);
  const initial = settleMilestoneInstruction(normalized);
  const caller = key(normalized.caller), owner = key(normalized.sponsor), student = key(normalized.student);
  const internship = initial.keys[1]!.pubkey, milestone = initial.keys[2]!.pubkey;
  const submission = initial.keys[3]!.pubkey, completion = initial.keys[4]!.pubkey;
  const vault = initial.keys[6]!.pubkey, vaultAuthority = initial.keys[7]!.pubkey, studentAta = initial.keys[8]!.pubkey;
  const canonical = deriveSponsorAta(owner);
  check(rpc.rpcEndpoint === SETTLEMENT_DEVNET_RPC, "invalid_rpc");
  check(await rpc.getGenesisHash() === SETTLEMENT_DEVNET_GENESIS, "wrong_cluster");
  const fallback = seed === undefined ? undefined : await deriveSponsorFallbackDestination(caller, seed);
  const provided = normalized.sponsorDestination === undefined ? undefined : key(normalized.sponsorDestination);
  const addresses = [internship, milestone, submission, completion, key(DEMO_MINT), vault, studentAta, canonical, caller];
  if (provided) addresses.push(provided);
  if (fallback) addresses.push(fallback);
  const response = await rpc.getMultipleAccountsInfo(addresses, "confirmed");
  check(Array.isArray(response) && response.length === addresses.length, "invalid_rpc_response");
  const accounts = response.map(accountCopy);
  const i = programData(accounts[0]!, 49, [54, 95, 247, 2, 71, 139, 125, 206]);
  const m = programData(accounts[1]!, 276, [38, 210, 239, 177, 85, 184, 10, 44]);
  const sub = programData(accounts[2]!, 113, [58, 194, 159, 158, 75, 102, 178, 197]);
  check(boundKey(i, 8, owner) && i.readBigUInt64LE(40) === normalized.internshipId
    && i[48] === deriveInternship(owner, normalized.internshipId)[1]
    && boundKey(m, 8, internship) && boundKey(m, 40, owner) && boundKey(m, 72, student)
    && boundKey(m, 136, key(DEMO_MINT)) && boundKey(m, 168, submission)
    && m.readBigUInt64LE(232) === normalized.milestoneId
    && m[273] === deriveMilestone(internship, normalized.milestoneId)[1]
    && m[274] === deriveVault(milestone)[1] && m[275] === deriveVaultAuthority(milestone)[1]
    && boundKey(sub, 8, milestone) && boundKey(sub, 40, student)
    && sub[112] === deriveSubmission(milestone)[1], "binding_mismatch");
  const verifier = settlementRole(new PublicKey(m.subarray(104, 136)));
  check(!verifier.equals(owner) && !verifier.equals(student), "invalid_settlement_role");
  check(m[272] === 4 && m.readBigUInt64LE(240) > 0n && m.subarray(200, 232).some(b => b !== 0)
    && sub.subarray(72, 104).some(b => b !== 0)
    && m.readBigInt64LE(248) > 0n && m.readBigInt64LE(248) < m.readBigInt64LE(256)
    && sub.readBigInt64LE(104) > 0n && sub.readBigInt64LE(104) < m.readBigInt64LE(256)
    && m.readBigInt64LE(264) >= sub.readBigInt64LE(104), "invalid_settlement_state");
  const existingCompletion = accounts[3];
  check(existingCompletion === null || (existingCompletion && !existingCompletion.executable
    && existingCompletion.owner.equals(SystemProgram.programId) && existingCompletion.data.length === 0), "existing_completion");
  const mint = accounts[4];
  check(mint && !mint.executable && mint.owner.equals(key(TOKEN_PROGRAM_ID)) && mint.data.length === 82
    && [0, 1].includes(mint.data.readUInt32LE(0)) && mint.data[44] === DEMO_DECIMALS && mint.data[45] === 1 && mint.data.readUInt32LE(46) === 0, "invalid_mint");
  const vaultAccount = accounts[5];
  check(tokenDestination(vaultAccount!, vaultAuthority) && vaultAccount!.data.readUInt32LE(72) === 0
    && vaultAccount!.data.readUInt32LE(129) === 0
    && vaultAccount!.data.readBigUInt64LE(64) >= m.readBigUInt64LE(240), "invalid_vault");
  check(tokenDestination(accounts[6]!, student), "invalid_student_destination");
  const tx = new Transaction(); tx.feePayer = caller;
  let destination = canonical;
  let kind: PreparedSettlement["destinationKind"] = "canonical";
  if (!tokenDestination(accounts[7]!, owner)) {
    if (provided !== undefined) {
      check(tokenDestination(accounts[9]!, owner), "invalid_destination");
      destination = provided; kind = "existing";
    } else {
      check(fallback !== undefined && seed !== undefined, "fallback_seed_required");
      destination = fallback;
      check(!destination.equals(vault) && !destination.equals(studentAta), "invalid_destination");
      const callerAccount = accounts[8];
      check(callerAccount && !callerAccount.executable && callerAccount.owner.equals(SystemProgram.programId)
        && callerAccount.data.length === 0, "invalid_caller_account");
      const existing = accounts[9];
      check(existing === null || (existing && !existing.executable && existing.owner.equals(SystemProgram.programId)
        && existing.data.length === 0), "fallback_address_in_use");
      const rent = await rpc.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SPACE, "confirmed");
      check(Number.isSafeInteger(rent) && rent > 0, "invalid_rent");
      if (existing === null) {
        tx.add(SystemProgram.createAccountWithSeed({ fromPubkey: caller, newAccountPubkey: destination,
          basePubkey: caller, seed, lamports: rent, space: TOKEN_ACCOUNT_SPACE, programId: key(TOKEN_PROGRAM_ID) }));
        kind = "created";
      } else {
        const topUp = Math.max(0, rent - existing!.lamports);
        if (topUp > 0) tx.add(SystemProgram.transfer({ fromPubkey: caller, toPubkey: destination, lamports: topUp }));
        // AllocateWithSeed allocates AND assigns the derived address to the encoded owner.
        tx.add(SystemProgram.allocate({ accountPubkey: destination, basePubkey: caller, seed,
          space: TOKEN_ACCOUNT_SPACE, programId: key(TOKEN_PROGRAM_ID) }));
        kind = "prefunded";
      }
      tx.add(new TransactionInstruction({ programId: key(TOKEN_PROGRAM_ID),
        keys: [meta(destination, true), meta(key(DEMO_MINT))], data: Buffer.concat([Buffer.from([18]), owner.toBuffer()]) }));
    }
  }
  tx.add(settleMilestoneInstruction({ ...normalized, sponsorDestination: destination }));
  return { transaction: tx, sponsorDestination: destination, destinationKind: kind };
}

/** Public, unsigned lifecycle inputs; account addresses are always derived. */
export interface AssignStudentInput extends InternshipInput {
  milestoneId: bigint;
  student: PublicKeyInput;
}
export interface SubmitMilestoneInput extends AssignStudentInput {
  /** Existing domain-separated evidence digest, never the private preimage. */
  evidenceHash: Uint8Array | string;
}
export type RefundUnclaimedMilestoneInput = FundingInput;

/** Reject unsupported account overrides and argument shapes before reading them. */
function lifecycleArguments(input: unknown, required: readonly string[], optional: readonly string[] = []): void {
  check(input !== null && typeof input === "object" && !Array.isArray(input), "invalid_arguments");
  const allowed = [...required, ...optional];
  check(required.every(field => Object.prototype.hasOwnProperty.call(input, field))
    && Reflect.ownKeys(input).every(field => typeof field === "string" && allowed.includes(field)), "invalid_arguments");
}
function lifecycleRole(value: PublicKeyInput, errorCode: string): PublicKey {
  const address = key(value);
  check(!address.equals(PublicKey.default) && PublicKey.isOnCurve(address.toBytes()), errorCode);
  return address;
}

/** Sponsor signs assignment. Stored state, verifier separation and deadlines remain on-chain checks. */
export function assignStudentInstruction(input: AssignStudentInput): TransactionInstruction {
  lifecycleArguments(input, ["sponsor", "internshipId", "milestoneId", "student"]);
  const owner = sponsor(input.sponsor);
  const student = lifecycleRole(input.student, "invalid_student");
  check(!student.equals(owner), "invalid_student");
  const internshipId = input.internshipId, milestoneId = input.milestoneId;
  const [internship] = deriveInternship(owner, internshipId);
  const [milestone] = deriveMilestone(internship, milestoneId);
  return instruction([meta(owner, false, true), meta(internship), meta(milestone, true)],
    Buffer.concat([Buffer.from("ab6ab5bae07f4114", "hex"), student.toBuffer()]));
}

/** Assigned student signs and pays submission rent. This validates a digest; it does not hash evidence. */
export function submitMilestoneInstruction(input: SubmitMilestoneInput): TransactionInstruction {
  lifecycleArguments(input, ["sponsor", "internshipId", "milestoneId", "student", "evidenceHash"]);
  const owner = sponsor(input.sponsor);
  const student = lifecycleRole(input.student, "invalid_student");
  check(!student.equals(owner), "invalid_student");
  const internshipId = input.internshipId, milestoneId = input.milestoneId;
  const digest = hash(input.evidenceHash, "invalid_evidence_hash");
  const [internship] = deriveInternship(owner, internshipId);
  const [milestone] = deriveMilestone(internship, milestoneId);
  return instruction([meta(student, true, true), meta(internship), meta(milestone, true),
    meta(deriveSubmission(milestone)[0], true), meta(SystemProgram.programId)],
  Buffer.concat([Buffer.from("2360dcd766538b34", "hex"), digest]));
}

/** Sponsor-only refund serializer; canonical classic sponsor ATA policy is deliberately unchanged. */
export function refundUnclaimedMilestoneInstruction(input: RefundUnclaimedMilestoneInput): TransactionInstruction {
  lifecycleArguments(input, ["sponsor", "internshipId", "milestoneId"], ["rewardMint", "tokenProgram"]);
  tokenConfig(input);
  const owner = sponsor(input.sponsor);
  const internshipId = input.internshipId, milestoneId = input.milestoneId;
  const [internship] = deriveInternship(owner, internshipId);
  const [milestone] = deriveMilestone(internship, milestoneId);
  return instruction([meta(owner, true, true), meta(internship), meta(milestone, true), meta(key(DEMO_MINT)),
    meta(deriveVault(milestone)[0], true), meta(deriveVaultAuthority(milestone)[0]),
    meta(deriveSponsorAta(owner), true), meta(key(TOKEN_PROGRAM_ID))],
  Buffer.from("702a33229ff75c04", "hex"));
}
