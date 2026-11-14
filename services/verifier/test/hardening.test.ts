import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHub } from "../src/github.js";
import { DevnetReader } from "../src/chain.js";
import { VerifierService } from "../src/service.js";
import { CASES } from "../src/manifest.js";
import { fixture, githubFetch, COMMIT, TOKEN } from "./helpers.js";

test("PR target and exact head commit are independently bound", async () => {
  const f = fixture();
  const path = "/repos/proofwork-demo/assignment/pulls/7";
  for (const patch of [
    { number: 7, user: { id: 2002 }, base: { repo: { id: 9 } }, head: { sha: COMMIT, repo: { id: 1001, full_name: "x/y" } } },
    { number: 7, user: { id: 2002 }, base: { repo: { id: 1001 } }, head: { sha: "ee".repeat(20), repo: { id: 1001, full_name: "x/y" } } },
    {},
  ]) {
    await assert.rejects(new GitHub(githubFetch({ [path]: patch })).verify(f.request, TOKEN));
  }
});
test("source retrieval is pinned and rejects symlinks or invalid Git blobs", async () => {
  const f = fixture();
  const path = "/repos/proofwork-demo/assignment/contents/solution.mjs";
  for (const value of [
    { type: "symlink", encoding: "base64", path: "solution.mjs", size: 1, content: "eA==" },
    { type: "file", encoding: "base64", path: "solution.mjs", size: 1, content: "eA==", sha: "00".repeat(20) },
  ]) await assert.rejects(new GitHub(githubFetch({ [path]: value })).source(f.request, TOKEN, "solution.mjs"));
});
test("API network errors, malformed JSON and secondary rate limits fail safely", async () => {
  const f = fixture();
  await assert.rejects(new GitHub(async () => { throw new Error("network"); }).verify(f.request, TOKEN), /github_api_failure/);
  await assert.rejects(new GitHub(async () => new Response("{")).verify(f.request, TOKEN), /github_api_failure/);
  await assert.rejects(new GitHub(async () => new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } })).verify(f.request, TOKEN), /github_rate_limit/);
});
test("incomplete test reports cannot authorize attestation", async () => {
  const f = fixture();
  const chain = new DevnetReader("https://api.devnet.solana.com", f.verifier.toBase58(), f.rpc);
  for (const outcomes of [[], CASES.map(c => ({ id: c.id, passed: false })), CASES.map(() => ({ id: "forged", passed: true }))]) {
    const service = new VerifierService(new GitHub(githubFetch()), chain, { run: async () => outcomes });
    const result = await service.verify(f.request, TOKEN);
    assert.equal(result.approved, false);
    assert.equal(result.attestation, undefined);
    assert.equal(result.reason, "tests_failed");
  }
});

import { createHash } from "node:crypto";
import { BLOB, TREE, SOURCE } from "./helpers.js";
import type { Fetcher } from "../src/http.js";
import type { Failure } from "../src/errors.js";

const repoPath = "/repos/proofwork-demo/assignment";
const commitPath = repoPath + "/commits/" + COMMIT;
const gitCommitPath = repoPath + "/git/commits/" + COMMIT;
const treePath = repoPath + "/git/trees/" + TREE;
const contentPath = repoPath + "/contents/solution.mjs";
const regular = { path: "solution.mjs", mode: "100644", type: "blob", sha: BLOB, size: SOURCE.length };
const treeResponse = (items: unknown[] = [regular]) => ({ sha: TREE, truncated: false, tree: items });
const contentResponse = (bytes = SOURCE) => ({ type: "file", encoding: "base64", path: "solution.mjs",
  size: bytes.length, content: bytes.toString("base64"),
  sha: createHash("sha1").update(Buffer.from("blob " + bytes.length + "\0")).update(bytes).digest("hex") });

