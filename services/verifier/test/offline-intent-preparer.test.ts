import { fork } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicKey, Transaction, Message } from "@solana/web3.js";
import { LifecycleStore } from "@proofwork/lifecycle";
import { PROGRAM_ID, SETTLEMENT_DEVNET_GENESIS } from "@proofwork/finance-client";
import { createVerifierServer } from "../src/server.js";
import { OfflineTransactionPreparer } from "../src/offline-intent-preparer.js";
import { DevnetAttestationReader } from "../src/attestation-chain.js";
import { AttestationAuthorizer, buildAttestMilestoneInstruction } from "../src/attestation.js";
import { AttestationTransactionPolicy } from "../src/transaction-policy.js";
import { fixture } from "./helpers.js";

function barrier() {
  let release!: () => void, arrive!: () => void;
  const entered = new Promise<void>(r => { arrive = r; }), pending = new Promise<void>(r => { release = r; });
  return { entered, release, wait: async () => { arrive(); await pending; } };
}
async function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "pow-intent-prep-")), path = join(dir, "db.sqlite"), stores: LifecycleStore[] = [];
  const open = () => { const s = new LifecycleStore(path); stores.push(s); return s; };
  t.after(() => { for (const s of stores) s.close(); rmSync(dir, { recursive: true, force: true }); });
  const store = open(), f = fixture();
  let wrongProgramOwner = false;
  const reader = new DevnetAttestationReader("https://api.devnet.solana.com", f.verifier.toBase58(), async (url, init) => {
    const response = await f.rpc(url, init);
    if (!wrongProgramOwner) return response;
    const data = await response.json() as { result: { value: ({ owner: string } | null)[] } };
    for (const account of data.result.value) if (account) account.owner = f.verifier.toBase58();
    return Response.json(data);
  });
  const state = await reader.read(f.request.milestone);
  const job = store.jobs.createOrGetJob("job", { cluster: "devnet", genesisHash: SETTLEMENT_DEVNET_GENESIS, programId: PROGRAM_ID,
    sponsor: state.sponsor, internshipId: state.internshipId, internship: state.internship, milestoneId: state.milestoneId,
    milestone: state.milestone, submission: state.submission, student: state.student, verifier: state.verifier,
    requirementsHash: state.requirementsHash, evidenceHash: state.evidenceHash, repositoryId: f.request.repositoryId,
    contributorId: f.request.contributorId, commit: f.request.commit, verificationSpecHash: state.requirementsHash });
  const c = store.jobs.claimJob(job.jobId, job.identity, 0, "worker");
  let current = store.jobs.transitionJob(c.claim, c.job.revision, "verification_running");
  current = store.jobs.transitionJob(c.claim, current.revision, "verification_completed");
  current = store.jobs.transitionJob(c.claim, current.revision, "authorization_pending");
  const input = { claim: c.claim, jobRevision: current.revision, requestId: "prepare" };
  const config = { verifier: state.verifier, feePayer: state.sponsor, maxAgeMs: 5000, minRemainingBlockHeights: 10 };
  const observation = { rpc: "https://api.devnet.solana.com" as const, genesisHash: SETTLEMENT_DEVNET_GENESIS,
    blockhash: new PublicKey(Buffer.alloc(32, 177)).toBase58(), lastValidBlockHeight: 200,
    currentBlockHeight: 100, observedAtMs: 0, valid: true };
  let reads = 0, blocks = 0, time = 0, chainHook = async (_n: number) => {}, blockHook = async () => {};
  const chain = { read: async (id: string) => { await chainHook(++reads); return reader.read(id); } };
  const source = { read: async () => { blocks++; await blockHook(); return { ...observation }; } };
  const create = (s = store) => new OfflineTransactionPreparer(s, chain, source, config, () => time);
  const preparer = create();
  const expected = new Transaction({ feePayer: new PublicKey(config.feePayer), recentBlockhash: observation.blockhash })
    .add(buildAttestMilestoneInstruction(state, state.verifier)).serializeMessage();
  const intent = () => { const a = store.transactionIntents.listOutstandingIntents().entries; assert.equal(a.length, 1); return a[0]!; };
  const revoke = () => store.jobRecovery.interruptJob(current.jobId, current.identity, current.revision, "operator");
  return { ...f, path, state, store, open, current, input, config, observation, chain, source, expected, create, preparer, intent, revoke,
    chainHook: (fn: typeof chainHook) => { chainHook = fn; }, blockHook: (fn: typeof blockHook) => { blockHook = fn; },
    clock: (v: number) => { time = v; }, blocks: () => blocks, reads: () => reads, wrongProgram: () => { wrongProgramOwner = true; } };
}
test("real offline builder records exact sole legacy message without producing authorization", async t => {
  const f = await setup(t), p = await f.preparer.prepare(f.input);
  assert.deepEqual(p.message, f.expected);
  const message = Message.from(p.message);
  assert.equal(message.header.numRequiredSignatures, 2);
  assert.equal(message.instructions.length, 1);
  const instruction = message.instructions[0]!;
  assert.equal(message.accountKeys[instruction.programIdIndex]!.toBase58(), PROGRAM_ID);
  assert.deepEqual(instruction.accounts.map(i => message.accountKeys[i]!.toBase58()),
    [f.state.verifier, f.state.internship, f.state.milestone, f.state.submission]); assert.equal(p.intent.state, "preparation_recorded");
  assert.equal(p.signingAuthorization, "not_granted"); assert.equal(p.submissionAuthorized, false);
  const original = f.store.transactionIntents.getIntent(p.intent.intentId)!;
  p.message.fill(0); assert.deepEqual(f.store.transactionIntents.getIntent(p.intent.intentId), original);
  const never = async () => { throw Error("must_not_execute"); };
  const authorizer = new AttestationAuthorizer({ verify: never }, f.chain, f.config.verifier);
  const policy = new AttestationTransactionPolicy(authorizer, f.chain, f.source, f.config, () => 0);
  for (const candidate of [p.intent, p.intent.preparation, structuredClone(p.intent)]) {
    await assert.rejects(authorizer.takeInstruction(candidate));
    await assert.rejects(policy.consume(candidate));
  }
  assert.equal(f.store.offlineHandoffs.get(f.current.jobId), undefined);
});
for (const variant of ["same", "alias", "restart"] as const) {
  test("prepared operation cannot be prepared again via " + variant, async t => {
    const f = await setup(t); const p = await f.preparer.prepare(f.input), before = f.blocks();
    await assert.rejects((variant === "restart" ? f.create(f.open()) : f.preparer)
      .prepare({ ...f.input, requestId: variant === "alias" ? "different" : f.input.requestId }));
    assert.equal(f.blocks(), before); assert.deepEqual(f.intent(), p.intent);
  });
}
test("created intent left by a previous process is permanently accounted for and not resumed", async t => {
  const f = await setup(t);
  const a = f.store.transactionIntents.createIntent(f.input.claim, f.input.jobRevision, "earlier", f.config.feePayer).intent;
  await assert.rejects(f.create(f.open()).prepare(f.input));
  assert.equal(f.reads(), 0); assert.equal(f.blocks(), 0); assert.equal(f.intent().intentId, a.intentId);
  assert.equal(f.intent().reconciliationRequired, true);
});
test("two concurrent preparers on separate connections perform preparation at most once", async t => {
  const f = await setup(t);
  const result = await Promise.allSettled([f.preparer.prepare(f.input), f.create(f.open()).prepare({ ...f.input, requestId: "alias" })]);
  assert.equal(result.filter(x => x.status === "fulfilled").length, 1);
  assert.equal(f.blocks(), 1); assert.equal(f.store.transactionIntents.getIntentHistory(f.intent().intentId).length, 2);
});
for (const patch of [{ approved: true }, { transaction: new Uint8Array() }, { instructions: [] },
  { feePayer: "forged" }, { blockhash: "forged" }, { signedTransaction: "forged" }, { messageDigest: "ab".repeat(32) }]) {
  test("preparer rejects caller transaction/authority field " + Object.keys(patch)[0], async t => {
    const f = await setup(t); await assert.rejects(f.preparer.prepare({ ...f.input, ...patch }));
    assert.equal(f.store.transactionIntents.listOutstandingIntents().entries.length, 0);
  });
}
for (const mutate of [
  (f: Awaited<ReturnType<typeof setup>>) => { f.observation.valid = false; },
  (f: Awaited<ReturnType<typeof setup>>) => { f.observation.currentBlockHeight = 200; },
  (f: Awaited<ReturnType<typeof setup>>) => { f.observation.currentBlockHeight = Number.MAX_SAFE_INTEGER + 1; },
  (f: Awaited<ReturnType<typeof setup>>) => { f.observation.genesisHash = "wrong"; },
  (f: Awaited<ReturnType<typeof setup>>) => { f.observation.blockhash = "bad"; },
  (f: Awaited<ReturnType<typeof setup>>) => { f.clock(5000); },
  (f: Awaited<ReturnType<typeof setup>>) => { f.observation.observedAtMs = 1; },
]) {
  test("invalid/expired trusted lease leaves consumed uncertainty: " + mutate.toString(), async t => {
    const f = await setup(t); mutate(f);
    await assert.rejects(f.preparer.prepare(f.input));
    assert.equal(f.intent().state, "preparation_uncertain"); assert.equal(f.intent().preparation, undefined);
    await assert.rejects(f.create(f.open()).prepare({ ...f.input, requestId: "new" }));
  });
}
for (const phase of ["chain_before", "blockhash", "chain_after"] as const) {
  test("revocation at " + phase + " prevents recording preparation success", async t => {
    const f = await setup(t), gate = barrier();
    if (phase === "blockhash") f.blockHook(gate.wait);
    else f.chainHook(async n => { if (n === (phase === "chain_before" ? 1 : 2)) await gate.wait(); });
    const pending = f.preparer.prepare(f.input), rejected = assert.rejects(pending);
    await gate.entered; f.revoke(); gate.release(); await rejected;
    assert.equal(f.intent().state, "created"); assert.equal(f.intent().reconciliationRequired, true);
    assert.equal(f.store.transactionIntents.getIntentHistory(f.intent().intentId).length, 1);
  });
}
test("chain binding change during blockhash await cannot enter a prepared record", async t => {
  const f = await setup(t); f.blockHook(async () => { f.m[272] = 4; });
  await assert.rejects(f.preparer.prepare(f.input));
  assert.equal(f.intent().state, "preparation_uncertain"); assert.equal(f.intent().preparation, undefined);
});
for (const field of ["student", "verifier", "requirements", "evidence", "submission", "program"] as const) {
  test("changed fresh chain " + field + " cannot enter a preparation", async t => {
    const f = await setup(t);
    if (field === "student") new PublicKey(f.config.feePayer).toBuffer().copy(f.m, 72);
    if (field === "verifier") new PublicKey(f.request.student).toBuffer().copy(f.m, 104);
    if (field === "requirements") f.m[200] = f.m[200]! ^ 1;
    if (field === "evidence") f.s[72] = f.s[72]! ^ 1;
    if (field === "submission") f.m[168] = f.m[168]! ^ 1;
    if (field === "program") f.wrongProgram();
    await assert.rejects(f.preparer.prepare(f.input)); assert.equal(f.intent().preparation, undefined);
  });
}
test("existing offline mock receipt remains separate and grants no preparation authorization", async t => {
  const f = await setup(t), hash = "cd".repeat(32);
  f.store.offlineHandoffs.begin(f.input.claim, f.input.jobRevision, hash);
  const mock = f.store.offlineHandoffs.finish(f.input.claim, f.input.jobRevision, hash, "recorded", "acknowledged");
  await assert.rejects(f.preparer.prepare(mock as unknown as typeof f.input));
  const p = await f.preparer.prepare(f.input);
  assert.notEqual(p.intent.preparation!.messageDigest, mock.messageDigest);
  assert.deepEqual(f.store.offlineHandoffs.get(f.current.jobId), mock);
  assert.equal(p.signingAuthorization, "not_granted");
});

