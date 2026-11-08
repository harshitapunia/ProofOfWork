import { exactKeys, object, requireValue, VerificationError, type Failure } from "./errors.js";
import { evidenceHash, equal, hex, key, u64 } from "./commitments.js";
import { parseManifest, suiteCaseIds } from "./manifest.js";
import { sumV2OutcomesPass } from "./sum-v2.js";
import { GitHub, type GitHubInput } from "./github.js";
import type { StateReader } from "./chain.js";
import type { Runner, Outcome } from "./runner.js";

export interface Request {
  manifestBase64: string; milestone: string; student: string; repositoryId: string;
  contributorId: string; commit: string; nonce: string; owner: string; repository: string; pullRequest: number;
}
export interface VerificationResult {
  status: "passed" | "failed"; approved: boolean; reason?: Failure; milestone?: string; student?: string;
  repositoryId?: string; contributorId?: string; commit?: string; requirementsHash?: string; evidenceHash?: string;
  outcomes: Outcome[]; startedAt: string; finishedAt: string;
  attestation?: { milestone: string; submission: string; verifier: string; expected_student: string; expected_requirements_hash: string; expected_evidence_hash: string };
}
function parseRequest(value: unknown): Request {
  try {
    const r = object(value);
    exactKeys(r, ["manifestBase64", "milestone", "student", "repositoryId", "contributorId", "commit", "nonce", "owner", "repository", "pullRequest"], "invalid_request");
    requireValue(typeof r.manifestBase64 === "string" && r.manifestBase64.length <= 24_000, "invalid_request");
    key(r.milestone); key(r.student); u64(r.repositoryId); u64(r.contributorId); hex(r.commit, 20); hex(r.nonce, 32);
    requireValue(BigInt(r.repositoryId as string) > 0n && BigInt(r.contributorId as string) > 0n
      && typeof r.owner === "string" && typeof r.repository === "string"
      && Number.isSafeInteger(r.pullRequest) && (r.pullRequest as number) > 0, "invalid_request");
    return r as unknown as Request;
  } catch { throw new VerificationError("invalid_request"); }
}
export class VerifierService {
  private readonly pending = new Set<string>();
  constructor(private readonly github: GitHub, private readonly chain: StateReader, private readonly runner: Runner) {}
  async verify(input: unknown, githubToken: string): Promise<VerificationResult> {
    const startedAt = new Date().toISOString();
    let result: VerificationResult = { status: "failed", approved: false, outcomes: [], startedAt, finishedAt: startedAt };
    let active: string | undefined;
    try {
      const r = parseRequest(input);
      requireValue(!this.pending.has(r.milestone) && this.pending.size < 4, "request_in_progress");
      this.pending.add(r.milestone); active = r.milestone;
      const bytes = Buffer.from(r.manifestBase64, "base64");
      requireValue(bytes.toString("base64") === r.manifestBase64, "invalid_manifest");
      const { manifest, hash } = parseManifest(bytes);
      requireValue(manifest.repositoryId === r.repositoryId, "repository_mismatch");
      const state = await this.chain.read(r.milestone);
      requireValue(state.milestone === r.milestone && state.student === r.student, "evidence_mismatch");
      requireValue(equal(hash, hex(state.requirementsHash, 32)), "requirements_mismatch");
      const evidence = evidenceHash({ ...r, requirementsHash: hash.toString("hex") });
      requireValue(equal(evidence, hex(state.evidenceHash, 32)), "evidence_mismatch");
      const githubInput: GitHubInput = r;
      await this.github.verify(githubInput, githubToken);
      const source = await this.github.source(githubInput, githubToken, manifest.entry);
      result = { ...result, milestone: state.milestone, student: state.student, repositoryId: r.repositoryId,
        contributorId: r.contributorId, commit: r.commit, requirementsHash: state.requirementsHash, evidenceHash: state.evidenceHash };
      const outcomes = await this.runner.run(source, manifest);
      if (manifest.task === "sum-v1") result.outcomes = outcomes;
      const ids = suiteCaseIds(manifest);
      requireValue(manifest.task === "sum-v2" ? sumV2OutcomesPass(outcomes)
        : outcomes.length === ids.length && outcomes.every((outcome, index) => outcome.id === ids[index] && outcome.passed), "tests_failed");
      if (manifest.task === "sum-v2") result.outcomes = outcomes.map(o=>({id:o.id,passed:o.passed}));
      // No cached approval. Recheck mutable on-chain state after execution.
      const current = await this.chain.read(r.milestone);
      requireValue(current.snapshot === state.snapshot, "invalid_onchain_state");
      result = { ...result, status: "passed", approved: true,
        attestation: { milestone: current.milestone, submission: current.submission, verifier: current.verifier,
          expected_student: current.student, expected_requirements_hash: current.requirementsHash, expected_evidence_hash: current.evidenceHash } };
    } catch (error) {
      result = { ...result, status: "failed", approved: false, reason: error instanceof VerificationError ? error.code : "infrastructure_failure" };
      delete result.attestation;
    } finally {
      if (active) this.pending.delete(active);
    }
    return { ...result, finishedAt: new Date().toISOString() };
  }
}
