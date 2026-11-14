import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, evidenceHash, sha256 } from "../src/commitments.js";
import { TEST_DIGEST, type Manifest } from "../src/manifest.js";
import type { Fetcher } from "../src/http.js";
import type { Request } from "../src/service.js";

export const IMAGE = "node@sha256:" + "ab".repeat(32); // Synthetic test configuration only.
export const COMMIT = "cd".repeat(20);
export const TREE = "ab".repeat(20);
export const SOURCE = Buffer.from("export function sum(values) { return values.reduce((a,b) => a+b, 0); }");
export const BLOB = createHash("sha1").update(Buffer.from("blob " + SOURCE.length + "\0")).update(SOURCE).digest("hex");
export const TOKEN = "test-user-credential";
export function manifest(): Manifest {
  return { version: 1, repositoryId: "1001", task: "sum-v1", entry: "solution.mjs",
    interface: "export function sum(values)", tests: { suite: "sum-v1", sha256: TEST_DIGEST },
    runner: { image: IMAGE, network: "none", user: "65534:65534", readOnly: true,
      cpus: 0.5, memoryMb: 128, pids: 32, timeoutMs: 1000, outputBytes: 4096 }, passing: "all" };
}
function onCurve(start: number): PublicKey {
  for (let i = start; i < 255; i++) {
    const key = new PublicKey(Buffer.alloc(32, i));
    if (PublicKey.isOnCurve(key.toBytes())) return key;
  }
  throw new Error("fixture");
}
export function fixture(entry = "solution.mjs") {
  const sponsor = onCurve(1), student = onCurve(50), verifier = onCurve(100);
  const id = Buffer.alloc(8); id.writeBigUInt64LE(1n);
  const [internship, ib] = PublicKey.findProgramAddressSync([Buffer.from("internship"), sponsor.toBuffer(), id], PROGRAM_ID);
  const [milestone, mb] = PublicKey.findProgramAddressSync([Buffer.from("milestone"), internship.toBuffer(), id], PROGRAM_ID);
  const [submission, sb] = PublicKey.findProgramAddressSync([Buffer.from("submission"), milestone.toBuffer()], PROGRAM_ID);
  const bytes = Buffer.from(JSON.stringify({ ...manifest(), entry }));
  const requirements = sha256(Buffer.concat([Buffer.from("proofwork:requirements:v1"), bytes]));
  const request: Request = { manifestBase64: bytes.toString("base64"), milestone: milestone.toBase58(),
    student: student.toBase58(), repositoryId: "1001", contributorId: "2002", commit: COMMIT, nonce: "ef".repeat(32),
    owner: "proofwork-demo", repository: "assignment", pullRequest: 7 };
  const evidence = evidenceHash({ ...request, requirementsHash: requirements.toString("hex") });
  const m = Buffer.alloc(276), s = Buffer.alloc(113), i = Buffer.alloc(49);
  for (const [name, data] of [["Milestone", m], ["Submission", s], ["Internship", i]] as const) {
    sha256(Buffer.from("account:" + name)).copy(data, 0, 0, 8);
  }
  internship.toBuffer().copy(m, 8); sponsor.toBuffer().copy(m, 40); student.toBuffer().copy(m, 72);
  verifier.toBuffer().copy(m, 104); Buffer.alloc(32, 8).copy(m, 136); submission.toBuffer().copy(m, 168);
  requirements.copy(m, 200); id.copy(m, 232); m.writeBigUInt64LE(10n, 240);
  m.writeBigInt64LE(100n, 248); m.writeBigInt64LE(200n, 256); m[272] = 3; m[273] = mb;
  milestone.toBuffer().copy(s, 8); student.toBuffer().copy(s, 40); evidence.copy(s, 72);
  s.writeBigInt64LE(150n, 104); s[112] = sb;
  sponsor.toBuffer().copy(i, 8); id.copy(i, 40); i[48] = ib;
  const accounts = new Map<string, Buffer>([[milestone.toBase58(), m], [submission.toBase58(), s], [internship.toBase58(), i]]);
  const rpc: Fetcher = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: [string[]] };
    if (body.method !== "getMultipleAccounts") throw new Error("write_rpc_forbidden");
    return Response.json({ result: { value: body.params[0].map(address => {
      const data = accounts.get(address);
      return data ? { owner: PROGRAM_ID.toBase58(), executable: false, data: [data.toString("base64"), "base64"] } : null;
    }) } });
  };
  return { request, requirements, evidence, m, s, i, rpc, accounts, verifier, milestone, submission, internship };
}

export function githubFetch(overrides: Record<string, unknown> = {}): Fetcher {
  return async (url, init) => {
    if (new URL(String(url)).origin !== "https://api.github.com") throw new Error("unexpected_host");
    if (new Headers(init?.headers).get("authorization") !== "Bearer " + TOKEN) throw new Error("auth_missing");
    if (init?.redirect !== "error") throw new Error("redirects_not_disabled");
    const path = new URL(String(url)).pathname;
    let value: unknown;
    if (path === "/user") value = { id: 2002 };
    else if (path === "/repos/proofwork-demo/assignment/commits/" + COMMIT) value = { sha: COMMIT, commit: { tree: { sha: TREE } } };
    else if (path.endsWith("/git/commits/" + COMMIT)) value = { sha: COMMIT, tree: { sha: TREE } };
    else if (path.endsWith("/git/trees/" + TREE)) {
      if (new URL(String(url)).searchParams.get("recursive") !== "1") throw new Error("missing_recursive");
      value = { sha: TREE, truncated: false, tree: [{ path: "solution.mjs", mode: "100644", type: "blob", sha: BLOB, size: SOURCE.length }] };
    }
    else if (path.endsWith("/pulls/7")) value = { number: 7, user: { id: 2002 }, base: { repo: { id: 1001 } },
      head: { sha: COMMIT, repo: { id: 1001, full_name: "proofwork-demo/assignment" } } };
    else if (path.endsWith("/contents/solution.mjs")) {
      if (new URL(String(url)).searchParams.get("ref") !== COMMIT) throw new Error("unpinned_source");
      const code = Buffer.from("export function sum(values) { return values.reduce((a,b) => a+b, 0); }");
      value = { sha: createHash("sha1").update(Buffer.from("blob " + code.length + "\0")).update(code).digest("hex"), type: "file", encoding: "base64", path: "solution.mjs", size: code.length, content: code.toString("base64") };
    } else value = { id: 1001 };
    if (Object.hasOwn(overrides, path)) value = overrides[path];
    if (value instanceof Response) return value;
    return Response.json(value);
  };
}