interface Attack { name: string; overrides?: Record<string, unknown>; request?: Fetcher; reason?: Failure }
const attacks: Attack[] = [
  { name: "Contents explicitly identifies symlink", overrides: { [contentPath]: { ...contentResponse(), type: "symlink" } } },
  { name: "Contents dereferences symlink as file", overrides: { [treePath]: treeResponse([{ ...regular, mode: "120000" }]) } },
  { name: "symlink targets another repository path", overrides: { [treePath]: treeResponse([{ ...regular, mode: "120000", sha: "91".repeat(20), size: 9 }]) } },
  { name: "submodule/gitlink", overrides: { [treePath]: treeResponse([{ ...regular, type: "commit", mode: "160000" }]) } },
  { name: "directory replaces source", overrides: { [treePath]: treeResponse([{ ...regular, type: "tree", mode: "040000" }]) } },
  { name: "missing entry", overrides: { [treePath]: treeResponse([]) } },
  { name: "unsupported mode", overrides: { [treePath]: treeResponse([{ ...regular, mode: "100600" }]) } },
  { name: "numeric file mode", overrides: { [treePath]: treeResponse([{ ...regular, mode: 100644 }]) } },
  { name: "inconsistent type and mode", overrides: { [treePath]: treeResponse([{ ...regular, type: "tree" }]) } },
  { name: "wrong tree blob SHA", overrides: { [treePath]: treeResponse([{ ...regular, sha: "00".repeat(20) }]) } },
  { name: "wrong Contents blob SHA", overrides: { [contentPath]: { ...contentResponse(), sha: "00".repeat(20) } } },
  { name: "unrelated valid blob and matching Contents hash", overrides: { [contentPath]: contentResponse(Buffer.from("export const unrelated = true;")) } },
  { name: "tree size and content size disagree", overrides: { [treePath]: treeResponse([{ ...regular, size: SOURCE.length + 1 }]) } },
  { name: "REST and Git commit tree disagree", overrides: { [gitCommitPath]: { sha: COMMIT, tree: { sha: "01".repeat(20) } } } },
  { name: "Git commit substitutes another commit", reason: "commit_mismatch", overrides: { [gitCommitPath]: { sha: "01".repeat(20), tree: { sha: TREE } } } },
  { name: "REST commit substitutes another commit", reason: "commit_mismatch", overrides: { [commitPath]: { sha: "01".repeat(20), commit: { tree: { sha: TREE } } } } },
  { name: "tree substitutes another object", overrides: { [treePath]: { ...treeResponse(), sha: "01".repeat(20) } } },
  { name: "truncated recursive tree containing requested file", overrides: { [treePath]: { ...treeResponse(), truncated: true } } },
  { name: "missing truncation flag", overrides: { [treePath]: { sha: TREE, tree: [regular] } } },
  { name: "string truncation flag", overrides: { [treePath]: { ...treeResponse(), truncated: "false" } } },
  { name: "malformed tree array", overrides: { [treePath]: { ...treeResponse(), tree: {} } } },
  { name: "null tree response", overrides: { [treePath]: null } },
  { name: "null tree item", overrides: { [treePath]: treeResponse([null]) } },
  { name: "duplicate path entries", overrides: { [treePath]: treeResponse([regular, regular]) } },
  { name: "invalid tree blob SHA", overrides: { [treePath]: treeResponse([{ ...regular, sha: "HEAD" }]) } },
  { name: "missing tree entry mode", overrides: { [treePath]: treeResponse([{ path: "solution.mjs", type: "blob", sha: BLOB, size: SOURCE.length }]) } },
  { name: "malformed commit tree", overrides: { [gitCommitPath]: { sha: COMMIT, tree: null } } },
  { name: "missing REST commit tree", overrides: { [commitPath]: { sha: COMMIT } } },
  { name: "invalid commit tree SHA", overrides: { [commitPath]: { sha: COMMIT, commit: { tree: { sha: "HEAD" } } } } },
  { name: "repository metadata substitution", reason: "repository_mismatch", overrides: { [repoPath]: { id: 999 } } },
  { name: "oversized tree file", overrides: { [treePath]: treeResponse([{ ...regular, size: 131073 }]) } },
  { name: "missing tree file size", overrides: { [treePath]: treeResponse([{ ...regular, size: undefined }]) } },
  { name: "oversized Contents content", overrides: { [contentPath]: { ...contentResponse(), size: 131073 } } },
  { name: "invalid base64", overrides: { [contentPath]: { ...contentResponse(), content: "****" } } },
  { name: "noncanonical base64", overrides: { [contentPath]: { ...contentResponse(), content: "Zh==", size: 1 } } },
  { name: "incorrect Contents path", overrides: { [contentPath]: { ...contentResponse(), path: "elsewhere.mjs" } } },
  { name: "incorrect Contents encoding", overrides: { [contentPath]: { ...contentResponse(), encoding: "none" } } },
  { name: "empty source", overrides: { [contentPath]: contentResponse(Buffer.alloc(0)) } },
];
for (const path of [commitPath, gitCommitPath, treePath, contentPath]) {
  attacks.push({ name: "404 at " + path, reason: path === commitPath || path === gitCommitPath ? "missing_commit" : "github_api_failure",
    overrides: { [path]: new Response("", { status: 404 }) } });
}
for (const status of [403, 429, 500]) {
  attacks.push({ name: "API status " + status, reason: status === 429 ? "github_rate_limit" : "github_api_failure",
    overrides: { [treePath]: new Response("", { status }) } });
}
attacks.push(
  { name: "primary rate limit", reason: "github_rate_limit", overrides: { [treePath]: new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } }) } },
  { name: "malformed tree JSON", overrides: { [treePath]: new Response("{") } },
  { name: "bounded tree response exceeded", overrides: { [treePath]: new Response(" ".repeat(1_000_001)) } },
  { name: "network timeout", request: async (url, init) => {
    if (new URL(String(url)).pathname === treePath) throw new DOMException("test-user-credential", "TimeoutError");
    return githubFetch()(url, init);
  } },
);

