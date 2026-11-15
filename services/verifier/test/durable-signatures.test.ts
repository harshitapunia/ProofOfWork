import { fork } from "node:child_process";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { LifecycleStore, INTENT_FORMAT, type JobClaim } from "@proofwork/lifecycle";
import { DurableOfflineCoordinator, type OfflineMockOptions } from "../src/durable-offline-coordinator.js";
import { DevnetAttestationReader } from "../src/attestation-chain.js";
import { buildAttestMilestoneInstruction } from "../src/attestation.js";
import { takeOfflinePolicyMessage } from "../src/transaction-policy.js";
import { PublicKey, Transaction } from "@solana/web3.js";
import { createVerifierServer } from "../src/server.js";
import { once } from "node:events";
import { signingFixture, barrier, ephemeral } from "./signing-helpers.js";
import { OfflineDualSignatureSimulation } from "../src/offline-signature-simulation.js";
import { TOKEN } from "./helpers.js";
async function setup(t: TestContext, options: OfflineMockOptions = { mode: "offline-mock" }, timeout = 1000) {
  const f = await signingFixture(), dir = mkdtempSync(join(tmpdir(), "pow-dual-simulation-")), path = join(dir, "jobs.sqlite");
  const stores: LifecycleStore[] = [];
  const open = () => { const s = new LifecycleStore(path); stores.push(s); return s; };
  t.after(() => { for (const s of stores) s.close(); rmSync(dir, { recursive: true, force: true }); });
  const store = open(), simulation = f.simulator(timeout);
  const create = (s = store, worker = "worker", simulate = true) =>
    new DurableOfflineCoordinator(s, f.service, f.chain, f.config, worker, f.source, f.now, options, simulate ? simulation : undefined);
  const coordinator = create();
  const job = () => { const rows = store.jobs.listRecoveryRequired().entries; assert.equal(rows.length, 1); return rows[0]!.job; };
  const intent = () => { const rows = store.transactionIntents.listOutstandingIntents().entries; assert.equal(rows.length, 1); return rows[0]!; };
  const revoke = () => { const j = job(); return store.jobRecovery.interruptJob(j.jobId, j.identity, j.revision, "operator"); };
  return { ...f, path, store, open, coordinator, create, job, intent, revoke };
}
test("durable verification, real policy, both test signatures and exact v4 preparation remain offline", async t => {
  const f = await setup(t), receipt = await f.coordinator.coordinate("request", f.request, TOKEN);
  const evidence = f.coordinator.readSimulationEvidence(receipt);
  assert.equal(evidence.verifiedSignatureCount, 2); assert.equal(evidence.submissionAuthorized, false);
  assert.deepEqual(f.coordinator.readMockMessage(receipt), f.expected);
  assert.deepEqual(f.verifier.messages[0], f.expected); assert.deepEqual(f.payer.messages[0], f.expected);
  const intent = f.intent();
  assert.equal(intent.state, "reconciliation_required"); assert.equal(intent.revision, 2);
  assert.equal(intent.preparation!.messageDigest, createHash("sha256").update(f.expected).digest("hex"));
  assert.equal(intent.feePayer, f.config.feePayer); assert.equal(intent.signingAuthorization, "not_granted");
  assert.deepEqual(f.store.transactionIntents.getIntentHistory(intent.intentId).map(h => h.state),
    ["created", "preparation_recorded", "reconciliation_required"]);
  assert.equal(f.store.offlineHandoffs.get(receipt.jobId)!.outcome, "recorded");
  assert.equal(receipt.mode, "offline-mock"); assert.match(receipt.receiptId, /^offline-mock:/);
  assert.throws(() => f.coordinator.readSimulationEvidence(structuredClone(receipt)));
  assert.throws(() => f.create(f.open()).readSimulationEvidence(receipt));
});
for (const variant of ["same", "new_id", "new_worker", "restart"] as const) {
  test("durable duplicate simulation cannot bypass via " + variant, async t => {
    const f = await setup(t); await f.coordinator.coordinate("first", f.request, TOKEN);
    await assert.rejects((variant === "same" ? f.coordinator : f.create(variant === "restart" ? f.open() : f.store,
      variant === "new_worker" ? "other" : "worker")).coordinate(variant === "new_id" ? "other" : "first", f.request, TOKEN));
    assert.equal(f.verifier.signatures.length, 1); assert.equal(f.payer.signatures.length, 1); assert.equal(f.runs(), 1);
  });
}
test("two separate connections/coordinators sign a protected operation at most once", async t => {
  const f = await setup(t), other = f.create(f.open(), "other");
  const results = await Promise.allSettled([f.coordinator.coordinate("first", f.request, TOKEN), other.coordinate("second", f.request, TOKEN)]);
  assert.equal(results.filter(v => v.status === "fulfilled").length, 1);
  assert.equal(f.verifier.signatures.length, 1); assert.equal(f.payer.signatures.length, 1);
});
test("forged trusted verification success cannot produce either role signature", async t => {
  const f = await setup(t);
  const coordinator = new DurableOfflineCoordinator(f.store,
    { verify: async () => ({ approved: true, status: "passed", outcomes: [], startedAt: "", finishedAt: "" }) },
    f.chain, f.config, "worker", f.source, f.now, { mode: "offline-mock" }, f.simulator());
  await assert.rejects(coordinator.coordinate("request", f.request, TOKEN));
  assert.equal(f.verifier.signatures.length, 0); assert.equal(f.payer.signatures.length, 0);
  assert.equal(f.store.transactionIntents.listOutstandingIntents().entries.length, 0);
});
for (const patch of [{ approved: true }, { transaction: new Uint8Array() }, { instructions: [] },
  { simulation: "operational" }, { feePayer: "forged" }, { privateKey: "invalid-test-field" }]) {
  test("untrusted application field cannot configure signing: " + Object.keys(patch)[0], async t => {
    const f = await setup(t);
    await assert.rejects(f.coordinator.coordinate("request", { ...f.request, ...patch }, TOKEN));
    assert.equal(f.verifier.signatures.length, 0); assert.equal(f.payer.signatures.length, 0);
    assert.equal(f.store.transactionIntents.listOutstandingIntents().entries.length, 0);
  });
}
test("worker replacement during real verification discards result and cannot advance new worker", async t => {
  const f = await setup(t), gate = barrier(); f.onRun(gate.wait);
  const pending = f.coordinator.coordinate("request", f.request, TOKEN), rejected = assert.rejects(pending);
  await gate.entered; const revoked = f.revoke();
  const replacement = f.store.jobs.claimJob(revoked.jobId, revoked.identity, revoked.revision, "replacement");
  gate.release(); await rejected;
  assert.deepEqual(f.store.jobs.getJob(revoked.jobId), replacement.job);
  assert.equal(f.verifier.signatures.length, 0); assert.equal(f.store.transactionIntents.listOutstandingIntents().entries.length, 0);
});
test("same-generation stale revision is fenced before any provider or intent write", async t => {
  const f = await setup(t), gate = barrier(); f.onRun(gate.wait);
  const pending = f.coordinator.coordinate("request", f.request, TOKEN), rejected = assert.rejects(pending);
  await gate.entered; const j = f.job();
  f.store.jobs.transitionJob({ jobId: j.jobId, identity: j.identity, workerId: j.workerId!, generation: j.generation }, j.revision, "verification_completed");
  gate.release(); await rejected;
  assert.equal(f.verifier.signatures.length, 0); assert.equal(f.store.transactionIntents.listOutstandingIntents().entries.length, 0);
});
test("revocation after durable marker and before providers prevents either signature", async t => {
  const gate = barrier(), f = await setup(t, { mode: "offline-mock", gate: { wait: gate.wait } });
  const pending = f.coordinator.coordinate("request", f.request, TOKEN), rejected = assert.rejects(pending);
  await gate.entered; assert.equal(f.intent().state, "reconciliation_required"); f.revoke();
  gate.release(); await rejected;
  assert.equal(f.verifier.signatures.length, 0); assert.equal(f.payer.signatures.length, 0);
  assert.equal(f.store.offlineHandoffs.get(f.job().jobId)!.outcome, "intent");
});
for (const role of ["verifier", "payer"] as const) {
  test("revocation after " + role + " cryptography preserves unknown outcome, not accepted success", async t => {
    const f = await setup(t), gate = barrier(); f[role].after(gate.wait);
    const pending = f.coordinator.coordinate("request", f.request, TOKEN), rejected = assert.rejects(pending);
    await gate.entered; f.revoke(); gate.release(); await rejected;
    assert.equal(f.verifier.signatures.length, 1);
    assert.equal(f.payer.signatures.length, role === "payer" ? 1 : 0);
    assert.equal(f.intent().state, "reconciliation_required");
    assert.equal(f.store.offlineHandoffs.get(f.job().jobId)!.outcome, "intent");
    await assert.rejects(f.create(f.open(), "new").coordinate("new_request", f.request, TOKEN));
  });
}
for (const phase of ["before", "after"] as const) {
  test("provider timeout " + phase + " cryptography retains intent and never retries late response", async t => {
    const f = await setup(t, { mode: "offline-mock" }, 25), gate = barrier();
    if (phase === "before") f.verifier.before(gate.wait); else f.verifier.after(gate.wait);
    await assert.rejects(f.coordinator.coordinate("request", f.request, TOKEN));
    assert.equal(f.intent().state, "reconciliation_required");
    assert.equal(f.job().recoveryReason, "authorization_uncertain");
    const journal = f.store.offlineHandoffs.get(f.job().jobId)!; assert.equal(journal.outcome, "uncertain");
    gate.release(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.store.offlineHandoffs.get(f.job().jobId), journal);
    assert.equal(f.verifier.signatures.length, phase === "after" ? 1 : 0); assert.equal(f.payer.signatures.length, 0);
    await assert.rejects(f.create(f.open(), "new").coordinate("new", f.request, TOKEN));
  });
}
for (const outcome of ["reject", "failure"] as const) {
  test("known mock " + outcome + " before provider is distinct from signatures attempted", async t => {
    const f = await setup(t, { mode: "offline-mock", outcome });
    await assert.rejects(f.coordinator.coordinate("request", f.request, TOKEN));
    assert.equal(f.verifier.signatures.length, 0); assert.equal(f.payer.signatures.length, 0);
    assert.equal(f.intent().state, "reconciliation_required");
    assert.equal(f.store.offlineHandoffs.get(f.job().jobId)!.outcome, outcome === "reject" ? "rejected" : "uncertain");
  });
}
for (const role of ["verifier", "payer"] as const) {
  test("invalid " + role + " response cannot commit a completed mock receipt", async t => {
    const f = await setup(t); f[role].response(() => new Uint8Array(64));
    await assert.rejects(f.coordinator.coordinate("request", f.request, TOKEN));
    assert.equal(f.intent().state, "reconciliation_required");
    assert.equal(f.store.offlineHandoffs.get(f.job().jobId)!.outcome, "uncertain");
    await assert.rejects(f.create(f.open()).coordinate("new", f.request, TOKEN));
  });
}
test("historical mock handoff never becomes signing permission", async t => {
  const f = await setup(t), old = f.create(f.store, "worker", false);
  const receipt = await old.coordinate("old", f.request, TOKEN);
  assert.equal(f.store.transactionIntents.listOutstandingIntents().entries.length, 0);
  await assert.rejects(f.simulator().simulate(old.readMockMessage(receipt), { checkpoint: () => {}, prepare: () => {} }));
  await assert.rejects(f.coordinator.coordinate("new", f.request, TOKEN));
  assert.equal(f.verifier.signatures.length, 0); assert.equal(f.payer.signatures.length, 0);
  assert.equal(f.store.offlineHandoffs.get(receipt.jobId)!.outcome, "recorded");
});
test("existing prepared intent is not promoted to a fresh signing attempt", async t => {
  const f = await setup(t); let created = false;
  f.onChain(async () => {
    const rows = f.store.jobs.listRecoveryRequired().entries;
    const j = rows[0]?.job;
    if (!created && j?.state === "authorization_pending") {
      created = true;
      const claim: JobClaim = { jobId: j.jobId, identity: j.identity, workerId: j.workerId!, generation: j.generation };
      const a = f.store.transactionIntents.createIntent(claim, j.revision, "old_preparation", f.config.feePayer).intent;
      f.store.transactionIntents.recordPreparation(claim, j.revision, a.intentId, a.identity, 0,
        { messageDigest: createHash("sha256").update(f.expected).digest("hex"), format: INTENT_FORMAT,
          blockhash: f.observation.blockhash, lastValidBlockHeight: "200", observedBlockHeight: "100" });
    }
  });
  await assert.rejects(f.coordinator.coordinate("request", f.request, TOKEN));
  assert.equal(f.verifier.signatures.length, 0); assert.equal(f.payer.signatures.length, 0);
  assert.equal(f.intent().state, "preparation_recorded"); assert.equal(f.intent().revision, 1);
});
test("mismatched simulator identities fail at configuration without reserving an operation", async t => {
  const f = await setup(t), wrong = ephemeral("fee_payer");
  const simulator = new OfflineDualSignatureSimulation(f.verifier.provider, wrong.provider, f.now);
  assert.throws(() => new DurableOfflineCoordinator(f.store, f.service, f.chain, f.config, "worker",
    f.source, f.now, { mode: "offline-mock" }, simulator));
  assert.equal(f.store.jobs.listRecoveryRequired().entries.length, 0);
});
test("HTTP server exposes no signer simulation or operational signing route", async () => {
  let calls = 0;
  const server = createVerifierServer({ verify: async () => { calls++; throw Error("forbidden"); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const a = server.address(); assert.ok(a && typeof a !== "string");
    for (const path of ["/sign", "/simulate-signing", "/signer/authorize", "/transactions/submit"]) {
      const response: Response = await fetch("http://127.0.0.1:" + a.port + path, {
        method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-only" },
        body: JSON.stringify({ approved: true }),
      });
      assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: "invalid_request" });
    }
    assert.equal(calls, 0);
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});

for (const phase of ["before-signing", "during-signing", "after-signatures", "after-receipt"] as const) {
  test("actual simulator crash " + phase + " retains v4 uncertainty without reusable signing authority", { timeout: 20000 }, async t => {
    const f = await setup(t), child = fork(new URL("./signature-process.js", import.meta.url), [f.path, phase],
      { stdio: ["ignore", "ignore", "pipe", "ipc", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    let stderr = ""; child.stderr!.on("data", chunk => { stderr += String(chunk); });
    try {
      const line = new Promise<string>((resolve, reject) => {
        let buffer = "";
        child.stdio[4]!.on("data", chunk => {
          buffer += String(chunk);
          if (buffer.includes("\n")) resolve(buffer.slice(0, buffer.indexOf("\n")));
        });
        child.stdio[4]!.once("error", reject);
      });
      const bytes = await Promise.race([line,
        once(child, "exit").then(() => { throw Error("child_exited_before_checkpoint: " + stderr); }),
      ]);
      const checkpoint = JSON.parse(bytes) as { verifier: string; feePayer: string; verifierSignatures: number; payerSignatures: number };
      const done = once(child, "exit"); child.kill("SIGKILL"); await done;
      const store = f.open(), job = store.jobs.listRecoveryRequired().entries[0]!.job;
      const intent = store.transactionIntents.listOutstandingIntents().entries[0]!;
      assert.equal(intent.state, "reconciliation_required"); assert.equal(intent.signingAuthorization, "not_granted");
      assert.equal(checkpoint.verifierSignatures, phase === "before-signing" ? 0 : 1);
      assert.equal(checkpoint.payerSignatures, phase === "after-signatures" || phase === "after-receipt" ? 1 : 0);
      assert.equal(store.offlineHandoffs.get(job.jobId)!.outcome, phase === "after-receipt" ? "recorded" : "intent");
      new PublicKey(checkpoint.verifier).toBuffer().copy(f.m, 104);
      const chain = new DevnetAttestationReader("https://api.devnet.solana.com", checkpoint.verifier, f.rpc);
      const state = await chain.read(job.bindings.milestone);
      const reconstructed = new Transaction({ feePayer: new PublicKey(checkpoint.feePayer), recentBlockhash: f.observation.blockhash })
        .add(buildAttestMilestoneInstruction(state, checkpoint.verifier)).serializeMessage();
      assert.equal(createHash("sha256").update(reconstructed).digest("hex"), intent.preparation!.messageDigest);
      assert.throws(() => takeOfflinePolicyMessage(reconstructed)); // Matching bytes/digest are not a capability.
      let verifications = 0;
      const restarted = new DurableOfflineCoordinator(store, { verify: async () => { verifications++; throw Error("must_not_verify"); } },
        chain, { ...f.config, verifier: checkpoint.verifier, feePayer: checkpoint.feePayer }, "restart_worker", f.source, f.now);
      await assert.rejects(restarted.coordinate("new_creation", f.request, TOKEN));
      assert.equal(verifications, 0);
      assert.throws(() => restarted.readSimulationEvidence({ mode: "offline-mock", receiptId: "offline-mock:" + job.jobId,
        jobId: job.jobId, messageDigest: intent.preparation!.messageDigest, signingAuthorization: "not_granted" }));
      assert.deepEqual(store.transactionIntents.getIntent(intent.intentId), intent);
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  });
}
