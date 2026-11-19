/** Stateless unsigned proposals only. No account writes, ID reservation, RPC, signing or verification execution. */
import { PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { PROGRAM_ID, DEMO_MINT, DEMO_DECIMALS, createInternshipInstruction, createMilestoneInstruction,
  fundMilestoneInstruction, assignStudentInstruction, submitMilestoneInstruction, deriveInternship, deriveMilestone } from "@proofwork/finance-client";
import { parseManifest } from "./manifest.js";
import { evidenceHash } from "./commitments.js";
import { parseRequest } from "./service.js";
import { WalletAuthError } from "./wallet-sessions.js";
import { APPLICATION_API_VERSION } from "./application-api-contracts.js";

export interface WorkflowTerms {
  title: string; note: string; sponsor: string; student: string; verifier: string;
  internshipId: string; milestoneId: string; rewardAmountRaw: string; assignBy: string; submitBy: string;
  owner: string; repository: string; manifest: string;
}
export interface WorkflowPreparation {
  readonly kind: "workflow_preparation";
  readonly action: "organization" | "submission";
  readonly stage: "unsigned_instruction_plan";
  readonly programId: string; readonly rewardMint: string; readonly decimals: number;
  readonly terms: WorkflowTerms; readonly internship: string; readonly milestone: string;
  readonly requirementsHash: string; readonly evidenceHash: string | null;
  readonly steps: readonly { action: string; feePayer: string; instructions: readonly {
    programId: string; keys: readonly { pubkey: string; isSigner: boolean; isWritable: boolean }[]; dataBase64: string;
  }[] }[];
  readonly accountState: "not_observed"; readonly idsReserved: false;
  readonly signed: false; readonly broadcast: false; readonly rewardPayment: "not_established";
  readonly verification: "not_run"; readonly proposalAuthority: "not_proven";
}
function valid(ok: unknown, code = "invalid_workflow"): asserts ok { if (!ok) throw new WalletAuthError(code, 400); }
function fields(value: unknown, names: readonly string[]): Record<string, any> {
  valid(value && typeof value === "object" && !Array.isArray(value));
  valid(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...names].sort()));
  return value as Record<string, any>;
}
function integer(v: unknown, positive = false, max = 0xffffffffffffffffn): bigint {
  valid(typeof v === "string" && /^(0|[1-9][0-9]{0,19})$/.test(v), "invalid_integer");
  const n = BigInt(v); valid(n <= max && (!positive || n > 0n), "invalid_integer"); return n;
}
function address(v: unknown): string {
  try { valid(typeof v === "string"); const k = new PublicKey(v);
    valid(k.toBase58() === v && !k.equals(PublicKey.default) && PublicKey.isOnCurve(k.toBytes())); return v;
  } catch { throw new WalletAuthError("invalid_wallet", 400); }
}
const TERM_FIELDS = ["title", "note", "sponsor", "student", "verifier", "internshipId", "milestoneId", "rewardAmountRaw", "assignBy", "submitBy", "owner", "repository", "manifest"];
function terms(value: unknown): WorkflowTerms {
  const t = fields(value, TERM_FIELDS);
  valid(TERM_FIELDS.every(k => typeof t[k] === "string"));
  valid(t.title.trim().length > 0 && t.title.length <= 120 && t.note.length <= 1000, "invalid_description");
  for (const k of ["sponsor", "student", "verifier"]) address(t[k]);
  valid(new Set([t.sponsor, t.student, t.verifier]).size === 3, "invalid_assignment");
  integer(t.internshipId); integer(t.milestoneId); integer(t.rewardAmountRaw, true);
  const a = integer(t.assignBy, true, 0x7fffffffffffffffn), b = integer(t.submitBy, true, 0x7fffffffffffffffn);
  valid(a < b, "invalid_deadlines");
  valid(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(t.owner) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(t.repository), "invalid_github_evidence");
  valid(t.manifest.length > 0 && Buffer.byteLength(t.manifest) <= 4096, "invalid_manifest");
  try { parseManifest(Buffer.from(t.manifest)); } catch { throw new WalletAuthError("invalid_manifest", 400); }
  return { ...t } as WorkflowTerms;
}
function step(action: string, feePayer: string, ix: TransactionInstruction) {
  // Construct the real SDK transaction without inventing a recent blockhash. It cannot yet be signed or broadcast.
  const transaction = new Transaction(); transaction.feePayer = new PublicKey(feePayer); transaction.add(ix);
  return { action, feePayer, instructions: transaction.instructions.map(i => ({ programId: i.programId.toBase58(),
    keys: i.keys.map(k => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), dataBase64: i.data.toString("base64") })) };
}
export function prepareWorkflow(input: unknown, sessionWallet: string, nowSeconds = BigInt(Math.floor(Date.now() / 1000))): WorkflowPreparation {
  const v = fields(input, ["apiVersion", "cluster", "action", "terms", ...(typeof input === "object" && input !== null && (input as any).action === "submission" ? ["evidence"] : [])]);
  valid(v.apiVersion === APPLICATION_API_VERSION && v.cluster === "devnet" && ["organization", "submission"].includes(v.action));
  // Sponsor identity comes exclusively from the server-verified session, never a form's role selection.
  const t = terms(v.terms); const wallet = address(sessionWallet);
  if (wallet !== (v.action === "organization" ? t.sponsor : t.student)) throw new WalletAuthError("workflow_forbidden", 403);
  const { manifest, hash } = parseManifest(Buffer.from(t.manifest));
  const common = { sponsor: t.sponsor, internshipId: integer(t.internshipId), milestoneId: integer(t.milestoneId) };
  const internship = deriveInternship(common.sponsor, common.internshipId)[0].toBase58();
  const milestone = deriveMilestone(internship, common.milestoneId)[0].toBase58();
  let digest: string | null = null;
  let steps: ReturnType<typeof step>[];
  if (v.action === "organization") {
    valid(nowSeconds > 0n && nowSeconds < BigInt(t.assignBy), "invalid_deadlines");
    steps = [step("create_internship", wallet, createInternshipInstruction(common)),
      step("create_milestone", wallet, createMilestoneInstruction({ ...common, rewardAmount: BigInt(t.rewardAmountRaw),
        requirementsHash: hash, assignBy: BigInt(t.assignBy), submitBy: BigInt(t.submitBy), verifier: t.verifier, nowUnixSeconds: nowSeconds })),
      step("fund_milestone", wallet, fundMilestoneInstruction(common)),
      step("assign_student", wallet, assignStudentInstruction({ ...common, student: t.student }))];
  } else {
    valid(nowSeconds < BigInt(t.submitBy), "invalid_deadlines");
    const e = fields(v.evidence, ["contributorId", "commit", "nonce", "pullRequest"]);
    valid(typeof e.contributorId === "string" && typeof e.commit === "string" && typeof e.nonce === "string", "invalid_github_evidence");
    try {
      parseRequest({ manifestBase64: Buffer.from(t.manifest).toString("base64"), milestone, student: wallet,
        repositoryId: manifest.repositoryId, owner: t.owner, repository: t.repository, ...e });
      valid(/[1-9a-f]/.test(e.commit) && /[1-9a-f]/.test(e.nonce), "invalid_github_evidence");
      digest = evidenceHash({ milestone, student: wallet, requirementsHash: hash.toString("hex"),
        repositoryId: manifest.repositoryId, contributorId: e.contributorId, commit: e.commit, nonce: e.nonce }).toString("hex");
    } catch { throw new WalletAuthError("invalid_github_evidence", 400); }
    steps = [step("submit_milestone", wallet, submitMilestoneInstruction({ ...common, student: wallet, evidenceHash: digest }))];
  }
  return { kind: "workflow_preparation", action: v.action, stage: "unsigned_instruction_plan", programId: PROGRAM_ID,
    rewardMint: DEMO_MINT, decimals: DEMO_DECIMALS, terms: t, internship, milestone, requirementsHash: hash.toString("hex"), evidenceHash: digest, steps,
    accountState: "not_observed", idsReserved: false, signed: false, broadcast: false, rewardPayment: "not_established",
    verification: "not_run", proposalAuthority: "not_proven" };
}
