import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey, Transaction } from "@solana/web3.js";
import { DevnetBlockhashSource, BlockhashSourceError, DEVNET_RPC, DEVNET_GENESIS } from "../src/devnet-blockhash.js";
import type { Fetcher } from "../src/http.js";
import { AttestationAuthorizer, buildAttestMilestoneInstruction } from "../src/attestation.js";
import { AttestationTransactionPolicy } from "../src/transaction-policy.js";
import { DevnetAttestationReader } from "../src/attestation-chain.js";
import { VerifierService } from "../src/service.js";
import { GitHub } from "../src/github.js";
import { CASES } from "../src/manifest.js";
import { fixture, githubFetch, TOKEN } from "./helpers.js";

const HASH = new PublicKey(Buffer.alloc(32, 177)).toBase58(); // Synthetic hash, no keys.
/** Matches the provider's explicit failure reason, excluding unrelated exceptions. */
const code = (reason: string) => (error: unknown) => error instanceof BlockhashSourceError && error.code === reason;
/** Supplies strict JSON-RPC fixtures while recording only public request metadata. */
function mock(patch: Record<string, unknown> = {}) {
  const calls: { jsonrpc: string; id: string; method: string; params: unknown[] }[] = [];
  const results: Record<string, unknown> = {
    getGenesisHash: DEVNET_GENESIS,
    getLatestBlockhash: { context: { slot: 100 }, value: { blockhash: HASH, lastValidBlockHeight: 200 } },
    isBlockhashValid: { context: { slot: 101 }, value: true }, getBlockHeight: 150, ...patch,
  };
  const request: Fetcher = async (url, init) => {
    assert.equal(url, DEVNET_RPC); assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    const body = JSON.parse(String(init?.body)) as { jsonrpc: string; id: string; method: string; params: unknown[] };
    assert.ok(Object.hasOwn(results, body.method)); calls.push(body);
    const value = results[body.method];
    return value instanceof Response ? value : Response.json({ jsonrpc: "2.0", id: body.id, result: value });
  };
  return { request, calls, results };
}

