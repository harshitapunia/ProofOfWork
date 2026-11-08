// Optional offline Rust cross-check; no program source, accounts, keys or RPC state are changed.
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "proofwork-finance-abi-"));
try {
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/main.rs"), readFileSync(new URL("rust-abi.rs", import.meta.url)));
  writeFileSync(join(dir, "Cargo.lock"), readFileSync(join(repo, "Cargo.lock")));
  writeFileSync(join(dir, "Cargo.toml"), `[package]
name="proofwork-finance-abi-check"
version="0.0.0"
edition="2021"
[dependencies]
anchor-lang="=1.2.2"
anchor-spl={version="=1.2.2",default-features=false,features=["associated_token","solana-v3"]}
proof_of_work={path=${JSON.stringify(join(repo,"programs/proof_of_work"))},features=["no-entrypoint"]}
`);
  const run = spawnSync("cargo", ["run", "--offline", "--quiet", "--manifest-path", join(dir,"Cargo.toml")], {
    encoding:"utf8", timeout:180000, maxBuffer:2_000_000,
    env:{...process.env,CARGO_TARGET_DIR:join(repo,"target/finance-client-abi")}
  });
  if (run.status !== 0) throw new Error("Rust ABI exporter failed: " + (run.stderr || run.error?.message));
  const actual = JSON.parse(run.stdout);
  const fixture = new URL("rust-abi.json", import.meta.url);
  if (process.argv.includes("--write-fixture")) writeFileSync(fixture, JSON.stringify(actual,null,2)+"\n");
  else assert.deepEqual(actual, JSON.parse(readFileSync(fixture,"utf8")));
  console.log("PASS: compiled Rust ABI, account permissions, canonical PDAs and ATA match the offline fixtures.");
} finally { rmSync(dir,{recursive:true,force:true}); }
