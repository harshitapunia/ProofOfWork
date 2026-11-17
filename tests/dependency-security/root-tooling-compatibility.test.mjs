/** Trusted offline developer-tool fixtures only. No RPC, wallets, key loading or transactions. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn } from "node:child_process";
const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, "../..");
const requireRoot = createRequire(join(root, "package.json"));
const mocha = join(dirname(requireRoot.resolve("mocha/package.json")), "bin/mocha.js");
const tsMocha = join(dirname(requireRoot.resolve("ts-mocha/package.json")), "bin/ts-mocha");
function fixture(t, files) {
  // Exercise the root CommonJS/tsconfig boundary, not this ESM compatibility package's boundary.
  const dir = mkdtempSync(join(root, ".root-tooling-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}
function run(bin, args) {
  return spawnSync(process.execPath, [bin, ...args], { cwd: root, env: { ...process.env, NO_COLOR: "1" }, encoding: "utf8", timeout: 15000 });
}
function passed(result, total) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const json = JSON.parse(result.stdout); assert.equal(json.stats.passes, total); assert.equal(json.stats.failures, 0);
}
test("root Mocha preserves CommonJS hooks, async/callback tests and trusted Anchor public serialization", t => {
  const dir = fixture(t, { "common.cjs": `
const {assert}=require('chai'); const anchor=require('@anchor-lang/core');
describe('trusted root SDK compatibility',function(){
 let n=0;beforeEach(function(){n=1});
 it('preserves lossless public BN serialization',function(){assert.equal(new anchor.BN('18446744073709551615').toArrayLike(Buffer,'le',8).toString('hex'),'ffffffffffffffff');assert.equal(typeof anchor.Program,'function');assert.equal(typeof anchor.BorshCoder,'function');assert.equal(n,1)});
 it('awaits promises',async function(){assert.equal(await Promise.resolve(n+1),2)});
 it('awaits callbacks',function(done){setImmediate(function(){assert.equal(n,1);done()})});
});` });
  passed(run(mocha, ["--reporter", "json", join(dir, "common.cjs")]), 3);
});
test("root Mocha preserves ESM test modules", t => {
  const dir = fixture(t, { "esm.mjs": "import assert from 'node:assert/strict'; describe('ESM fixture',()=>{it('awaits ESM',async()=>assert.equal(await Promise.resolve(4),4))});" });
  passed(run(mocha, ["--reporter", "json", join(dir, "esm.mjs")]), 1);
});
test("root ts-mocha preserves actual TypeScript enum transpilation and Chai integration", t => {
  const dir = fixture(t, { "typed.ts": "import {assert} from 'chai'; enum State { Ready=7 }; interface Box<T>{value:T}; describe('typed fixture',()=>{it('transpiles enums and generic interfaces',()=>{const b:Box<State>={value:State.Ready};assert.equal(b.value,7)})});" });
  passed(run(tsMocha, ["--project", join(root, "tsconfig.json"), "--reporter", "json", join(dir, "typed.ts")]), 1);
});
test("root Mocha YAML config preserves glob discovery and ignore matching", t => {
  const dir = fixture(t, {
    "included.spec.cjs": "describe('glob fixture',()=>{it('includes intended file',()=>{})});",
    "excluded.spec.cjs": "throw Error('ignored file was unexpectedly loaded');"
  });
  writeFileSync(join(dir, "config.yaml"), `spec:\n  - ${JSON.stringify(join(dir, "*.spec.cjs"))}\nignore:\n  - ${JSON.stringify(join(dir, "excluded.spec.cjs"))}\nreporter: json\n`);
  passed(run(mocha, ["--config", join(dir, "config.yaml")]), 1);
});
test("root Mocha preserves useful assertion diffs and failing exit status", t => {
  const dir = fixture(t, { "failure.cjs": "const assert=require('node:assert/strict');describe('intentional failure fixture',()=>{it('reports a structural diff',()=>assert.deepEqual({value:'actual'},{value:'expected'}))});" });
  const result = run(mocha, ["--no-color", "--reporter", "spec", join(dir, "failure.cjs")]);
  assert.equal(result.status, 1); assert.match(result.stdout, /1 failing/); assert.match(result.stdout, /\+ expected.*- actual/); assert(!result.stdout.includes("TypeError"));
});
test("root Mocha parallel workers preserve serialized root hooks", t => {
  const dir = fixture(t, {
    "hooks.cjs": "exports.mochaHooks={beforeAll:function(){globalThis.__proofWorkRootHook='active'}};",
    "first.cjs": "const assert=require('node:assert/strict');describe('first worker',()=>{it('uses root hook',()=>assert.equal(globalThis.__proofWorkRootHook,'active'))});",
    "second.cjs": "const assert=require('node:assert/strict');describe('second worker',()=>{it('uses root hook',()=>assert.equal(globalThis.__proofWorkRootHook,'active'))});"
  });
  passed(run(mocha, ["--parallel", "--jobs", "2", "--require", join(dir, "hooks.cjs"), "--reporter", "json", join(dir, "first.cjs"), join(dir, "second.cjs")]), 2);
});
test("root Mocha watch mode reruns after a controlled file edit", { timeout: 15000 }, async t => {
  const dir = fixture(t, { "watched.cjs": "describe('watch fixture',()=>{it('passes',()=>{})});" }), file = join(dir, "watched.cjs");
  const child = spawn(process.execPath, [mocha, "--watch", "--watch-files", file, "--no-color", "--reporter", "spec", file],
    { cwd: root, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGTERM"));
  await new Promise((resolve, reject) => {
    let output = "", errors = "", edited = false;
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(Error("watch did not rerun: " + output + errors)); }, 10000);
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.stderr.on("data", c => { errors += c; });
    child.stdout.on("data", c => {
      output += c;
      if (!edited && /1 passing/.test(output)) { edited = true; appendFileSync(file, "\n// controlled watch update\n"); }
      if ((output.match(/1 passing/g) ?? []).length >= 2) { clearTimeout(timer); child.kill("SIGTERM"); resolve(); }
    });
    child.on("exit", code => { if ((output.match(/1 passing/g) ?? []).length < 2) { clearTimeout(timer); reject(Error("watch exited before rerun: " + code + output + errors)); } });
  });
});
