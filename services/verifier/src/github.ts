import { createHash } from "node:crypto";
import { object, requireValue, VerificationError } from "./errors.js";
import { hex } from "./commitments.js";
import { apiError, jsonResponse, type Fetcher } from "./http.js";

export interface GitHubInput { owner: string; repository: string; pullRequest: number; commit: string; repositoryId: string; contributorId: string }
function githubObject(value: unknown): Record<string, unknown> {
  try { return object(value); } catch { throw new VerificationError("github_api_failure"); }
}
function numericId(value: unknown): string {
  requireValue(typeof value === "number" && Number.isSafeInteger(value) && value > 0, "github_api_failure");
  return String(value);
}
export class GitHub {
  constructor(private readonly request: Fetcher = fetch) {}
  private async get(path: string, token: string, missingCommit = false): Promise<Record<string, unknown>> {
    requireValue(token.length > 0 && token.length <= 1024 && !/[\r\n]/.test(token), "invalid_github_identity");
    try {
      const response = await this.request("https://api.github.com" + path, {
        headers: { authorization: "Bearer " + token, accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw apiError(response, missingCommit);
      return githubObject(await jsonResponse(response));
    } catch (error) {
      if (error instanceof VerificationError) throw error;
      throw new VerificationError("github_api_failure");
    }
  }
  async verify(input: GitHubInput, token: string): Promise<void> {
    requireValue(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(input.owner)
      && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(input.repository)
      && Number.isSafeInteger(input.pullRequest) && input.pullRequest > 0, "invalid_request");
    hex(input.commit, 20);
    const user = await this.get("/user", token);
    requireValue(numericId(user.id) === input.contributorId, "invalid_github_identity");
    const base = "/repos/" + encodeURIComponent(input.owner) + "/" + encodeURIComponent(input.repository);
    const repository = await this.get(base, token);
    requireValue(numericId(repository.id) === input.repositoryId, "repository_mismatch");
    const commit = await this.get(base + "/commits/" + input.commit, token, true);
    requireValue(commit.sha === input.commit, "commit_mismatch");
    const pr = await this.get(base + "/pulls/" + input.pullRequest, token);
    const head = githubObject(pr.head);
    const headRepo = githubObject(head.repo);
    const target = githubObject(githubObject(pr.base).repo);
    requireValue(pr.number === input.pullRequest && numericId(target.id) === input.repositoryId
      && numericId(githubObject(pr.user).id) === input.contributorId && head.sha === input.commit
      && typeof headRepo.full_name === "string" && numericId(headRepo.id).length > 0, "provenance_mismatch");
  }
  async source(input: GitHubInput, token: string, entry: string): Promise<Buffer> {
    input = { ...input }; // Snapshot primitive request bindings before any network await.
    // Independently bind repository and immutable commit/tree identities. Do not
    // cache authorization or accept tree metadata/URLs supplied by the caller.
    requireValue(typeof entry === "string" && entry.length <= 120
      && /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.mjs$/.test(entry), "invalid_request");
    requireValue(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(input.owner)
      && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(input.repository), "invalid_request");
    hex(input.commit, 20);
    const base = "/repos/" + encodeURIComponent(input.owner) + "/" + encodeURIComponent(input.repository);
    const repository = await this.get(base, token);
    requireValue(numericId(repository.id) === input.repositoryId, "repository_mismatch");
    const commit = await this.get(base + "/commits/" + input.commit, token, true);
    requireValue(commit.sha === input.commit, "commit_mismatch");
    const treeSha = githubObject(githubObject(commit.commit).tree).sha;
    requireValue(typeof treeSha === "string" && /^[0-9a-f]{40}$/.test(treeSha), "github_api_failure");
    const gitCommit = await this.get(base + "/git/commits/" + input.commit, token, true);
    requireValue(gitCommit.sha === input.commit, "commit_mismatch");
    requireValue(githubObject(gitCommit.tree).sha === treeSha, "github_api_failure");
    // One bounded recursive response rather than attacker-controlled depth/API
    // traversal. Reject partial evidence even when the requested entry exists.
    const tree = await this.get(base + "/git/trees/" + treeSha + "?recursive=1", token);
    requireValue(tree.sha === treeSha && tree.truncated === false && Array.isArray(tree.tree), "github_api_failure");
    const entries = new Map<string, Record<string, unknown>>();
    for (const value of tree.tree) {
      const item = githubObject(value);
      requireValue(typeof item.path === "string" && item.path.length > 0
        && !item.path.split("/").some(part => !part || part === "." || part === ".." || /[\\\x00-\x1f\x7f]/.test(part))
        && !entries.has(item.path) && typeof item.sha === "string" && /^[0-9a-f]{40}$/.test(item.sha)
        && typeof item.mode === "string" && ((item.type === "tree" && item.mode === "040000")
          || (item.type === "commit" && item.mode === "160000")
          || (item.type === "blob" && ["100644", "100755", "120000"].includes(item.mode))),
        "github_api_failure");
      entries.set(item.path, item);
    }
    const parts = entry.split("/");
    for (let n = 1; n < parts.length; n++) {
      const parent = entries.get(parts.slice(0, n).join("/"));
      requireValue(parent?.type === "tree" && parent.mode === "040000", "github_api_failure");
    }
    const selected = entries.get(entry);
    requireValue(selected?.type === "blob" && (selected.mode === "100644" || selected.mode === "100755")
      && typeof selected.size === "number" && Number.isSafeInteger(selected.size)
      && selected.size > 0 && selected.size <= 131_072, "github_api_failure");
    const path = base + "/contents/" + parts.map(encodeURIComponent).join("/") + "?ref=" + input.commit;
    const content = await this.get(path, token);
    requireValue(content.type === "file" && content.encoding === "base64" && content.path === entry
      && typeof content.content === "string" && typeof content.size === "number"
      && Number.isSafeInteger(content.size) && content.size > 0 && content.size <= 131_072, "github_api_failure");
    const encoded = (content.content as string).replace(/\n/g, "");
    requireValue(/^[A-Za-z0-9+/]*={0,2}$/.test(encoded), "github_api_failure");
    const bytes = Buffer.from(encoded, "base64");
    requireValue(bytes.length === content.size && bytes.toString("base64") === encoded, "github_api_failure");
    const blob = createHash("sha1").update(Buffer.from("blob " + bytes.length + "\0")).update(bytes).digest("hex");
    requireValue(content.sha === blob && selected.sha === blob && selected.size === bytes.length, "github_api_failure");
    return bytes;
  }
}