for (const phase of ["during-preparation", "after-digest", "during-record", "after-record"] as const) {
  test("actual preparer crash " + phase + " preserves uncertainty and forbids another preparation", { timeout: 20000 }, async t => {
    const f = await setup(t), child = fork(new URL("./offline-intent-process.js", import.meta.url), [f.path, phase],
      { stdio: ["ignore", "ignore", "pipe", "ipc", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    try {
      await Promise.race([once(child.stdio[4]!, "data"), once(child, "exit").then(() => { throw Error("child_exited_before_checkpoint"); })]);
      const done = once(child, "exit"); child.kill("SIGKILL"); await done;
      const row = f.open().transactionIntents.listOutstandingIntents().entries[0]!;
      assert.equal(row.state, phase === "after-record" ? "preparation_recorded" : "created");
      assert.equal(row.reconciliationRequired, phase !== "after-record");
      if (phase === "after-record") assert.equal(row.preparation!.messageDigest, createHash("sha256").update(f.expected).digest("hex"));
      const before = f.store.transactionIntents.getIntentHistory(row.intentId);
      await assert.rejects(f.create(f.open()).prepare({ ...f.input, requestId: "restart_new_id" }));
      assert.deepEqual(f.store.transactionIntents.getIntentHistory(row.intentId), before);
      assert.equal(f.blocks(), 0); assert.equal(row.signingAuthorization, "not_granted");
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  });
}
test("source timeout/failure remains uncertain with no automatic preparation retry", async t => {
  const f = await setup(t); f.blockHook(async () => { throw Error("mock_read_timeout"); });
  await assert.rejects(f.preparer.prepare(f.input));
  const row = f.intent(); assert.equal(row.state, "preparation_uncertain");
  const count = f.blocks(); await assert.rejects(f.create(f.open()).prepare({ ...f.input, requestId: "new" }));
  assert.equal(f.blocks(), count); assert.equal(row.retryAuthorized, false);
});

test("input/configuration mutation across async reads cannot substitute job or payer", async t => {
  const f = await setup(t), gate = barrier();
  f.chainHook(async n => { if (n === 1) await gate.wait(); });
  const pending = f.preparer.prepare(f.input);
  await gate.entered;
  f.input.claim = { ...f.input.claim, generation: 0 }; f.input.requestId = "changed";
  f.config.feePayer = f.request.student;
  gate.release(); const p = await pending;
  assert.deepEqual(p.message, f.expected); assert.equal(p.intent.requestId, "prepare");
  assert.equal(p.intent.feePayer, f.state.sponsor);
});
for (const patch of [{ signer: () => {} }, { privateKey: "test-invalid-field" }, { feePayer: 1 },
  { maxAgeMs: Infinity }, { minRemainingBlockHeights: 0 }]) {
  test("invalid or operational preparation configuration is rejected: " + Object.keys(patch)[0], async t => {
    const f = await setup(t);
    assert.throws(() => new OfflineTransactionPreparer(f.store, f.chain, f.source,
      { ...f.config, ...patch } as unknown as typeof f.config));
    assert.equal(f.store.transactionIntents.listOutstandingIntents().entries.length, 0);
  });
}
test("preparation exceptions do not reveal raw dependency payloads", async t => {
  const f = await setup(t);
  f.blockHook(async () => { throw Error("sensitive_mock_payload"); });
  await assert.rejects(f.preparer.prepare(f.input), (error: unknown) =>
    error instanceof Error && error.message === "preparation_failed" && !error.message.includes("sensitive_mock_payload"));
  assert.equal(f.intent().state, "preparation_uncertain");
});

test("lease expiration while the final chain read awaits fails closed", async t => {
  const f = await setup(t); f.chainHook(async n => { if (n === 2) f.clock(5000); });
  await assert.rejects(f.preparer.prepare(f.input));
  assert.equal(f.intent().state, "preparation_uncertain"); assert.equal(f.intent().preparation, undefined);
});
test("existing HTTP server exposes no transaction-intent preparation or submission route", async () => {
  let calls = 0;
  const server = createVerifierServer({ verify: async () => { calls++; throw Error("forbidden_route"); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    for (const route of ["/transaction-intents", "/transaction-intents/prepare", "/transactions/submit"]) {
      const response: Response = await fetch("http://127.0.0.1:" + address.port + route, {
        method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-route-credential" },
        body: JSON.stringify({ approved: true }),
      });
      assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: "invalid_request" });
    }
    assert.equal(calls, 0);
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});
