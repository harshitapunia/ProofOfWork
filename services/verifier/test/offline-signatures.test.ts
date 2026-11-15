import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { OfflineDualSignatureSimulation, takeOfflineRoleMessage, type SimulationContext } from "../src/offline-signature-simulation.js";
import { signingFixture, ephemeral, barrier } from "./signing-helpers.js";
import { AttestationAuthorizer } from "../src/attestation.js";
import { AttestationTransactionPolicy } from "../src/transaction-policy.js";
import { TOKEN } from "./helpers.js";
async function authorized(f: Awaited<ReturnType<typeof signingFixture>>) {
  const ticket = await f.authorizer.prepare(f.request, TOKEN);
  const approval = await f.policy.authorize(ticket, f.transaction().serialize({ requireAllSignatures: false, verifySignatures: false }));
  return { approval, message: await f.policy.consume(approval) };
}
function checkpoints() {
  const prepared: SimulationContext[] = [];
  return { prepared, checkpoint: () => {}, prepare: (context: SimulationContext) => { prepared.push(context); } };
}
test("genuine policy consumption permits exactly two ephemeral signatures over its exact message", async () => {
  const f = await signingFixture(), a = await authorized(f), hooks = checkpoints();
  const result = await f.simulator().simulate(a.message, hooks);
  assert.equal(result.verifiedSignatureCount, 2); assert.equal(result.requiredSignatureCount, 2);
  assert.equal(result.operationalSigningAuthorized, false); assert.equal(result.submissionAuthorized, false);
  assert.deepEqual(f.verifier.messages[0], f.expected); assert.deepEqual(f.payer.messages[0], f.expected);
  assert.ok(f.verifier.verifies(f.expected, f.verifier.signatures[0]!));
  assert.ok(f.payer.verifies(f.expected, f.payer.signatures[0]!));
  assert.equal(hooks.prepared.length, 1); assert.ok(Object.isFrozen(result));
  await assert.rejects(f.policy.consume(a.approval));
  await assert.rejects(f.simulator().simulate(a.message, hooks));
  assert.equal(f.verifier.signatures.length, 1); assert.equal(f.payer.signatures.length, 1);
});
test("real legacy transaction verification requires both correctly ordered distinct role signatures", async () => {
  const f = await signingFixture(), v = f.verifier.signForTest(f.expected), p = f.payer.signForTest(f.expected);
  const wire = (payer: Buffer, verifier: Buffer) => Buffer.concat([Buffer.from([2]), payer, verifier, f.expected]);
  assert.equal(Transaction.from(wire(p, v)).verifySignatures(true), true);
  assert.equal(Transaction.from(wire(Buffer.alloc(64), v)).verifySignatures(true), false);
  assert.equal(Transaction.from(wire(p, Buffer.alloc(64))).verifySignatures(true), false);
  assert.equal(Transaction.from(wire(v, p)).verifySignatures(true), false);
  assert.equal(Transaction.from(wire(v, v)).verifySignatures(true), false);
  const other = ephemeral("verifier");
  assert.equal(Transaction.from(wire(p, other.signForTest(f.expected))).verifySignatures(true), false);
  assert.equal(Transaction.from(wire(other.signForTest(f.expected), v)).verifySignatures(true), false);
  const altered = Buffer.from(f.expected); altered[altered.length - 1] = altered[altered.length - 1]! ^ 1;
  assert.equal(f.verifier.verifies(altered, v), false); assert.equal(f.payer.verifies(altered, p), false);
});
for (const forged of ["bytes", "clone", "approved", "ticket", "database", "receipt"] as const) {
  test("unbranded " + forged + " cannot cross the signature simulation boundary", async () => {
    const f = await signingFixture(), a = await authorized(f), hooks = checkpoints();
    const input = forged === "bytes" ? Buffer.from(f.expected) : forged === "clone" ? structuredClone(a.message)
      : forged === "approved" ? { approved: true } : forged === "ticket" ? {}
      : forged === "database" ? { state: "preparation_recorded", messageDigest: "ab".repeat(32), signingAuthorization: "not_granted" }
      : { mode: "offline-mock", receiptId: "offline-mock:fake" };
    await assert.rejects(f.simulator().simulate(input, hooks));
    assert.equal(f.verifier.signatures.length, 0); assert.equal(f.payer.signatures.length, 0); assert.equal(hooks.prepared.length, 0);
  });
}
test("mutating original consumed bytes rejects and burns the simulation capability", async () => {
  const f = await signingFixture(), a = await authorized(f);
  const saved = a.message[0]!; a.message[0] = saved ^ 1;
  await assert.rejects(f.simulator().simulate(a.message, checkpoints()));
  a.message[0] = saved;
  await assert.rejects(f.simulator().simulate(a.message, checkpoints())); assert.equal(f.verifier.signatures.length, 0);
});
test("caller mutation after boundary snapshot cannot substitute provider message bytes", async () => {
  const f = await signingFixture(), a = await authorized(f), gate = barrier();
  f.verifier.before(gate.wait);
  const pending = f.simulator().simulate(a.message, checkpoints());
  await gate.entered; a.message.fill(0); gate.release(); await pending;
  assert.deepEqual(f.verifier.messages[0], f.expected); assert.deepEqual(f.payer.messages[0], f.expected);
});
test("concurrent use of one consumed message admits only one dual-role simulation", async () => {
  const f = await signingFixture(), a = await authorized(f), simulation = f.simulator();
  const results = await Promise.allSettled([simulation.simulate(a.message, checkpoints()), simulation.simulate(a.message, checkpoints())]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(f.verifier.signatures.length, 1); assert.equal(f.payer.signatures.length, 1);
});
test("role requests are role/key-bound, one-shot and cannot be cloned or replayed", async () => {
  const f = await signingFixture(), a = await authorized(f);
  f.verifier.after(async () => {
    const token = f.verifier.tokens[0]!;
    assert.throws(() => takeOfflineRoleMessage(token, "verifier", f.config.verifier));
    assert.throws(() => takeOfflineRoleMessage(structuredClone(token), "verifier", f.config.verifier));
  });
  await f.simulator().simulate(a.message, checkpoints());
  assert.throws(() => takeOfflineRoleMessage(f.payer.tokens[0], "fee_payer", f.config.feePayer));
});
for (const bad of ["wrong_role", "wrong_key"] as const) {
  test("wrong role token consumption " + bad + " burns it and prevents signatures", async () => {
    const f = await signingFixture(), a = await authorized(f);
    f.verifier.before(async token => {
      assert.throws(() => takeOfflineRoleMessage(token, bad === "wrong_role" ? "fee_payer" : "verifier",
        bad === "wrong_key" ? f.config.feePayer : f.config.verifier));
    });
    await assert.rejects(f.simulator().simulate(a.message, checkpoints()));
    assert.equal(f.verifier.signatures.length, 0); assert.equal(f.payer.signatures.length, 0);
  });
}
for (const role of ["verifier", "payer"] as const) for (const invalid of ["missing", "short", "long", "flipped", "other_key", "duplicate"] as const) {
  test(role + " response rejects " + invalid + " signature without declaring full signing", async () => {
    const f = await signingFixture(), a = await authorized(f), other = ephemeral("verifier");
    f[role].response((signature, message) => {
      if (invalid === "missing") return new Uint8Array();
      if (invalid === "short") return signature.subarray(0, 63);
      if (invalid === "long") return Buffer.concat([signature, Buffer.from([0])]);
      if (invalid === "other_key") return other.signForTest(message);
      if (invalid === "duplicate") return role === "payer" ? f.verifier.signatures[0]! : f.payer.signForTest(message);
      const copy = Buffer.from(signature); copy[0] = copy[0]! ^ 1; return copy;
    });
    await assert.rejects(f.simulator().simulate(a.message, checkpoints()));
    if (role === "verifier") assert.equal(f.payer.signatures.length, 0);
  });
}
for (const invalid of ["same_roles", "non_test_mode", "extra_credentials", "wrong_provider"] as const) {
  test("explicit independent test providers required: " + invalid, async () => {
    const f = await signingFixture();
    if (invalid === "same_roles") assert.throws(() => new OfflineDualSignatureSimulation(f.verifier.provider, f.verifier.provider));
    if (invalid === "non_test_mode") assert.throws(() => new OfflineDualSignatureSimulation(
      { ...f.verifier.provider, mode: "real" } as unknown as typeof f.verifier.provider, f.payer.provider));
    if (invalid === "extra_credentials") assert.throws(() => new OfflineDualSignatureSimulation(
      { ...f.verifier.provider, credential: "invalid-test-field" } as unknown as typeof f.verifier.provider, f.payer.provider));
    if (invalid === "wrong_provider") {
      const a = await authorized(f), other = ephemeral("verifier");
      await assert.rejects(new OfflineDualSignatureSimulation(other.provider, f.payer.provider, f.now).simulate(a.message, checkpoints()));
      await assert.rejects(f.simulator().simulate(a.message, checkpoints()));
      assert.equal(f.verifier.signatures.length, 0);
    }
  });
}
for (const phase of ["before", "during_verifier", "during_payer"] as const) {
  test("original policy deadline is never renewed: " + phase, async () => {
    const f = await signingFixture(), a = await authorized(f);
    if (phase === "before") f.clock(5000);
    else f[phase === "during_verifier" ? "verifier" : "payer"].after(async () => { f.clock(5000); });
    await assert.rejects(f.simulator().simulate(a.message, checkpoints()));
    if (phase !== "during_payer") assert.equal(f.payer.signatures.length, 0);
  });
}
for (const change of ["state", "blockhash", "genesis", "expired_lease", "verifier", "student", "requirements", "evidence"] as const) {
  test("policy revalidation before payer blocks changed " + change, async () => {
    const f = await signingFixture(), a = await authorized(f);
    f.verifier.after(async () => {
      if (change === "state") f.m[272] = 4;
      if (change === "verifier") new PublicKey(f.request.student).toBuffer().copy(f.m, 104);
      if (change === "student") new PublicKey(f.config.feePayer).toBuffer().copy(f.m, 72);
      if (change === "requirements") f.m[200] = f.m[200]! ^ 1;
      if (change === "evidence") f.s[72] = f.s[72]! ^ 1;
      if (change === "blockhash") f.observation.blockhash = new PublicKey(Buffer.alloc(32, 178)).toBase58();
      if (change === "genesis") f.observation.genesisHash = "wrong";
      if (change === "expired_lease") f.observation.valid = false;
    });
    await assert.rejects(f.simulator().simulate(a.message, checkpoints()));
    assert.equal(f.verifier.signatures.length, 1); assert.equal(f.payer.signatures.length, 0);
  });
}
for (const mutation of ["program", "student", "requirements", "evidence", "accounts", "signer", "writable", "payer", "blockhash", "extra", "versioned"] as const) {
  test("existing exact policy rejects " + mutation + " before simulation can receive a capability", async () => {
    const f = await signingFixture(), ticket = await f.authorizer.prepare(f.request, TOKEN), tx = f.transaction();
    if (mutation === "program") tx.instructions[0]!.programId = new PublicKey(f.request.student);
    if (mutation === "student") tx.instructions[0]!.data[8] = tx.instructions[0]!.data[8]! ^ 1;
    if (mutation === "requirements") tx.instructions[0]!.data[40] = tx.instructions[0]!.data[40]! ^ 1;
    if (mutation === "evidence") tx.instructions[0]!.data[72] = tx.instructions[0]!.data[72]! ^ 1;
    if (mutation === "accounts") tx.instructions[0]!.keys.reverse();
    if (mutation === "signer") tx.instructions[0]!.keys[3]!.isSigner = true;
    if (mutation === "writable") tx.instructions[0]!.keys[1]!.isWritable = true;
    if (mutation === "payer") tx.feePayer = new PublicKey(f.request.student);
    if (mutation === "blockhash") tx.recentBlockhash = new PublicKey(Buffer.alloc(32, 178)).toBase58();
    if (mutation === "extra") tx.add(SystemProgram.transfer({ fromPubkey: new PublicKey(f.config.feePayer), toPubkey: new PublicKey(f.request.student), lamports: 1 }));
    const wire = mutation === "versioned" ? new VersionedTransaction(new TransactionMessage({
      payerKey: new PublicKey(f.config.feePayer), recentBlockhash: f.observation.blockhash, instructions: tx.instructions,
    }).compileToV0Message()).serialize() : tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    await assert.rejects(f.policy.authorize(ticket, wire));
    assert.equal(f.verifier.signatures.length, 0); assert.equal(f.payer.signatures.length, 0);
  });
}

test("ephemeral signatures are invalid for a different blockhash or added instruction", async () => {
  const f = await signingFixture(), signature = f.verifier.signForTest(f.expected), payerSignature = f.payer.signForTest(f.expected);
  const blockhash = f.transaction(); blockhash.recentBlockhash = new PublicKey(Buffer.alloc(32, 178)).toBase58();
  const extra = f.transaction().add(SystemProgram.transfer({ fromPubkey: new PublicKey(f.config.feePayer),
    toPubkey: new PublicKey(f.request.student), lamports: 1 }));
  for (const message of [blockhash.serializeMessage(), extra.serializeMessage()]) {
    assert.equal(f.verifier.verifies(message, signature), false);
    assert.equal(f.payer.verifies(message, payerSignature), false);
  }
});

test("a valid precomputed signature without consuming the role request is still rejected", async () => {
  const f = await signingFixture(), a = await authorized(f);
  const provider = { mode: "ephemeral-offline-test" as const, publicKey: f.config.verifier,
    simulateAttestation: async () => f.verifier.signForTest(f.expected) };
  await assert.rejects(new OfflineDualSignatureSimulation(provider, f.payer.provider, f.now).simulate(a.message, checkpoints()));
  assert.equal(f.payer.signatures.length, 0);
});
test("raw provider failure payload is sanitized and cannot trigger the second role", async () => {
  const f = await signingFixture(), a = await authorized(f);
  f.verifier.before(async () => { throw Error("sensitive_mock_payload"); });
  await assert.rejects(f.simulator().simulate(a.message, checkpoints()), (e: unknown) =>
    e instanceof Error && e.message === "simulation_failure");
  assert.equal(f.payer.signatures.length, 0);
});

test("an overridden caller buffer comparison cannot disguise mutation", async () => {
  const f = await signingFixture(), a = await authorized(f);
  a.message[0] = a.message[0]! ^ 1;
  a.message.equals = () => true;
  await assert.rejects(f.simulator().simulate(a.message, checkpoints()));
  assert.equal(f.verifier.signatures.length, 0); assert.equal(f.payer.signatures.length, 0);
});

async function freshAuthorization(f: Awaited<ReturnType<typeof signingFixture>>) {
  const authorizer = new AttestationAuthorizer(f.service, f.chain, f.config.verifier, f.now);
  const policy = new AttestationTransactionPolicy(authorizer, f.chain, f.source, f.config, f.now);
  const ticket = await authorizer.prepare(f.request, TOKEN);
  const approval = await policy.authorize(ticket, f.transaction().serialize({ requireAllSignatures: false, verifySignatures: false }));
  return policy.consume(approval);
}
test("a fresh independent policy approval cannot repeat a completed simulation on the same adapter", async () => {
  const f = await signingFixture(), first = await authorized(f), simulation = f.simulator();
  await simulation.simulate(first.message, checkpoints());
  const another = await freshAuthorization(f);
  await assert.rejects(simulation.simulate(another, checkpoints()));
  assert.equal(f.verifier.signatures.length, 1); assert.equal(f.payer.signatures.length, 1);
});
test("uncertain simulation does not become renewable with another genuine policy approval", async () => {
  const f = await signingFixture(), first = await authorized(f), simulation = f.simulator(25), gate = barrier();
  f.verifier.after(gate.wait);
  await assert.rejects(simulation.simulate(first.message, checkpoints()));
  gate.release(); await new Promise(resolve => setImmediate(resolve));
  const another = await freshAuthorization(f);
  await assert.rejects(simulation.simulate(another, checkpoints()));
  assert.equal(f.verifier.signatures.length, 1); assert.equal(f.payer.signatures.length, 0);
});