for (const attack of attacks) {
  test("pinned tree provenance rejects " + attack.name + " before acceptance/attestation", async () => {
    const f = fixture();
    // Clone Response fixtures per invocation: response bodies are single-use.
    const request: Fetcher = attack.request ?? (async (url, init) => {
      const replacements = Object.fromEntries(await Promise.all(Object.entries(attack.overrides ?? {}).map(async ([k, v]) =>
        [k, v instanceof Response ? new Response(await v.clone().arrayBuffer(), { status: v.status, headers: v.headers }) : v])));
      return githubFetch(replacements)(url, init);
    });
    const github = new GitHub(request);
    const reason = attack.reason ?? "github_api_failure";
    await assert.rejects(github.source(f.request, TOKEN, "solution.mjs"), { message: reason });
    let runs = 0;
    const service = new VerifierService(github,
      new DevnetReader("https://api.devnet.solana.com", f.verifier.toBase58(), f.rpc),
      { run: async () => { runs++; return CASES.map(c => ({ id: c.id, passed: true })); } });
    const result = await service.verify(f.request, TOKEN);
    assert.equal(result.status, "failed");
    assert.equal(result.approved, false);
    assert.equal(result.reason, reason);
    assert.equal(result.attestation, undefined);
    assert.equal(runs, 0, "even an always-passing runner must not see invalid source");
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  });
}

for (const mode of ["100644", "100755"]) {
  test("pinned tree accepts regular mode " + mode + " and ignores caller-selected object URLs", async () => {
    const urls: URL[] = [];
    const request: Fetcher = async (url, init) => {
      const u = new URL(String(url)); urls.push(u);
      assert.equal(u.origin, "https://api.github.com");
      assert.ok(init?.signal instanceof AbortSignal);
      assert.equal(init.redirect, "error");
      return githubFetch({ [treePath]: treeResponse([{ ...regular, mode, url: "https://attacker.invalid/object" }]) })(url, init);
    };
    assert.deepEqual(await new GitHub(request).source(fixture().request, TOKEN, "solution.mjs"), SOURCE);
    assert.equal(urls.length, 5);
    assert.equal(urls.at(-1)?.searchParams.get("ref"), COMMIT);
    assert.equal(urls.at(-2)?.searchParams.get("recursive"), "1");
  });
}

