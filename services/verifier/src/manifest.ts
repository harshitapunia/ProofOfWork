import { TextDecoder } from "node:util";
import { exactKeys, object, requireValue, VerificationError } from "./errors.js";
import { requirementsHash, sha256, u64 } from "./commitments.js";

import { SUM_V2_DIGEST, SUM_V2_IDS } from "./sum-v2.js";

export const CASES = [
  { id: "empty", input: [], expected: 0 },
  { id: "positive", input: [1, 2, 3], expected: 6 },
  { id: "negative", input: [-4, 7, -2], expected: 1 },
  { id: "fraction", input: [0.25, 0.5], expected: 0.75 },
] as const;
export const TEST_DIGEST = sha256(Buffer.from(JSON.stringify(CASES))).toString("hex");
export const IMAGE_PATTERN = /^[a-z0-9][a-z0-9./_-]*@sha256:[0-9a-f]{64}$/;
export interface Manifest {
  version: 1; repositoryId: string; task: "sum-v1" | "sum-v2"; entry: string;
  interface: "export function sum(values)";
  tests: { suite: "sum-v1" | "sum-v2"; sha256: string };
  runner: { image: string; network: "none"; user: "65534:65534"; readOnly: true;
    cpus: number; memoryMb: number; pids: number; timeoutMs: number; outputBytes: number };
  passing: "all";
}
export function parseManifest(bytes: Buffer): { manifest: Manifest; hash: Buffer } {
  // Commit to the original bytes before decoding, parsing, or validation.
  const hash = requirementsHash(bytes);
  try {
    requireValue(bytes.length > 0 && bytes.length <= 16_384, "invalid_manifest");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = object(JSON.parse(text));
    // Compact JSON is the application policy. Duplicate keys and whitespace variants are rejected.
    requireValue(text === JSON.stringify(value), "invalid_manifest");
    exactKeys(value, ["version", "repositoryId", "task", "entry", "interface", "tests", "runner", "passing"], "invalid_manifest");
    requireValue(value.version === 1 && (value.task === "sum-v1" || value.task === "sum-v2") && value.interface === "export function sum(values)" && value.passing === "all", "invalid_manifest");
    u64(value.repositoryId);
    requireValue(BigInt(value.repositoryId as string) > 0n, "invalid_manifest");
    requireValue(typeof value.entry === "string" && /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.mjs$/.test(value.entry) && value.entry.length <= 120, "invalid_manifest");
    const tests = object(value.tests);
    exactKeys(tests, ["suite", "sha256"], "invalid_manifest");
    requireValue(tests.suite === value.task && tests.sha256 === (value.task === "sum-v1" ? TEST_DIGEST : SUM_V2_DIGEST), "invalid_manifest");
    const runner = object(value.runner);
    exactKeys(runner, ["image", "network", "user", "readOnly", "cpus", "memoryMb", "pids", "timeoutMs", "outputBytes"], "invalid_manifest");
    requireValue(typeof runner.image === "string" && IMAGE_PATTERN.test(runner.image), "invalid_manifest");
    requireValue(runner.network === "none" && runner.user === "65534:65534" && runner.readOnly === true, "invalid_manifest");
    for (const [field, min, max] of [["memoryMb", 64, 256], ["pids", 8, 64], ["timeoutMs", 100, 10_000], ["outputBytes", 128, 16_384]] as const) {
      const n = runner[field];
      requireValue(typeof n === "number" && Number.isInteger(n) && n >= min && n <= max, "invalid_manifest");
    }
    requireValue(typeof runner.cpus === "number" && runner.cpus >= 0.1 && runner.cpus <= 1, "invalid_manifest");
    return { manifest: value as unknown as Manifest, hash };
  } catch { throw new VerificationError("invalid_manifest"); }
}

/** Selects only the suite committed by the validated manifest; no fallback or downgrade. */
export function suiteCaseIds(manifest: Manifest): readonly string[] {
  if (manifest.task === "sum-v1" && manifest.tests.suite === "sum-v1" && manifest.tests.sha256 === TEST_DIGEST) return CASES.map(c=>c.id);
  if (manifest.task === "sum-v2" && manifest.tests.suite === "sum-v2" && manifest.tests.sha256 === SUM_V2_DIGEST) return SUM_V2_IDS;
  throw new VerificationError("invalid_manifest");
}
