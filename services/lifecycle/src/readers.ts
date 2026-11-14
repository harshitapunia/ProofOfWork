import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, DEMO_MINT, deriveInternship, deriveMilestone, deriveSubmission,
  deriveCompletion, deriveVault, deriveVaultAuthority, SETTLEMENT_DEVNET_RPC,
  SETTLEMENT_DEVNET_GENESIS } from "@proofwork/finance-client";
import { address, check, LifecycleError, u64 } from "./common.js";

export interface Internship {
  readonly address: string; readonly sponsor: string; readonly internshipId: bigint; readonly bump: number;
}
export const STATUSES = ["Created", "Funded", "Assigned", "Submitted", "Verified", "Settled", "Refunded"] as const;
export interface Milestone {
  readonly address: string; readonly internship: string; readonly sponsor: string; readonly student: string;
  readonly verifier: string; readonly rewardMint: string; readonly submission: string; readonly requirementsHash: string;
  readonly milestoneId: bigint; readonly rewardAmount: bigint; readonly assignBy: bigint; readonly submitBy: bigint;
  readonly verifiedAt: bigint; readonly status: typeof STATUSES[number]; readonly bump: number;
  readonly vaultBump: number; readonly vaultAuthorityBump: number;
}
export interface Submission {
  readonly address: string; readonly milestone: string; readonly student: string; readonly evidenceHash: string;
  readonly submittedAt: bigint; readonly bump: number;
}
export interface CompletionRecord {
  readonly address: string; readonly milestone: string; readonly student: string; readonly sponsor: string;
  readonly verifier: string; readonly submission: string; readonly requirementsHash: string; readonly evidenceHash: string;
  readonly verifiedAt: bigint; readonly settledAt: bigint; readonly bump: number;
}
const internships = new WeakSet<object>(), milestones = new WeakSet<object>(), submissions = new WeakSet<object>();
const zero = PublicKey.default.toBase58();
const hash = (b: Buffer) => createHash("sha256").update(b).digest();
const pk = (b: Buffer, n: number) => new PublicKey(b.subarray(n, n + 32)).toBase58();
const role = (s: string) => s !== zero && PublicKey.isOnCurve(new PublicKey(s).toBytes());
const nonzero = (b: Buffer) => b.some(n => n !== 0);
function account(value: unknown, name: string, size: number): Buffer {
  check(value !== null, "missing_account");
  check(value && typeof value === "object" && !Array.isArray(value), "invalid_account");
  const a = value as Record<string, unknown>;
  check(a.owner === PROGRAM_ID && a.executable === false && Array.isArray(a.data)
    && a.data.length === 2 && a.data[1] === "base64" && typeof a.data[0] === "string"
    && a.data[0].length === Math.ceil(size / 3) * 4, "invalid_account");
  const bytes = Buffer.from(a.data[0], "base64");
  check(bytes.length === size && bytes.toString("base64") === a.data[0]
    && bytes.subarray(0, 8).equals(hash(Buffer.from("account:" + name)).subarray(0, 8)), "invalid_account");
  return bytes;
}
function decoding<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof LifecycleError && e.code === "missing_account") throw e;
    throw new LifecycleError("invalid_account");
  }
}
export function decodeInternship(at: string, value: unknown): Internship {
  return decoding(() => {
    address(at);
    const d = account(value, "Internship", 49), sponsor = address(pk(d, 8)), id = d.readBigUInt64LE(40);
    const [pda, bump] = deriveInternship(sponsor, id);
    check(pda.toBase58() === at && d[48] === bump);
    const result = Object.freeze({ address: at, sponsor, internshipId: id, bump });
    internships.add(result); return result;
  });
}
export function decodeMilestone(at: string, value: unknown, parent: Internship): Milestone {
  return decoding(() => {
    check(internships.has(parent)); address(at);
    const d = account(value, "Milestone", 276), id = d.readBigUInt64LE(232);
    const [pda, bump] = deriveMilestone(parent.address, id);
    const n = d[272]!, status = STATUSES[n];
    const student = pk(d, 72), verifier = pk(d, 104), submission = pk(d, 168);
    const assignBy = d.readBigInt64LE(248), submitBy = d.readBigInt64LE(256), verifiedAt = d.readBigInt64LE(264);
    check(pda.toBase58() === at && pk(d, 8) === parent.address && pk(d, 40) === parent.sponsor
      && pk(d, 136) === DEMO_MINT && status !== undefined && d[273] === bump
      && d[274] === deriveVault(at)[1] && d[275] === deriveVaultAuthority(at)[1]
      && d.readBigUInt64LE(240) > 0n && nonzero(d.subarray(200, 232))
      && assignBy > 0n && assignBy < submitBy && role(verifier) && verifier !== parent.sponsor);
    check(n === 6 ? (student === zero || (role(student) && student !== parent.sponsor && student !== verifier))
      : n < 2 ? student === zero : role(student) && student !== parent.sponsor && student !== verifier);
    check(n >= 3 && n <= 5 ? submission === deriveSubmission(at)[0].toBase58() : submission === zero);
    check(n === 4 || n === 5 ? verifiedAt > 0n : verifiedAt === 0n);
    const result: Milestone = Object.freeze({ address: at, internship: parent.address, sponsor: parent.sponsor,
      student, verifier, rewardMint: DEMO_MINT, submission, requirementsHash: d.subarray(200, 232).toString("hex"),
      milestoneId: id, rewardAmount: d.readBigUInt64LE(240), assignBy, submitBy, verifiedAt, status,
      bump, vaultBump: d[274]!, vaultAuthorityBump: d[275]! });
    milestones.add(result); return result;
  });
}
export function decodeSubmission(at: string, value: unknown, parent: Milestone): Submission {
  return decoding(() => {
    check(milestones.has(parent) && ["Submitted", "Verified", "Settled"].includes(parent.status));
    const d = account(value, "Submission", 113), [pda, bump] = deriveSubmission(parent.address);
    const submittedAt = d.readBigInt64LE(104);
    check(pda.toBase58() === at && parent.submission === at && d[112] === bump
      && pk(d, 8) === parent.address && pk(d, 40) === parent.student && nonzero(d.subarray(72, 104))
      && submittedAt > 0n && submittedAt < parent.submitBy
      && (parent.verifiedAt === 0n || parent.verifiedAt >= submittedAt));
    const result = Object.freeze({ address: at, milestone: parent.address, student: parent.student,
      evidenceHash: d.subarray(72, 104).toString("hex"), submittedAt, bump });
    submissions.add(result); return result;
  });
}
export function decodeCompletionRecord(at: string, value: unknown, parent: Milestone, submission: Submission): CompletionRecord {
  return decoding(() => {
    check(milestones.has(parent) && submissions.has(submission) && parent.status === "Settled"
      && submission.milestone === parent.address && submission.address === parent.submission
      && submission.student === parent.student);
    const d = account(value, "CompletionRecord", 249), [pda, bump] = deriveCompletion(parent.address);
    const verifiedAt = d.readBigInt64LE(232), settledAt = d.readBigInt64LE(240);
    check(pda.toBase58() === at && d[248] === bump && pk(d, 8) === parent.address
      && pk(d, 40) === parent.student && pk(d, 72) === parent.sponsor && pk(d, 104) === parent.verifier
      && pk(d, 136) === submission.address && d.subarray(168, 200).toString("hex") === parent.requirementsHash
      && d.subarray(200, 232).toString("hex") === submission.evidenceHash
      && verifiedAt === parent.verifiedAt && verifiedAt >= submission.submittedAt && settledAt >= verifiedAt);
    return Object.freeze({ address: at, milestone: parent.address, student: parent.student, sponsor: parent.sponsor,
      verifier: parent.verifier, submission: submission.address, requirementsHash: parent.requirementsHash,
      evidenceHash: submission.evidenceHash, verifiedAt, settledAt, bump });
  });
}
export interface LifecycleView {
  readonly slot: number; readonly commitment: "confirmed" | "finalized"; readonly internship: Internship;
  readonly milestone: Milestone; readonly submission?: Submission; readonly completion?: CompletionRecord;
}
/** Read-only observations; never transaction confirmation or signing authorization. */
export class DevnetLifecycleReader {
  readonly #commitment: "confirmed" | "finalized";
  readonly #request: typeof fetch;
  constructor(commitment: "confirmed" | "finalized" = "confirmed", request: typeof fetch = fetch) {
    check(commitment === "confirmed" || commitment === "finalized", "invalid_rpc");
    this.#commitment = commitment; this.#request = request;
  }
  async #rpc(method: "getGenesisHash" | "getMultipleAccounts", params: unknown[]): Promise<unknown> {
    try {
      const response = await this.#request(SETTLEMENT_DEVNET_RPC, { method: "POST", redirect: "error",
        headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      check(response.ok && response.body, "rpc_failure");
      const reader = response.body.getReader(), chunks: Buffer[] = []; let size = 0;
      try { while (true) { const { value, done } = await reader.read(); if (done) break;
        size += value.length; check(size <= 16_384, "rpc_failure"); chunks.push(Buffer.from(value)); }
      } finally { await reader.cancel(); }
      const json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      check(json && typeof json === "object" && !Array.isArray(json) && json.jsonrpc === "2.0"
        && json.id === 1 && !Object.hasOwn(json, "error") && Object.hasOwn(json, "result"), "rpc_failure");
      return json.result;
    } catch { throw new LifecycleError("rpc_failure"); }
  }
  async #accounts(addresses: string[]): Promise<{ slot: number; accounts: unknown[] }> {
    check(await this.#rpc("getGenesisHash", []) === SETTLEMENT_DEVNET_GENESIS, "wrong_cluster");
    const raw = await this.#rpc("getMultipleAccounts", [addresses, { encoding: "base64", commitment: this.#commitment }]) as
      { context?: { slot?: unknown }; value?: unknown };
    check(raw && raw.context && Number.isSafeInteger(raw.context.slot) && (raw.context.slot as number) >= 0
      && Array.isArray(raw.value) && raw.value.length === addresses.length, "rpc_failure");
    return { slot: raw.context.slot as number, accounts: raw.value };
  }
  async readInternship(sponsor: string, id: bigint): Promise<{ readonly slot: number; readonly commitment: "confirmed" | "finalized"; readonly internship: Internship }> {
    const at = deriveInternship(address(sponsor), u64(id))[0].toBase58();
    const batch = await this.#accounts([at]);
    return Object.freeze({ slot: batch.slot, commitment: this.#commitment, internship: decodeInternship(at, batch.accounts[0]) });
  }
  async readMilestone(sponsor: string, internshipId: bigint, milestoneId: bigint): Promise<LifecycleView> {
    const i = deriveInternship(address(sponsor), u64(internshipId))[0].toBase58();
    const m = deriveMilestone(i, u64(milestoneId))[0].toBase58();
    const s = deriveSubmission(m)[0].toBase58(), c = deriveCompletion(m)[0].toBase58();
    const batch = await this.#accounts([i, m, s, c]);
    const internship = decodeInternship(i, batch.accounts[0]), milestone = decodeMilestone(m, batch.accounts[1], internship);
    const empty = (v: unknown) => v === null || (!!v && typeof v === "object"
      && (v as Record<string, unknown>).owner === zero && (v as Record<string, unknown>).executable === false
      && JSON.stringify((v as Record<string, unknown>).data) === '["","base64"]');
    const needsSubmission = ["Submitted", "Verified", "Settled"].includes(milestone.status);
    const submission = needsSubmission ? decodeSubmission(s, batch.accounts[2], milestone) : undefined;
    if (!needsSubmission) check(empty(batch.accounts[2]), "invalid_account");
    const completion = milestone.status === "Settled" ? decodeCompletionRecord(c, batch.accounts[3], milestone, submission!) : undefined;
    if (milestone.status !== "Settled") check(empty(batch.accounts[3]), "invalid_account");
    return Object.freeze({ slot: batch.slot, commitment: this.#commitment, internship, milestone, submission, completion });
  }
}
