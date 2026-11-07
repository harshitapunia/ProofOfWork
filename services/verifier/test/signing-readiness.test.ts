import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import { LocalTestSigner } from "./local-test-signer.js";
import { readFile, access } from "node:fs/promises";
import { DevnetExecutionWorkflow, ExecutionError, transactionId, type ExecutionConfig, type ExecutionTransport, type TestMessageSigner } from "../src/devnet-execution.js";
import { DisabledDevnetExecutionRpc } from "../src/devnet-execution-rpc.js";
import { DevnetAttestationReader } from "../src/attestation-chain.js";
import { AttestationAuthorizer, AttestationError, buildAttestMilestoneInstruction } from "../src/attestation.js";
import { AttestationTransactionPolicy, TransactionPolicyError } from "../src/transaction-policy.js";
import { VerifierService } from "../src/service.js";
import { GitHub } from "../src/github.js";
import { CASES } from "../src/manifest.js";
import { DEVNET_RPC, DEVNET_GENESIS } from "../src/devnet-blockhash.js";
import { fixture, githubFetch, TOKEN } from "./helpers.js";

/** Generates disposable keys ONLY in memory, with no seed constants, wallet files or secret exports. */
function disposable() { return new LocalTestSigner(crypto.generateKeyPairSync("ed25519").privateKey); }
/** Real signatures and verification; mocked chain, GitHub, sandbox and transport. No network or crypto mocks. */
async function setup() {
  const f = fixture(), verifier = disposable(), payer = disposable();
  new PublicKey(verifier.publicKey).toBuffer().copy(f.m, 104);
  let time = 0, reads = 0;
  let onRead = (_n: number) => {};
  const chain = new DevnetAttestationReader(DEVNET_RPC, verifier.publicKey, f.rpc);
  const service = new VerifierService(new GitHub(githubFetch()), chain,
    { run: async () => CASES.map(c => ({ id: c.id, passed: true })) });
  const config: ExecutionConfig = { mode: "test-only", verifier: verifier.publicKey, feePayer: payer.publicKey,
    maxAgeMs: 5000, minRemainingBlockHeights: 10, maxFeeLamports: 10_000, timeoutMs: 1000 };
  const observation = { rpc: DEVNET_RPC as typeof DEVNET_RPC, genesisHash: DEVNET_GENESIS,
    blockhash: new PublicKey(Buffer.alloc(32, 177)).toBase58(), lastValidBlockHeight: 200,
    currentBlockHeight: 100, observedAtMs: 0, valid: true };
  const blockhashes = { read: async () => { onRead(++reads); return { ...observation }; } };
  const expected = new Transaction({ feePayer: new PublicKey(payer.publicKey), recentBlockhash: observation.blockhash })
    .add(buildAttestMilestoneInstruction(await chain.read(f.request.milestone), verifier.publicKey));
  const messages: Buffer[] = [], wires: Buffer[] = [];
  const wrap = (signer: LocalTestSigner): TestMessageSigner => ({ mode: "test-only", publicKey: signer.publicKey,
    signMessage: async message => { messages.push(Buffer.from(message)); return signer.signMessage(message); } });
  const v = wrap(verifier), p = wrap(payer);
  const transport: ExecutionTransport = { mode: "test-only", rpc: DEVNET_RPC, genesis: async () => DEVNET_GENESIS,
    fee: async () => 10_000, valid: async () => true,
    submit: async wire => { // Local assertion sink only: never sends a transaction to any network.
      const tx = Transaction.from(wire);
      assert.deepEqual(tx.serializeMessage(), expected.serializeMessage());
      assert.equal(tx.signatures.length, 2);
      assert.equal(tx.verifySignatures(true), true);
      assert.deepEqual(tx.serialize(), Buffer.from(wire));
      wires.push(Buffer.from(wire)); return transactionId(tx.signature!);
    }, status: async () => "confirmed" };
  const create = (vv = v, pp = p) => new DevnetExecutionWorkflow(service, chain, config, vv, pp, transport, blockhashes, () => time);
  return { ...f, verifier, payer, chain, service, config, blockhashes, observation, expected, messages, wires, v, p,
    transport, create, clock: (n: number) => { time = n; }, duringRead: (fn: (n: number) => void) => { onRead = fn; } };
}
const code = (reason: string) => (error: unknown) => error instanceof ExecutionError && error.code === reason;

