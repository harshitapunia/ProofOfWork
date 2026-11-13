import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const env = { ...process.env, PROOFWORK_NODE: process.execPath };
for (const key of Object.keys(env)) {
  if (key.startsWith("BRIDGE_") || key === "PROOFWORK_BRIDGE_ACTIVE" || key === "PROOFWORK_BRIDGE_EVIDENCE_DIR" ||
      key.startsWith("CARGO_TARGET_") ||
      ["RUSTC", "RUSTDOC", "RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS",
       "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER"].includes(key)) {
    delete env[key];
  }
}
env.PROOFWORK_SBF_PATH ??= path.join(
  root, "target/keyless-sbf/sbpfv3-solana-solana/release/proof_of_work.so"
);
env.PROOFWORK_SBF_PATH = path.resolve(env.PROOFWORK_SBF_PATH);
const reviewed = JSON.parse(readFileSync(path.join(root, "tests/runtime/artifact-provenance.json"), "utf8"));
const artifactHash = createHash("sha256").update(readFileSync(env.PROOFWORK_SBF_PATH)).digest("hex");
if (artifactHash !== reviewed.sha256) throw new Error("SBF artifact provenance mismatch");
for (const [tool, prefix] of [
  ["rustc", "rustc 1.98.1 "], ["cargo", "cargo 1.98.1 "],
]) {
  if (!execFileSync(tool, ["--version"], { env, encoding: "utf8" }).startsWith(prefix)) {
    throw new Error("host toolchain mismatch: " + tool);
  }
}
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run("npm", ["ci", "--ignore-scripts"], path.join(root, "packages/finance-client"));
run("npm", ["run", "build"], path.join(root, "packages/finance-client"));
const evidenceRoot = path.join(root, "target/client-bridge");
mkdirSync(evidenceRoot, { recursive: true });
const evidence = mkdtempSync(path.join(evidenceRoot, "run-"));
env.PROOFWORK_BRIDGE_EVIDENCE_DIR = evidence;
console.log("Runtime evidence: " + path.relative(root, evidence));
const inputs = [
  "packages/finance-client/src/index.ts",
  "packages/finance-client/dist/src/index.js",
  "packages/finance-client/package.json",
  "packages/finance-client/package-lock.json",
  "tests/runtime/Cargo.toml", "tests/runtime/Cargo.lock",
  "tests/runtime/client/worker.mjs", "tests/runtime/tests/client_bridge.rs",
  "tests/runtime/tests/support/mod.rs", "tests/runtime/tests/support/finance.rs",
  "tests/runtime/tests/atomicity_sbf.rs", "tests/runtime/tests/refund_sbf.rs",
  "tests/runtime/tests/settlement_sbf.rs", "tests/runtime/tests/smoke.rs",
  "tests/runtime/run-client-bridge.mjs", "tests/runtime/build-sbf.py",
];
const sources = Object.fromEntries(inputs.map(file => [
  file, createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex"),
]));
writeFileSync(path.join(evidence, "provenance.json"), JSON.stringify({
  programSha256: artifactHash, sources, node: process.version,
  rustc: execFileSync("rustc", ["--version"], { env, encoding: "utf8" }).trim(),
  cargo: execFileSync("cargo", ["--version"], { env, encoding: "utf8" }).trim(),
  serializedTests: true,
}, null, 2) + "\n");
const runtime = spawnSync("cargo", [
  "test", "--manifest-path", "tests/runtime/Cargo.toml", "--locked",
  "--", "--test-threads=1",
], { cwd: root, env, stdio: "inherit" });
writeFileSync(path.join(evidence, "result.json"), JSON.stringify({
  status: runtime.error ? "spawn_failed" : runtime.status === 0 ? "passed" : "failed",
  exitCode: runtime.status,
  ...(runtime.error ? { error: runtime.error.message } : {}),
}, null, 2) + "\n");
if (runtime.error) throw runtime.error;
process.exit(runtime.status ?? 1);
