import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { GitHub, type GitHubInput } from "../src/github.js";
import { VerificationError, object } from "../src/errors.js";
import { jsonResponse, type Fetcher } from "../src/http.js";

const input: GitHubInput = {
  owner: "harshitapunia", repository: "ProofOfWork", repositoryId: "1447380055",
  contributorId: "230834342", pullRequest: 10,
  commit: "a0696fe0dd6f09e00ea853e19331162c3f96b3bf",
};
const entry = "services/verifier/fixtures/passing.mjs";

async function live(): Promise<void> {
  // Capture CLI credentials only in memory, never in argv, output or a fixture.
  let token: string;
  try {
    token = execFileSync("gh", ["auth", "token", "--hostname", "github.com"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim();
  } catch { throw new Error("github_cli_authentication_unavailable"); }
  const requests: string[] = [];
  const request: Fetcher = async (url, init) => {
    const target = new URL(String(url));
    assert.equal(target.origin, "https://api.github.com");
    assert.equal(init?.method ?? "GET", "GET");
    assert.equal(init?.redirect, "error");
    requests.push(target.pathname + target.search);
    return fetch(url, init);
  };
  const get = async (path: string): Promise<Record<string, unknown>> => {
    const response = await request("https://api.github.com" + path, {
      headers: { authorization: "Bearer " + token, accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28" },
      redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("live_metadata_http_" + response.status);
    return object(await jsonResponse(response));
  };
  const base = "/repos/" + input.owner + "/" + input.repository;
  const user = await get("/user");
  assert.equal(user.login, input.owner);
  assert.equal(String(user.id), input.contributorId);
  const repo = await get(base);
  assert.equal(String(repo.id), input.repositoryId);
  assert.equal(repo.full_name, input.owner + "/" + input.repository);
  const pr = await get(base + "/pulls/10");
  assert.equal(pr.number, input.pullRequest);
  assert.equal(object(pr.user).login, input.owner);
  assert.equal(String(object(pr.user).id), input.contributorId);
  assert.equal(String(object(object(pr.base).repo).id), input.repositoryId);
  assert.equal(object(pr.head).sha, input.commit);
  assert.equal((await get(base + "/commits/" + input.commit)).sha, input.commit);
  console.log("PASS live identity, repository, PR author/target/head and commit accessibility");

  const github = new GitHub(request);
  await github.verify(input, token);
  const before = requests.length;
  const source = await github.source(input, token, entry);
  const path = base + "/contents/" + entry + "?ref=" + input.commit;
  assert.deepEqual(requests.slice(before), [path]);
  const metadata = await get(path);
  const blob = createHash("sha1").update(Buffer.from("blob " + source.length + "\0"))
    .update(source).digest("hex");
  assert.equal(metadata.sha, blob);
  assert.equal(metadata.path, entry);
  assert.equal(metadata.size, source.length);
  assert.ok(source.equals(Buffer.from(String(metadata.content).replace(/\n/g, ""), "base64")));
  console.log("PASS existing adapter verify/source, exact commit pin and independently recomputed Git blob SHA: " + blob);

  const negatives: [string, GitHubInput, string][] = [
    ["contributor ID", { ...input, contributorId: String(BigInt(input.contributorId) + 1n) }, "invalid_github_identity"],
    ["repository ID", { ...input, repositoryId: String(BigInt(input.repositoryId) + 1n) }, "repository_mismatch"],
    // This real accessible merge commit is intentionally not the original PR head.
    ["non-head commit", { ...input, commit: "fe16759da7dfd8a6dc5a2f7d3e072422d9a83022" }, "provenance_mismatch"],
  ];
  for (const [label, changed, reason] of negatives) {
    await assert.rejects(github.verify(changed, token),
      (error: unknown) => error instanceof VerificationError && error.code === reason);
    console.log("PASS live negative " + label + ": " + reason);
  }
  console.log("PASS live GitHub integration; read-only requests only; source retrieved but never executed.");
}

if (process.env.LIVE_GITHUB !== "1") {
  console.log("SKIPPED live GitHub integration: explicitly set LIVE_GITHUB=1 and authenticate gh.");
} else {
  try { await live(); }
  catch (error) {
    // Never print raw errors, request headers, response bodies or captured CLI stderr.
    console.error("FAILED live GitHub integration: " +
      (error instanceof VerificationError ? error.code : "authentication_api_or_assertion_failure"));
    process.exitCode = 1;
  }
}