test("real Ed25519 pair signs exactly the authorized message; Solana verifies both signatures locally", async () => {
  const f = await setup(); await f.create().execute(f.request, TOKEN);
  assert.notEqual(f.verifier.publicKey, f.payer.publicKey);
  assert.equal(f.messages.length, 2); assert.equal(f.wires.length, 1);
  for (const message of f.messages) assert.deepEqual(message, f.expected.serializeMessage());
  const tx = Transaction.from(f.wires[0]!);
  for (const record of tx.signatures) {
    const publicKey = crypto.createPublicKey({ key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"), record.publicKey.toBuffer()]), format: "der", type: "spki" });
    assert.equal(crypto.verify(null, tx.serializeMessage(), publicKey, record.signature!), true);
  }
});
for (const role of ["verifier", "payer"] as const) {
  test("wrong real " + role + " identity rejected before signing", async () => {
    const f = await setup(), wrong = disposable();
    await assert.rejects(f.create(role === "verifier" ? wrong : f.v, role === "payer" ? wrong : f.p).execute(f.request, TOKEN),
      code(role === "verifier" ? "incorrect_verifier" : "incorrect_fee_payer"));
    assert.equal(f.messages.length, 0); assert.equal(f.wires.length, 0);
  });
}
for (const issue of ["missing", "incorrect", "other-message", "other-key"] as const) {
  test("rejects real signing failure: " + issue, async () => {
    const f = await setup();
    f.v.signMessage = async message => {
      if (issue === "missing") return new Uint8Array();
      if (issue === "incorrect") { const signature = Buffer.from(await f.verifier.signMessage(message)); signature[0] = signature[0]! ^ 1; return signature; }
      if (issue === "other-message") { const modified = Buffer.from(message); modified[modified.length - 1] = modified[modified.length - 1]! ^ 1;
        return f.verifier.signMessage(modified); }
      return disposable().signMessage(message);
    };
    await assert.rejects(f.create().execute(f.request, TOKEN), code("invalid_signature"));
    assert.equal(f.wires.length, 0);
  });
}
for (const alteration of ["message", "signature", "missing-signature", "extra-instruction", "writable-flags"] as const) {
  test("local Solana verification rejects modified transaction: " + alteration, async () => {
    const f = await setup(); await f.create().execute(f.request, TOKEN);
    const tx = Transaction.from(f.wires[0]!);
    if (alteration === "message") tx.instructions[0]!.data[8] = tx.instructions[0]!.data[8]! ^ 1;
    if (alteration === "signature") tx.signatures[0]!.signature![0] = tx.signatures[0]!.signature![0]! ^ 1;
    if (alteration === "missing-signature") tx.signatures[1]!.signature = null;
    if (alteration === "extra-instruction") tx.add(SystemProgram.transfer({ fromPubkey: new PublicKey(f.config.feePayer),
      toPubkey: new PublicKey(f.request.student), lamports: 1 }));
    if (alteration === "writable-flags") tx.instructions[0]!.keys[1]!.isWritable = true;
    assert.equal(tx.verifySignatures(true), false);
    assert.throws(() => tx.serialize(), /Signature verification failed/);
  });
}
test("unauthorized instructions fail policy before any real signing", async () => {
  const f = await setup();
  const authorizer = new AttestationAuthorizer(f.service, f.chain, f.config.verifier, () => 0);
  const policy = new AttestationTransactionPolicy(authorizer, f.chain, f.blockhashes, f.config, () => 0);
  const ticket = await authorizer.prepare(f.request, TOKEN);
  f.expected.add(SystemProgram.transfer({ fromPubkey: new PublicKey(f.config.feePayer), toPubkey: new PublicKey(f.request.student), lamports: 1 }));
  await assert.rejects(policy.authorize(ticket, f.expected.serialize({ requireAllSignatures: false, verifySignatures: false })),
    e => e instanceof TransactionPolicyError && e.code === "unauthorized_instructions");
  assert.equal(f.messages.length, 0);
});
test("expired authorization cannot reach real signer", async () => {
  const f = await setup(); f.duringRead(n => { if (n === 2) { f.clock(5000); f.observation.observedAtMs = 5000; } });
  await assert.rejects(f.create().execute(f.request, TOKEN),
    e => e instanceof TransactionPolicyError && e.code === "stale_authorization_or_blockhash");
  assert.equal(f.messages.length, 0);
});
test("successful real local signing cannot reuse authorization", async () => {
  const f = await setup(), workflow = f.create(); await workflow.execute(f.request, TOKEN);
  await assert.rejects(workflow.execute(f.request, TOKEN), e => e instanceof AttestationError && e.code === "duplicate_authorization");
  assert.equal(f.wires.length, 1); assert.equal(f.messages.length, 2);
});
test("fee limit rejects before real signing", async () => {
  const f = await setup(); f.transport.fee = async () => 10_001;
  await assert.rejects(f.create().execute(f.request, TOKEN), code("fee_limit_exceeded"));
  assert.equal(f.messages.length, 0);
});
test("test signer exposes only public metadata and rejects invalid keys/messages", async () => {
  const signer = disposable();
  assert.deepEqual(Object.keys(signer), ["mode"]);
  assert.equal(Reflect.get(signer, "privateKey"), undefined);
  assert.equal(JSON.stringify(signer), '{"mode":"test-only"}');
  assert.throws(() => new LocalTestSigner(crypto.generateKeyPairSync("ed25519").publicKey), code("invalid_test_key"));
  assert.throws(() => new LocalTestSigner(crypto.generateKeyPairSync("x25519").privateKey), code("invalid_test_key"));
  await assert.rejects(signer.signMessage(new Uint8Array()), code("invalid_signing_message"));
  await assert.rejects(signer.signMessage(new Uint8Array(1233)), code("invalid_signing_message"));
});
test("concrete Devnet RPC cannot submit locally signed bytes", async () => {
  const f = await setup(); await f.create().execute(f.request, TOKEN);
  let calls = 0;
  const rpc = new DisabledDevnetExecutionRpc(async () => { calls++; throw new Error("must_not_fetch"); });
  await assert.rejects(rpc.submit(f.wires[0]!), code("live_execution_disabled"));
  assert.equal(calls, 0);
});


test("production server import graph cannot reach test modules or signing adapters", async () => {
  const root = new URL("../src/", import.meta.url);
  const visited = new Set<string>();
  const inspect = async (url: URL): Promise<void> => {
    assert.ok(url.href.startsWith(root.href), "server imports must stay inside production source");
    assert.ok(!/local-test-signer|devnet-execution|transaction-coordinator/.test(url.pathname),
      "the HTTP server must not activate a signing workflow");
    if (visited.has(url.href)) return;
    visited.add(url.href);
    const source = await readFile(url, "utf8");
    // Existing server modules use only static imports; reject a dynamic loading escape as well.
    assert.ok(!/\bimport\s*\(|\brequire\s*\(/.test(source), "review dynamic loading before enabling it in the server");
    for (const match of source.matchAll(/\b(?:from\s*|import\s*)["']([^"']+)["']/g)) {
      const specifier = match[1]!;
      if (specifier.startsWith(".")) await inspect(new URL(specifier, url));
    }
  };
  await inspect(new URL("server.js", root));
  assert.ok(visited.size > 1);
  await assert.rejects(access(new URL("local-test-signer.js", root)), { code: "ENOENT" });
});
