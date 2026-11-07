import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { DevnetReader } from "../src/chain.js";
import { PROGRAM_ID, key, sha256 } from "../src/commitments.js";
import { VerificationError, object } from "../src/errors.js";
import { jsonResponse, type Fetcher } from "../src/http.js";

const RPC = "https://api.devnet.solana.com";
const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const allowed = new Set(["getHealth", "getGenesisHash", "getAccountInfo", "getProgramAccounts", "getMultipleAccounts"]);
let requests = 0;
const request: Fetcher = async (url, init) => {
  assert.equal(String(url), RPC);
  assert.equal(init?.method, "POST");
  assert.equal(init?.redirect, "error");
  assert.ok(allowed.has(String(object(JSON.parse(String(init?.body))).method)));
  requests++;
  return fetch(url, init);
};
async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const response = await request(RPC, { method: "POST", redirect: "error",
    headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (!response.ok) throw new Error("rpc_http_failure");
  const result = object(await jsonResponse(response));
  if (result.error || !("result" in result)) throw new Error("rpc_response_failure");
  return result.result;
}
const config = { encoding: "base64", commitment: "confirmed" };
async function account(address: string): Promise<unknown> {
  return object(await rpc("getAccountInfo", [address, config])).value;
}
async function rejects(read: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(read(), (error: unknown) => error instanceof VerificationError && error.code === code);
}
function bytes(value: unknown): Buffer {
  const a = object(value);
  assert.equal(a.owner, PROGRAM_ID.toBase58()); assert.equal(a.executable, false);
  assert.ok(Array.isArray(a.data)); assert.equal(a.data[1], "base64");
  const data = Buffer.from(String(a.data[0]), "base64");
  assert.equal(data.toString("base64"), a.data[0]);
  return data;
}
async function live(): Promise<void> {
  assert.equal(await rpc("getHealth"), "ok");
  console.log("PASS: Official Devnet RPC connectivity.");
  assert.equal(await rpc("getGenesisHash"), GENESIS);
  console.log("PASS: Devnet genesis identity " + GENESIS);
  const program = await account(PROGRAM_ID.toBase58());
  if (program === null) console.log("BLOCKED: No deployed ProofOfWork program.");
  else {
    const p = object(program);
    console.log("OBSERVED: Program executable=" + String(p.executable) + " owner=" + String(p.owner));
    assert.equal(p.executable, true);
    assert.ok(["BPFLoaderUpgradeab1e11111111111111111111111", "BPFLoader2111111111111111111111111111111111", "BPFLoader1111111111111111111111111111111111", "LoaderV411111111111111111111111111111111111"].includes(String(p.owner)));
    console.log("PASS: Executable program owned by a recognized Solana loader (not an artifact/upgrade-authority audit).");
  }
  const state = await rpc("getProgramAccounts", [PROGRAM_ID.toBase58(), { ...config, dataSlice: { offset: 0, length: 0 } }]);
  assert.ok(Array.isArray(state));
  console.log("OBSERVED: Program-owned account count=" + state.length);

  // Program ID is only a non-secret sentinel for negatives, never a configured verifier.
  const sentinel = PROGRAM_ID.toBase58();
  const before = requests;
  await rejects(() => new DevnetReader(undefined, undefined, request).read(sentinel), "missing_onchain_state");
  await rejects(() => new DevnetReader(RPC, undefined, request).read(sentinel), "missing_onchain_state");
  await rejects(() => new DevnetReader(RPC, sentinel, request).read("invalid-public-key!"), "invalid_onchain_state");
  assert.equal(requests, before);
  console.log("PASS: Missing configuration and invalid address fail closed before RPC (local guards).");

  // An explicitly synthetic PDA probe; no wallet/keypair or blockchain fixture is created.
  const [probe] = PublicKey.findProgramAddressSync([Buffer.from("live-devnet-missing-probe-v1")], PROGRAM_ID);
  if (await account(probe.toBase58()) === null) {
    const start = requests;
    await rejects(() => new DevnetReader(RPC, sentinel, request).read(probe.toBase58()), "missing_onchain_state");
    assert.ok(requests > start);
    console.log("PASS: Real missing milestone account rejected through live DevnetReader RPC.");
  } else console.log("SKIPPED: Missing-account probe exists; not treated as an absent account.");
  if (state.length === 0) console.log("PASS: Live inventory confirms absent program-owned state; no positive validation inferred.");

  const address = process.env.LIVE_MILESTONE_ADDRESS;
  const verifier = process.env.VERIFIER_PUBLIC_KEY;
  if (!address && !verifier) {
    console.log("BLOCKED: No live Submitted milestone fixture.");
    console.log("SKIPPED: Positive account validation; supply LIVE_MILESTONE_ADDRESS and VERIFIER_PUBLIC_KEY.");
    return;
  }
  assert.ok(address && verifier, "Supply both public fixture settings");
  key(address); key(verifier);
  if (program === null) {
    console.log("BLOCKED: No live Submitted milestone fixture.");
    throw new Error("positive_fixture_program_absent");
  }
  const result = await new DevnetReader(RPC, verifier, request).read(address);
  const m = bytes(await account(address));
  const parent = new PublicKey(m.subarray(8, 40)).toBase58();
  const [submission] = PublicKey.findProgramAddressSync([Buffer.from("submission"), key(address).toBuffer()], PROGRAM_ID);
  const batch = object(await rpc("getMultipleAccounts", [[address, submission.toBase58(), parent], config])).value;
  assert.ok(Array.isArray(batch) && batch.length === 3);
  const [milestone, submitted, internship] = batch.map(bytes);
  assert.ok(milestone && submitted && internship);
  assert.equal(result.milestone, address);
  assert.equal(result.submission, submission.toBase58());
  assert.equal(result.student, new PublicKey(milestone.subarray(72, 104)).toBase58());
  assert.equal(result.verifier, verifier);
  assert.equal(new PublicKey(milestone.subarray(104, 136)).toBase58(), verifier);
  assert.equal(result.requirementsHash, milestone.subarray(200, 232).toString("hex"));
  assert.equal(result.evidenceHash, submitted.subarray(72, 104).toString("hex"));
  assert.match(result.requirementsHash, /^[0-9a-f]{64}$/);
  assert.match(result.evidenceHash, /^[0-9a-f]{64}$/);
  assert.equal(result.snapshot, sha256(Buffer.concat([milestone, submitted, internship])).toString("hex"));
  console.log("PASS: Supplied live Submitted fixture bindings, commitments and snapshot; no signing or transactions.");
}
if (process.env.LIVE_DEVNET !== "1") {
  console.log("SKIPPED: Live Devnet tests require LIVE_DEVNET=1; no RPC calls made.");
} else {
  try { await live(); }
  catch (error) {
    console.error("FAIL: Live Devnet validation: " + (error instanceof VerificationError ? error.code : "rpc_configuration_or_assertion_failure"));
    process.exitCode = 1;
  }
}