test("provider verifies Devnet, canonical hash, validity and height with confirmed slot bounds", async () => {
  const f = mock(); const source = new DevnetBlockhashSource(f.request, () => 123);
  assert.deepEqual(await source.read(), { rpc: DEVNET_RPC, genesisHash: DEVNET_GENESIS, blockhash: HASH,
    lastValidBlockHeight: 200, currentBlockHeight: 150, observedAtMs: 123, valid: true });
  assert.deepEqual(f.calls, [
    { jsonrpc: "2.0", id: "getGenesisHash", method: "getGenesisHash", params: [] },
    { jsonrpc: "2.0", id: "getLatestBlockhash", method: "getLatestBlockhash", params: [{ commitment: "confirmed" }] },
    { jsonrpc: "2.0", id: "isBlockhashValid", method: "isBlockhashValid", params: [HASH, { commitment: "confirmed", minContextSlot: 100 }] },
    { jsonrpc: "2.0", id: "getBlockHeight", method: "getBlockHeight", params: [{ commitment: "confirmed", minContextSlot: 101 }] },
  ]);
});
test("provider pins one lease, revalidates each read and isolates mutable returned objects", async () => {
  const f = mock(), source = new DevnetBlockhashSource(f.request, () => 100);
  const first = await source.read(); first.blockhash = "caller-mutation";
  f.results.getBlockHeight = 151;
  const second = await source.read(); assert.equal(second.blockhash, HASH); assert.equal(second.currentBlockHeight, 151);
  assert.equal(f.calls.filter(c => c.method === "getLatestBlockhash").length, 1);
  assert.equal(f.calls.filter(c => c.method === "getGenesisHash").length, 2);
  assert.equal(f.calls.filter(c => c.method === "isBlockhashValid").length, 2);
});
test("concurrent reads share a verified observation but not mutable result objects", async () => {
  const f = mock(), source = new DevnetBlockhashSource(f.request, () => 100);
  const [a, b] = await Promise.all([source.read(), source.read()]);
  assert.notEqual(a, b); assert.deepEqual(a, b); assert.equal(f.calls.length, 4);
});
test("wrong cluster fails before blockhash requests", async () => {
  const f = mock({ getGenesisHash: "unexpected-cluster" });
  await assert.rejects(new DevnetBlockhashSource(f.request).read(), code("wrong_cluster"));
  assert.equal(f.calls.length, 1);
});
for (const [name, latest, reason] of [
  ["missing value", { context: { slot: 100 } }, "invalid_rpc_response"],
  ["bad hash", { context: { slot: 100 }, value: { blockhash: "bad!", lastValidBlockHeight: 200 } }, "invalid_blockhash"],
  ["missing hash", { context: { slot: 100 }, value: { lastValidBlockHeight: 200 } }, "invalid_blockhash"],
  ["unsafe expiry", { context: { slot: 100 }, value: { blockhash: HASH, lastValidBlockHeight: Number.MAX_SAFE_INTEGER + 1 } }, "invalid_rpc_response"],
  ["fractional slot", { context: { slot: 1.5 }, value: { blockhash: HASH, lastValidBlockHeight: 200 } }, "invalid_rpc_response"],
  ["string expiry", { context: { slot: 100 }, value: { blockhash: HASH, lastValidBlockHeight: "200" } }, "invalid_rpc_response"],
] as const) {
  test("rejects latest-blockhash data: " + name, async () => {
    await assert.rejects(new DevnetBlockhashSource(mock({ getLatestBlockhash: latest }).request).read(), code(reason));
  });
}
for (const [name, valid, reason] of [
  ["false", { context: { slot: 101 }, value: false }, "expired_blockhash"],
  ["string boolean", { context: { slot: 101 }, value: "true" }, "invalid_rpc_response"],
  ["regressing context", { context: { slot: 99 }, value: true }, "inconsistent_rpc_response"],
  ["missing context", { value: true }, "invalid_rpc_response"],
] as const) {
  test("rejects blockhash validity data: " + name, async () => {
    await assert.rejects(new DevnetBlockhashSource(mock({ isBlockhashValid: valid }).request).read(), code(reason));
  });
}
for (const [height, reason] of [[200, "expired_blockhash"], [201, "expired_blockhash"], [-1, "invalid_rpc_response"], [1.5, "invalid_rpc_response"], ["150", "invalid_rpc_response"], [null, "invalid_rpc_response"]] as const) {
  test("rejects invalid/expired height: " + String(height), async () => {
    await assert.rejects(new DevnetBlockhashSource(mock({ getBlockHeight: height }).request).read(), code(reason));
  });
}
test("rejects height regression across reads", async () => {
  const f = mock(), source = new DevnetBlockhashSource(f.request);
  await source.read(); f.results.getBlockHeight = 149;
  await assert.rejects(source.read(), code("inconsistent_rpc_response"));
});
test("invalid pinned hash fails that read before a later call can acquire a new lease", async () => {
  const f = mock(), source = new DevnetBlockhashSource(f.request);
  await source.read(); f.results.isBlockhashValid = { context: { slot: 102 }, value: false };
  await assert.rejects(source.read(), code("expired_blockhash"));
  f.results.isBlockhashValid = { context: { slot: 102 }, value: true };
  assert.equal((await source.read()).blockhash, HASH);
  assert.equal(f.calls.filter(c => c.method === "getLatestBlockhash").length, 2);
});
for (const [label, response, reason] of [
  ["HTTP failure", () => new Response("", { status: 503 }), "rpc_failure"],
  ["malformed JSON", () => new Response("{"), "invalid_rpc_response"],
  ["JSON-RPC error", () => Response.json({ jsonrpc: "2.0", id: "getGenesisHash", error: { code: -1 } }), "invalid_rpc_response"],
  ["wrong ID", () => Response.json({ jsonrpc: "2.0", id: "wrong", result: DEVNET_GENESIS }), "invalid_rpc_response"],
  ["wrong version", () => Response.json({ jsonrpc: "1.0", id: "getGenesisHash", result: DEVNET_GENESIS }), "invalid_rpc_response"],
  ["oversize body", () => new Response("x".repeat(16_385)), "invalid_rpc_response"],
  ["null envelope", () => Response.json(null), "invalid_rpc_response"],
] as const) {
  test("fails closed on " + label, async () => {
    await assert.rejects(new DevnetBlockhashSource(async () => response()).read(), code(reason));
  });
}
for (const method of ["getGenesisHash", "getLatestBlockhash", "isBlockhashValid", "getBlockHeight"]) {
  test("transport failure at " + method + " never returns an observation", async () => {
    const f = mock();
    const request: Fetcher = async (url, init) => {
      if (JSON.parse(String(init?.body)).method === method) throw new Error("transport-detail-not-exposed");
      return f.request(url, init);
    };
    await assert.rejects(new DevnetBlockhashSource(request).read(), code("rpc_failure"));
  });
}
test("whole-read timeout handles an unresponsive fetch and prevents late lease installation", async () => {
  let release!: (r: Response) => void;
  const f = mock(); let first = true;
  const request: Fetcher = async (url, init) => {
    if (first) { first = false; return new Promise<Response>(resolve => { release = resolve; }); }
    return f.request(url, init);
  };
  const source = new DevnetBlockhashSource(request, () => 100, 100);
  await assert.rejects(source.read(), code("rpc_timeout"));
  release(Response.json({ jsonrpc: "2.0", id: "getGenesisHash", result: DEVNET_GENESIS }));
  assert.equal((await source.read()).blockhash, HASH);
});
test("whole-read timeout also bounds stalled response bodies", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(c) { stream = c; } }));
  await assert.rejects(new DevnetBlockhashSource(async () => response, () => 0, 30).read(), code("rpc_timeout"));
  stream.close();
});
test("observation timestamp is captured before RPC work, not refreshed after it", async () => {
  const f = mock(); let time = 100;
  const request: Fetcher = async (url, init) => { time += 10; return f.request(url, init); };
  const result = await new DevnetBlockhashSource(request, () => time).read();
  assert.equal(result.observedAtMs, 100); assert.equal(time, 140);
});
test("invalid/backwards clocks and invalid timeout configuration fail closed", async () => {
  const f = mock();
  await assert.rejects(new DevnetBlockhashSource(f.request, () => NaN).read(), code("invalid_clock"));
  let time = 100;
  const request: Fetcher = async (url, init) => { time = 99; return f.request(url, init); };
  await assert.rejects(new DevnetBlockhashSource(request, () => time).read(), code("invalid_clock"));
  assert.throws(() => new DevnetBlockhashSource(f.request, undefined, 0), code("invalid_timeout"));
});
test("real provider implementation remains compatible with offline policy lease consumption", async () => {
  const f = fixture(), clock = () => 100, source = new DevnetBlockhashSource(mock().request, clock);
  const chain = new DevnetAttestationReader(DEVNET_RPC, f.verifier.toBase58(), f.rpc);
  const service = new VerifierService(new GitHub(githubFetch()), chain, { run: async () => CASES.map(c => ({ id: c.id, passed: true })) });
  const authorizer = new AttestationAuthorizer(service, chain, f.verifier.toBase58(), clock);
  const payer = new PublicKey(f.i.subarray(8, 40));
  const policy = new AttestationTransactionPolicy(authorizer, chain, source,
    { verifier: f.verifier.toBase58(), feePayer: payer.toBase58(), maxAgeMs: 5000, minRemainingBlockHeights: 10 }, clock);
  const observed = await source.read();
  const tx = new Transaction({ feePayer: payer, recentBlockhash: observed.blockhash })
    .add(buildAttestMilestoneInstruction(await chain.read(f.request.milestone), f.verifier.toBase58()));
  const ticket = await authorizer.prepare(f.request, TOKEN);
  const approval = await policy.authorize(ticket, tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
  assert.deepEqual(await policy.consume(approval), tx.serializeMessage());
});


test("HTTP failures cancel unread response bodies and abort settled RPC resources", async () => {
  let cancelled = false;
  let signal: AbortSignal | null | undefined;
  const request: Fetcher = async (_url, init) => {
    signal = init?.signal;
    return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { status: 503 });
  };
  const source = new DevnetBlockhashSource(request);
  await assert.rejects(source.read(), code("rpc_failure"));
  assert.equal(cancelled, true);
  assert.equal(signal?.aborted, true);
});
