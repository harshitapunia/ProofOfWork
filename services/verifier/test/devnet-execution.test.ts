import { test, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { PublicKey, Transaction } from "@solana/web3.js";
import { DevnetExecutionWorkflow, ExecutionError, transactionId, type ExecutionConfig, type ExecutionTransport } from "../src/devnet-execution.js";
import { DisabledDevnetExecutionRpc } from "../src/devnet-execution-rpc.js";
import { AttestationError } from "../src/attestation.js";
import { DevnetAttestationReader } from "../src/attestation-chain.js";
import { GitHub } from "../src/github.js";
import { VerifierService } from "../src/service.js";
import { DEVNET_RPC, DEVNET_GENESIS } from "../src/devnet-blockhash.js";
import { CASES } from "../src/manifest.js";
import { fixture, githubFetch, TOKEN } from "./helpers.js";

/** No keys or signing: synthetic signatures, mocked Ed25519 verification and mocked transport only. */
function setup() {
  const f = fixture(); let time = 0, signs = 0, submits = 0, checks = 0;
  const chain = new DevnetAttestationReader(DEVNET_RPC, f.verifier.toBase58(), f.rpc);
  const service = new VerifierService(new GitHub(githubFetch()), chain,
    { run: async () => CASES.map(c => ({ id: c.id, passed: true })) });
  const config: ExecutionConfig = { mode: "test-only", verifier: f.verifier.toBase58(),
    feePayer: new PublicKey(f.i.subarray(8, 40)).toBase58(), maxAgeMs: 5000, minRemainingBlockHeights: 10,
    maxFeeLamports: 10_000, timeoutMs: 100 };
  const received: Buffer[] = [];
  const signer = (publicKey: string) => ({ mode: "test-only" as const, publicKey,
    signMessage: async (message: Uint8Array) => { signs++; received.push(Buffer.from(message)); return Buffer.alloc(64, 7); } });
  const verifier = signer(config.verifier), payer = signer(config.feePayer);
  const transport: ExecutionTransport = { mode: "test-only", rpc: DEVNET_RPC,
    genesis: async () => DEVNET_GENESIS, fee: async () => 10_000, valid: async () => true,
    submit: async wire => { submits++; const tx = Transaction.from(wire);
      assert.deepEqual(tx.serializeMessage(), received[0]); return transactionId(tx.signature!); },
    status: async () => { checks++; return "confirmed"; } };
  const blockhashes = { read: async () => ({ rpc: DEVNET_RPC as typeof DEVNET_RPC, genesisHash: DEVNET_GENESIS,
    blockhash: new PublicKey(Buffer.alloc(32, 177)).toBase58(), lastValidBlockHeight: 200,
    currentBlockHeight: 100, observedAtMs: time, valid: true }) };
  const create = (v: typeof verifier | undefined = verifier, p: typeof payer | undefined = payer) =>
    new DevnetExecutionWorkflow(service, chain, config, v, p, transport, blockhashes, () => time);
  return { ...f, config, verifier, payer, transport, blockhashes, received, create,
    counts: () => ({ signs, submits, checks }), clock: (n: number) => { time = n; } };
}
const code = (reason: string) => (e: unknown) => e instanceof ExecutionError && e.code === reason;
/** Replaces verification ONLY in tests; production always verifies Ed25519 signatures using node:crypto. */
function syntheticVerification(t: { after(fn: () => void): void }) {
  const handle = mock.method(crypto, "verify", () => true); t.after(() => handle.mock.restore());
}

test("test-only workflow signs identical authorized messages and confirms once; replay denied", async t => {
  syntheticVerification(t); const f = setup(), workflow = f.create();
  await workflow.execute(f.request, TOKEN);
  assert.deepEqual(f.counts(), { signs: 2, submits: 1, checks: 1 });
  assert.deepEqual(f.received[0], f.received[1]);
  await assert.rejects(workflow.execute(f.request, TOKEN), e => e instanceof AttestationError && e.code === "duplicate_authorization");
});
test("disabled configuration invokes neither verification nor signing nor submission", async () => {
  const f = setup(); f.config.mode = "disabled";
  await assert.rejects(f.create().execute(f.request, TOKEN), code("live_execution_disabled"));
  assert.deepEqual(f.counts(), { signs: 0, submits: 0, checks: 0 });
});
for (const role of ["verifier", "payer"] as const) {
  test("rejects incorrect " + role + " identity", async () => {
    const f = setup(); f[role].publicKey = f.request.student;
    await assert.rejects(f.create().execute(f.request, TOKEN), code(role === "payer" ? "incorrect_fee_payer" : "incorrect_verifier"));
    assert.equal(f.counts().signs, 0);
  });
}
test("missing signing authority fails closed", async () => {
  const f = setup();
  // Construct explicitly: default arguments are intentionally bypassed using a typed missing adapter.
  const workflow = new DevnetExecutionWorkflow({ verify: async () => { throw new Error("must_not_run"); } },
    new DevnetAttestationReader(DEVNET_RPC, f.config.verifier, f.rpc), f.config, undefined, f.payer, f.transport, f.blockhashes);
  await assert.rejects(workflow.execute(f.request, TOKEN), code("missing_signing_authority"));
});
for (const fee of [null, 10_001, -1, 1.5, NaN]) {
  test("rejects unavailable/invalid/excess fee " + String(fee), async () => {
    const f = setup(); f.transport.fee = async () => fee;
    await assert.rejects(f.create().execute(f.request, TOKEN), code("fee_limit_exceeded"));
    assert.equal(f.counts().signs, 0);
  });
}
test("expired blockhash prevents signing", async () => {
  const f = setup(); f.transport.valid = async () => false;
  await assert.rejects(f.create().execute(f.request, TOKEN), code("expired_blockhash"));
  assert.equal(f.counts().signs, 0);
});
test("invalid signatures and signer-mutated messages cannot be submitted", async () => {
  const f = setup(); f.payer.signMessage = async message => { message.fill(0); return Buffer.alloc(64, 1); };
  await assert.rejects(f.create().execute(f.request, TOKEN), code("invalid_signature"));
  assert.equal(f.counts().submits, 0);
});
test("changed signer identity after await prevents submission", async t => {
  syntheticVerification(t); const f = setup();
  f.payer.signMessage = async () => { f.verifier.publicKey = f.request.student; return Buffer.alloc(64, 7); };
  await assert.rejects(f.create().execute(f.request, TOKEN), code("incorrect_verifier"));
  assert.equal(f.counts().submits, 0);
});
for (const outcome of ["failed", "unknown", "throws"] as const) {
  test("confirmation " + outcome + " burns authorization", async t => {
    syntheticVerification(t); const f = setup();
    f.transport.status = async () => { if (outcome === "throws") throw new Error("rpc"); return outcome; };
    const workflow = f.create();
    await assert.rejects(workflow.execute(f.request, TOKEN), code(outcome === "failed" ? "transaction_failed" : "confirmation_uncertain"));
    await assert.rejects(workflow.execute(f.request, TOKEN), e => e instanceof AttestationError && e.code === "duplicate_authorization");
    assert.equal(f.counts().signs, 2);
  });
}
for (const kind of ["failure", "substitution", "timeout"] as const) {
  test("submission " + kind + " is uncertain, never automatically retried", async t => {
    syntheticVerification(t); const f = setup();
    f.transport.submit = async () => { if (kind === "failure") throw new Error("rpc");
      if (kind === "timeout") return new Promise<string>(() => {}); return "wrong-signature"; };
    const workflow = f.create();
    await assert.rejects(workflow.execute(f.request, TOKEN), code("submission_uncertain"));
    await assert.rejects(workflow.execute(f.request, TOKEN), e => e instanceof AttestationError && e.code === "duplicate_authorization");
  });
}
test("signer timeout burns authorization without submission", async () => {
  const f = setup(); f.payer.signMessage = async () => new Promise<Buffer<ArrayBuffer>>(() => {});
  await assert.rejects(f.create().execute(f.request, TOKEN), code("signing_failed"));
  assert.equal(f.counts().submits, 0);
});
test("fee and blockhash rechecked after signing before submission", async t => {
  syntheticVerification(t); const f = setup(); let validReads = 0;
  f.transport.valid = async () => ++validReads === 1;
  await assert.rejects(f.create().execute(f.request, TOKEN), code("expired_blockhash"));
  assert.equal(f.counts().signs, 2); assert.equal(f.counts().submits, 0);
});
test("read-only RPC preparation and submission hard-disable", async () => {
  const calls: string[] = [];
  const rpc = new DisabledDevnetExecutionRpc(async (url, init) => {
    assert.equal(url, DEVNET_RPC); assert.equal(init?.redirect, "error");
    const body = JSON.parse(String(init?.body)); calls.push(body.method);
    const values: Record<string, unknown> = { getGenesisHash: DEVNET_GENESIS,
      getFeeForMessage: { context: { slot: 100 }, value: 10_000 },
      isBlockhashValid: { context: { slot: 100 }, value: true },
      getSignatureStatuses: { context: { slot: 100 }, value: [{ slot: 99, confirmations: 1, err: null, confirmationStatus: "confirmed" }] } };
    return Response.json({ jsonrpc: "2.0", id: body.id, result: values[body.method] });
  });
  assert.equal(await rpc.genesis(), DEVNET_GENESIS); assert.equal(await rpc.fee(Buffer.of(1)), 10_000);
  assert.equal(await rpc.valid("synthetic"), true); assert.equal(await rpc.status("synthetic"), "confirmed");
  await assert.rejects(rpc.submit(Buffer.of(1)), code("live_execution_disabled"));
  assert.ok(!calls.includes("sendTransaction"));
});
test("malformed/read-only RPC errors fail closed", async () => {
  const rpc = new DisabledDevnetExecutionRpc(async () => Response.json({ jsonrpc: "2.0", id: "wrong", result: true }));
  await assert.rejects(rpc.genesis(), code("rpc_failure"));
});

for (const issue of ["cluster", "rpc"] as const) {
  test("wrong cluster or failed RPC cannot reach signing: " + issue, async () => {
    const f = setup(); f.transport.genesis = async () => { if (issue === "rpc") throw new Error("rpc"); return "wrong"; };
    await assert.rejects(f.create().execute(f.request, TOKEN), code(issue === "rpc" ? "rpc_failure" : "wrong_cluster"));
    assert.equal(f.counts().signs, 0);
  });
}
test("fee increase after signing blocks submission", async t => {
  syntheticVerification(t); const f = setup(); let quotes = 0;
  f.transport.fee = async () => ++quotes === 1 ? 10_000 : 10_001;
  await assert.rejects(f.create().execute(f.request, TOKEN), code("fee_limit_exceeded"));
  assert.equal(f.counts().submits, 0);
});
test("concurrent duplicate executions allow only one handoff", async t => {
  syntheticVerification(t); const f = setup(), workflow = f.create();
  const outcomes = await Promise.allSettled([workflow.execute(f.request, TOKEN), workflow.execute(f.request, TOKEN)]);
  assert.equal(outcomes.filter(o => o.status === "fulfilled").length, 1);
  const failed = outcomes.find(o => o.status === "rejected"); assert.ok(failed?.status === "rejected");
  assert.ok(failed.reason instanceof AttestationError && failed.reason.code === "duplicate_authorization");
  assert.equal(f.counts().submits, 1);
});
test("caller-supplied transaction or approval rejected before signing", async () => {
  const f = setup();
  await assert.rejects(f.create().execute({ ...f.request, approved: true, message: Buffer.of(1) }, TOKEN),
    e => e instanceof AttestationError && e.code === "verification_failed");
  assert.equal(f.counts().signs, 0);
});
test("changed blockchain state during policy observation prevents signing", async () => {
  const f = setup(); let calls = 0; const read = f.blockhashes.read;
  f.blockhashes.read = async () => { if (++calls === 2) f.m[272] = 4; return read(); };
  await assert.rejects(f.create().execute(f.request, TOKEN), e => e instanceof Error && e.message === "invalid_onchain_state");
  assert.equal(f.counts().signs, 0);
});


test("concrete adapter has no externally callable arbitrary-RPC helper", async () => {
  const rpc = new DisabledDevnetExecutionRpc(async () => { throw new Error("must_not_fetch"); });
  assert.equal(Reflect.get(rpc, "call"), undefined);
  await assert.rejects(rpc.submit(Buffer.of(1)), code("live_execution_disabled"));
});
for (const [name, status] of [
  ["missing slot", { err: null, confirmations: 1, confirmationStatus: "confirmed" }],
  ["missing confirmations", { slot: 99, err: null, confirmationStatus: "confirmed" }],
  ["negative slot", { slot: -1, err: null, confirmations: 1, confirmationStatus: "confirmed" }],
  ["slot exceeds context", { slot: 101, err: null, confirmations: 1, confirmationStatus: "confirmed" }],
  ["fractional confirmations", { slot: 99, err: null, confirmations: 0.5, confirmationStatus: "confirmed" }],
  ["unknown status", { slot: 99, err: null, confirmations: 1, confirmationStatus: "unexpected" }],
] as const) {
  test("malformed confirmation cannot report success: " + name, async () => {
    const rpc = new DisabledDevnetExecutionRpc(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { context: { slot: 100 }, value: [status] } });
    });
    await assert.rejects(rpc.status("synthetic"), code("rpc_failure"));
  });
}

for (const [name, status, expected] of [
  ["absent", null, "unknown"],
  ["processed", { slot: 99, confirmations: 0, err: null, confirmationStatus: "processed" }, "unknown"],
  ["finalized", { slot: 99, confirmations: null, err: null, confirmationStatus: "finalized" }, "confirmed"],
  ["failed", { slot: 99, confirmations: 1, err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" }, "failed"],
] as const) {
  test("concrete RPC classifies valid status: " + name, async () => {
    const rpc = new DisabledDevnetExecutionRpc(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { context: { slot: 100 }, value: [status] } });
    });
    assert.equal(await rpc.status("synthetic"), expected);
  });
}
