import { readFile } from "node:fs/promises";
import { DockerRunner } from "../src/runner.js";
import { SUM_V2_DIGEST } from "../src/sum-v2.js";
import { parseManifest } from "../src/manifest.js";
import { manifest } from "./helpers.js";
import assert from "node:assert/strict";

const image = process.env.TRUSTED_RUNNER_IMAGE;
if (!image) {
  console.log("SKIPPED real sandbox fixtures: TRUSTED_RUNNER_IMAGE is not configured.");
} else {
  const value = manifest(); value.runner.image = image;
  // Docker start/attach includes lifecycle overhead; only this local fixture uses 5s.
  value.runner.timeoutMs = 5000;
  const { manifest: validated } = parseManifest(Buffer.from(JSON.stringify(value)));
  const runner = new DockerRunner(image);
  const passing = await runner.run(await readFile("fixtures/passing.mjs"), validated);
  const failing = await runner.run(await readFile("fixtures/failing.mjs"), validated);
  assert.ok(passing.every(t => t.passed));
  assert.ok(failing.some(t => !t.passed));
  console.log("sum-v1: real isolated passing and failing fixtures validated (4 cases each).");
  const v2 = { ...value, task: "sum-v2", tests: { suite: "sum-v2", sha256: SUM_V2_DIGEST } };
  const { manifest: hardened } = parseManifest(Buffer.from(JSON.stringify(v2)));
  const correct = await runner.run(await readFile("fixtures/passing.mjs"), hardened);
  assert.equal(correct.length, 18); assert.ok(correct.every(t=>t.passed));
  // Harmless fixed fixtures, executed ONLY by DockerRunner, never imported/evaluated on the host.
  const incorrect = {
    hardcoded: 'export function sum(v) { return ({"[]":0,"[1,2,3]":6,"[-4,7,-2]":1,"[0.25,0.5]":.75})[JSON.stringify(v)] ?? 999; }',
    negatives: 'export function sum(v) { return v.filter(x=>x>=0).reduce((a,b)=>a+b,0); }',
    fractions: 'export function sum(v) { return v.reduce((a,b)=>a+Math.trunc(b),0); }',
    empty: 'export function sum(v) { return v.length ? v.reduce((a,b)=>a+b,0) : 1; }',
    large: 'export function sum(v) { return v.slice(0,8).reduce((a,b)=>a+b,0); }'
  };
  for (const [name, source] of Object.entries(incorrect)) {
    const outcomes = await runner.run(Buffer.from(source), hardened);
    assert.equal(outcomes.length,18); assert.ok(outcomes.some(t=>!t.passed));
    console.log("sum-v2: rejected benign " + name + " fixture after real Docker execution.");
  }
  console.log("sum-v2: correct fixture passed all 18 cases; incorrect fixtures rejected; cleanup completed.");
}