const nested = "src/student/solution.mjs";
const parents = [
  { path: "src", type: "tree", mode: "040000", sha: "12".repeat(20) },
  { path: "src/student", type: "tree", mode: "040000", sha: "13".repeat(20) },
];
for (const mode of ["100644", "100755"]) {
  test("valid nested path mode " + mode + " follows exact directory entries", async () => {
    const request = githubFetch({ [treePath]: treeResponse([...parents, { ...regular, path: nested, mode }]),
      [repoPath + "/contents/" + nested]: { ...contentResponse(), path: nested } });
    assert.deepEqual(await new GitHub(request).source(fixture().request, TOKEN, nested), SOURCE);
  });
}
for (const [name, items] of [
  ["missing parent", [{ ...regular, path: nested }]],
  ["symlink parent", [{ ...parents[0], type: "blob", mode: "120000" }, parents[1], { ...regular, path: nested }]],
  ["gitlink parent", [{ ...parents[0], type: "commit", mode: "160000" }, parents[1], { ...regular, path: nested }]],
  ["regular-file parent", [{ ...parents[0], type: "blob", mode: "100644" }, parents[1], { ...regular, path: nested }]],
] as const) {
  test("nested tree rejects " + name, async () => {
    await assert.rejects(new GitHub(githubFetch({ [treePath]: treeResponse([...items]) }))
      .source(fixture().request, TOKEN, nested), /github_api_failure/);
  });
}
for (const entry of ["../solution.mjs", "/solution.mjs", "src//solution.mjs", "src/../solution.mjs", "./solution.mjs",
  "src\\solution.mjs", "src/%2e%2e/solution.mjs", "src/./solution.mjs", "solution.mjs?ref=HEAD", "src/\0solution.mjs",
  "a".repeat(121) + ".mjs", "", "solution.mjs/", "src/.git/solution.mjs"]) {
  test("rejects malformed source path " + JSON.stringify(entry) + " without API calls", async () => {
    let calls = 0;
    await assert.rejects(new GitHub(async () => { calls++; throw Error("must not fetch"); })
      .source(fixture().request, TOKEN, entry), /invalid_request/);
    assert.equal(calls, 0);
  });
}
for (const path of ["../elsewhere", "src//elsewhere", "/elsewhere", "src\\elsewhere", "src/\0elsewhere"]) {
  test("malformed recursive entry cannot hide partial tree " + JSON.stringify(path), async () => {
    await assert.rejects(new GitHub(githubFetch({ [treePath]: treeResponse([regular, { ...regular, path }]) }))
      .source(fixture().request, TOKEN, "solution.mjs"), /github_api_failure/);
  });
}

test("nested service acceptance requires regular parent provenance", async () => {
  for (const symlink of [false, true]) {
    const f = fixture(nested);
    const github = new GitHub(githubFetch({
      [treePath]: treeResponse([{ ...parents[0], ...(symlink ? { type: "blob", mode: "120000" } : {}) },
        parents[1], { ...regular, path: nested }]),
      [repoPath + "/contents/" + nested]: { ...contentResponse(), path: nested },
    }));
    let runs = 0;
    const service = new VerifierService(github,
      new DevnetReader("https://api.devnet.solana.com", f.verifier.toBase58(), f.rpc),
      { run: async () => { runs++; return CASES.map(c => ({ id: c.id, passed: true })); } });
    const result = await service.verify(f.request, TOKEN);
    assert.equal(result.approved, !symlink);
    assert.equal(runs, symlink ? 0 : 1);
    assert.equal(Boolean(result.attestation), !symlink);
  }
});
test("source snapshots commit/repository bindings across network awaits", async () => {
  const input = { ...fixture().request };
  const request: Fetcher = async (url, init) => {
    input.commit = "ee".repeat(20); input.repositoryId = "999"; input.owner = "other";
    assert.equal(new URL(String(url)).origin, "https://api.github.com");
    assert.ok(String(url).includes("/repos/proofwork-demo/assignment"));
    assert.ok(!String(url).includes(input.commit));
    return githubFetch()(url, init);
  };
  assert.deepEqual(await new GitHub(request).source(input, TOKEN, "solution.mjs"), SOURCE);
});
