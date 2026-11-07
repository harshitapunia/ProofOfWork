import { readFile } from "node:fs/promises";
import { DockerRunner } from "../src/runner.js";
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
  console.log("Real isolated benign passing and failing fixtures passed.");
}
