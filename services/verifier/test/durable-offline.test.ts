import { fork } from "node:child_process";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicKey, Transaction } from "@solana/web3.js";
import { LifecycleStore } from "@proofwork/lifecycle";
import { DurableOfflineCoordinator, type OfflineMockOptions } from "../src/durable-offline-coordinator.js";
import { DevnetAttestationReader } from "../src/attestation-chain.js";
import { buildAttestMilestoneInstruction } from "../src/attestation.js";
import type { Failure } from "../src/errors.js";
import { createVerifierServer } from "../src/server.js";
import { VerifierService } from "../src/service.js";
import { GitHub } from "../src/github.js";
import { CASES } from "../src/manifest.js";
import { fixture, githubFetch, TOKEN } from "./helpers.js";

function barrier() {
  let release!: () => void, arrived!: () => void;
  const entered = new Promise<void>(r => { arrived = r; });
  const pending = new Promise<void>(r => { release = r; });
  return { entered, release, wait: async () => { arrived(); await pending; } };
}
async function setup(t: TestContext, options: OfflineMockOptions = { mode: "offline-mock" }) {
  const directory = mkdtempSync(join(tmpdir(), "pow-offline-")), path = join(directory, "jobs.sqlite");
  const stores: LifecycleStore[] = [];
  const open = () => { const s = new LifecycleStore(path); stores.push(s); return s; };
  t.after(() => { for (const s of stores) s.close(); rmSync(directory, { recursive: true, force: true }); });
  const store = open(), f = fixture();
  let githubUnavailable = false;
  const reader = new DevnetAttestationReader("https://api.devnet.solana.com", f.verifier.toBase58(), f.rpc);
  let chainReads = 0, blockReads = 0, time = 0, runs = 0;
  let onChain = async (_n: number) => {}, onBlock = async (_n: number) => {}, onRun = async () => {}, onGithub = async (_url: string) => {};
  const chain = { read: async (id: string) => { await onChain(++chainReads); return reader.read(id); } };
  const config = { verifier: f.verifier.toBase58(), feePayer: new PublicKey(f.i.subarray(8, 40)).toBase58(),
    maxAgeMs: 5000, minRemainingBlockHeights: 10 };
  const observation = { rpc: "https://api.devnet.solana.com" as const, genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    blockhash: new PublicKey(Buffer.alloc(32, 177)).toBase58(), lastValidBlockHeight: 200,
    currentBlockHeight: 100, observedAtMs: 0, valid: true };
  const blocks = { read: async () => { await onBlock(++blockReads); return { ...observation }; } };
  const service = new VerifierService(new GitHub(async (url, init) => {
    const response = githubUnavailable ? new Response("unavailable", { status: 503 }) : await githubFetch()(url, init); await onGithub(String(url)); return response;
  }), chain, { run: async () => {
    runs++; await onRun(); return CASES.map(c => ({ id: c.id, passed: true }));
  } });
  const create = (worker = "worker_a", s = store, o = options, v: Pick<VerifierService, "verify"> = service) =>
    new DurableOfflineCoordinator(s, v, chain, config, worker, blocks, () => time, o);
  const coordinator = create();
  const expected = new Transaction({ feePayer: new PublicKey(config.feePayer), recentBlockhash: observation.blockhash })
    .add(buildAttestMilestoneInstruction(await reader.read(f.request.milestone), config.verifier)).serializeMessage();
  const job = () => { const rows = store.jobs.listRecoveryRequired().entries; assert.equal(rows.length, 1); return rows[0]!.job; };
  const revoke = () => { const j = job(); return store.jobRecovery.interruptJob(j.jobId, j.identity, j.revision, "operator"); };
  return { ...f, path, store, open, coordinator, create, expected, job, revoke, config, observation, runs: () => runs,
    chainHook: (fn: typeof onChain) => { onChain = fn; }, blockHook: (fn: typeof onBlock) => { onBlock = fn; },
    githubUnavailable: (value: boolean) => { githubUnavailable = value; },
    githubHook: (fn: typeof onGithub) => { onGithub = fn; },
    runHook: (fn: typeof onRun) => { onRun = fn; }, clock: (n: number) => { time = n; } };
}

test("durable real verifier/authorizer/policy flow records only exact approved message", async t => {
  const f = await setup(t), receipt = await f.coordinator.coordinate("request", f.request, TOKEN);
  assert.deepEqual(f.coordinator.readMockMessage(receipt), f.expected);
  const copy = f.coordinator.readMockMessage(receipt); copy.fill(0);
  assert.deepEqual(f.coordinator.readMockMessage(receipt), f.expected);
  assert.throws(() => f.coordinator.readMockMessage({ ...receipt }));
  assert.equal(receipt.mode, "offline-mock"); assert.match(receipt.receiptId, /^offline-mock:/);
  assert.equal(receipt.signingAuthorization, "not_granted");
  const j = f.job(), h = f.store.offlineHandoffs.get(j.jobId)!;
  assert.equal(h.outcome, "recorded"); assert.equal(h.messageDigest, receipt.messageDigest);
  assert.deepEqual(f.store.jobs.getJobHistory(j.jobId).map(x => x.state),
    ["created", "claimed", "verification_running", "verification_completed", "authorization_pending"]);
  assert.equal(f.runs(), 1);
});
for (const variant of ["same", "creation", "worker", "restart"] as const) {
  test("permanent operation prevents duplicate handoff via " + variant, async t => {
    const f = await setup(t); const receipt = await f.coordinator.coordinate("first", f.request, TOKEN);
    const coordinator = variant === "same" ? f.coordinator : f.create(variant === "worker" ? "worker_b" : "worker_a",
      variant === "restart" ? f.open() : f.store);
    await assert.rejects(coordinator.coordinate(variant === "creation" ? "new_creation" : "first", f.request, TOKEN));
    assert.equal(f.runs(), 1); assert.equal(f.store.offlineHandoffs.get(receipt.jobId)!.outcome, "recorded");
    if (variant !== "same") assert.throws(() => coordinator.readMockMessage(receipt));
  });
}
test("concurrent coordinators sharing separate connections claim and hand off at most once", async t => {
  const f = await setup(t), other = f.create("worker_b", f.open());
  const results = await Promise.allSettled([f.coordinator.coordinate("a", f.request, TOKEN), other.coordinate("b", f.request, TOKEN)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(f.runs(), 1); assert.equal(f.store.offlineHandoffs.get(f.job().jobId)!.outcome, "recorded");
});
for (const patch of [
  { approved: true }, { transaction: new Uint8Array() }, { instructions: [] }, { jobId: "forged" },
  { signingAuthorization: "granted" }, { feePayer: "forged" },
]) {
  test("request cannot inject authority field " + Object.keys(patch)[0], async t => {
    const f = await setup(t);
    await assert.rejects(f.coordinator.coordinate("request", { ...f.request, ...patch }, TOKEN));
    assert.equal(f.store.jobs.listRecoveryRequired().entries.length, 0); assert.equal(f.runs(), 0);
  });
}
for (const field of ["commit", "repositoryId", "contributorId", "student", "milestone", "nonce"] as const) {
  test("changed request " + field + " cannot create a handoff", async t => {
    const f = await setup(t), request = { ...f.request };
    request[field] = field === "commit" ? "aa".repeat(20) : field === "nonce" ? "aa".repeat(32)
      : field === "student" || field === "milestone" ? f.internship.toBase58() : "9999";
    await assert.rejects(f.coordinator.coordinate("request", request, TOKEN));
    assert.equal(f.runs(), 0); assert.equal(f.store.jobs.listRecoveryRequired().entries.length, 0);
  });
}
for (const corrupt of ["verifier", "evidence", "requirements"] as const) {
  test("changed authoritative " + corrupt + " prevents handoff", async t => {
    const f = await setup(t);
    if (corrupt === "verifier") new PublicKey(f.request.student).toBuffer().copy(f.m, 104);
    else if (corrupt === "evidence") f.s[72] = f.s[72]! ^ 1;
    else f.m[200] = f.m[200]! ^ 1;
    await assert.rejects(f.coordinator.coordinate("request", f.request, TOKEN)); assert.equal(f.runs(), 0);
  });
}
test("forged trusted-service success still fails existing authoritative result checks", async t => {
  const f = await setup(t);
  const service = { verify: async () => ({ approved: true, status: "passed" as const, outcomes: [],
    startedAt: "", finishedAt: "", attestation: undefined }) };
  await assert.rejects(f.create("worker", f.store, { mode: "offline-mock" }, service).coordinate("request", f.request, TOKEN));
  assert.equal(f.store.offlineHandoffs.get(f.job().jobId), undefined);
});
test("worker replaced during real verification cannot publish its result", async t => {
  const f = await setup(t), gate = barrier(); f.runHook(gate.wait);
  const pending = f.coordinator.coordinate("first", f.request, TOKEN); const rejected = assert.rejects(pending);
  await gate.entered;
  const revoked = f.revoke();
  const replacement = f.store.jobs.claimJob(revoked.jobId, revoked.identity, revoked.revision, "worker_b");
  gate.release(); await rejected;
  assert.deepEqual(f.store.jobs.getJob(revoked.jobId), replacement.job);
  assert.equal(f.store.offlineHandoffs.get(revoked.jobId), undefined);
});
for (const phase of [2, 5, 6, 7, 8]) {
  test("revocation while chain read " + phase + " awaits prevents handoff", async t => {
    const f = await setup(t), gate = barrier();
    f.chainHook(async n => { if (n === phase) await gate.wait(); });
    const pending = f.coordinator.coordinate("first", f.request, TOKEN); const rejected = assert.rejects(pending);
    await gate.entered; f.revoke(); gate.release(); await rejected;
    assert.equal(f.store.offlineHandoffs.get(f.job().jobId), undefined);
  });
}
for (const phase of [1, 2, 3]) {
  test("revocation while blockhash read " + phase + " awaits prevents handoff", async t => {
    const f = await setup(t), gate = barrier();
    f.blockHook(async n => { if (n === phase) await gate.wait(); });
    const pending = f.coordinator.coordinate("first", f.request, TOKEN); const rejected = assert.rejects(pending);
    await gate.entered; f.revoke(); gate.release(); await rejected;
    assert.equal(f.store.offlineHandoffs.get(f.job().jobId), undefined);
  });
}
test("same-generation revision substitution is fenced before handoff", async t => {
  const f = await setup(t), gate = barrier(); f.runHook(gate.wait);
  const pending = f.coordinator.coordinate("first", f.request, TOKEN); const rejected = assert.rejects(pending);
  await gate.entered; const j = f.job();
  f.store.jobs.transitionJob({ jobId: j.jobId, identity: j.identity, generation: j.generation, workerId: j.workerId! },
    j.revision, "verification_completed");
  gate.release(); await rejected; assert.equal(f.store.offlineHandoffs.get(j.jobId), undefined);
});
test("revocation between intent and local mock effect leaves pending reconciliation, never a receipt", async t => {
  const gate = barrier(), f = await setup(t, { mode: "offline-mock", gate: { wait: gate.wait }, timeoutMs: 1000 });
  const pending = f.coordinator.coordinate("first", f.request, TOKEN); const rejected = assert.rejects(pending);
  await gate.entered;
  const j = f.job(); assert.equal(f.store.offlineHandoffs.get(j.jobId)!.outcome, "intent");
  f.revoke(); gate.release(); await rejected;
  assert.equal(f.store.offlineHandoffs.get(j.jobId)!.outcome, "intent");
  assert.equal(f.job().recoveryReason, "authorization_uncertain");
  await assert.rejects(f.create("new", f.open()).coordinate("new_creation", f.request, TOKEN));
});
for (const outcome of ["reject", "failure", "timeout"] as const) {
  test("mock " + outcome + " retains uncertainty/rejection across restart without retry", async t => {
    const gate = barrier(), f = await setup(t, { mode: "offline-mock",
      outcome: outcome === "timeout" ? "record" : outcome, gate: outcome === "timeout" ? { wait: gate.wait } : undefined, timeoutMs: 25 });
    await assert.rejects(f.coordinator.coordinate("first", f.request, TOKEN));
    const j = f.job(), recorded = f.store.offlineHandoffs.get(j.jobId)!;
    assert.equal(recorded.outcome, outcome === "reject" ? "rejected" : "uncertain");
    assert.equal(j.recoveryReason, "authorization_uncertain");
    gate.release(); await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(f.store.offlineHandoffs.get(j.jobId), recorded);
    await assert.rejects(f.create("replacement", f.open()).coordinate("new_creation", f.request, TOKEN));
    assert.equal(f.runs(), 1);
  });
}
for (const failure of ["blockhash", "lease", "expiration", "state"] as const) {
  test("real policy failure " + failure + " retains operation with no handoff", async t => {
    const f = await setup(t);
    f.blockHook(async n => {
      if (failure === "blockhash") f.observation.valid = false;
      if (failure === "lease" && n === 3) f.observation.blockhash = new PublicKey(Buffer.alloc(32, 178)).toBase58();
      if (failure === "expiration" && n === 2) { f.clock(5000); f.observation.observedAtMs = 5000; }
      if (failure === "state") f.m[272] = 4;
    });
    await assert.rejects(f.coordinator.coordinate("first", f.request, TOKEN));
    assert.equal(f.store.offlineHandoffs.get(f.job().jobId), undefined);
    await assert.rejects(f.create("new", f.open()).coordinate("new", f.request, TOKEN));
  });
}
test("mock boundary cannot be replaced with a message callback or operational mode", async t => {
  const f = await setup(t);
  for (const bad of [{ mode: "real" }, { mode: "offline-mock", sign: () => {} },
    { mode: "offline-mock", acceptAuthorizedMessage: () => {} }, { mode: "offline-mock", timeoutMs: 99999 }]) {
    assert.throws(() => f.create("worker", f.store, bad as OfflineMockOptions));
  }
  assert.equal(f.store.jobs.listRecoveryRequired().entries.length, 0);
});

test("durable bookkeeping is never accepted as a verification request or receipt", async t => {
  const f = await setup(t), receipt = await f.coordinator.coordinate("first", f.request, TOKEN), j = f.job();
  for (const metadata of [j, j.bindings, f.store.jobs.getJobHistory(j.jobId), f.store.offlineHandoffs.get(j.jobId), receipt]) {
    await assert.rejects(f.create("new", f.open()).coordinate("new_creation", metadata, TOKEN));
    assert.throws(() => f.coordinator.readMockMessage(structuredClone(metadata) as typeof receipt));
  }
  assert.equal(f.runs(), 1);
});
for (const payer of ["verifier", "internship"] as const) {
  test("durable flow preserves strict separate fee payer and account permissions: " + payer, async t => {
    const f = await setup(t); f.config.feePayer = payer === "verifier" ? f.config.verifier : f.internship.toBase58();
    await assert.rejects(f.create().coordinate("request", f.request, TOKEN));
    assert.equal(f.store.offlineHandoffs.get(f.job().jobId), undefined);
  });
}
test("trusted verification rejection is durably recorded without granting a ticket", async t => {
  const f = await setup(t);
  const rejecting = { verify: async () => ({ status: "failed" as const, approved: false, reason: "tests_failed" as const, outcomes: [],
    startedAt: "", finishedAt: "" }) };
  await assert.rejects(f.create("worker", f.store, { mode: "offline-mock" }, rejecting).coordinate("request", f.request, TOKEN));
  assert.equal(f.job().state, "verification_rejected");
  assert.equal(f.job().verificationOutcome, "rejected");
  assert.equal(f.store.offlineHandoffs.get(f.job().jobId), undefined);
  await assert.rejects(f.create("new", f.open()).coordinate("new_creation", f.request, TOKEN));
});
test("caller mutation during verification cannot change the durable evidence or exact bytes", async t => {
  const f = await setup(t), gate = barrier(); f.runHook(gate.wait);
  const pending = f.coordinator.coordinate("first", f.request, TOKEN);
  await gate.entered; const original = f.job();
  f.request.commit = "aa".repeat(20); f.request.student = f.config.feePayer; f.request.repositoryId = "9999";
  gate.release(); const receipt = await pending;
  assert.deepEqual(f.coordinator.readMockMessage(receipt), f.expected);
  assert.deepEqual(f.store.jobs.getJob(receipt.jobId)!.bindings, original.bindings);
});

for (const phase of ["before-intent", "during-intent", "recorded"] as const) {
  test("actual trusted coordinator crash at " + phase + " cannot resurrect authorization", { timeout: 15000 }, async t => {
    const f = await setup(t);
    const child = fork(new URL("./durable-offline-process.js", import.meta.url), [f.path, phase],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      const [message] = await once(child, "message"); assert.equal(message.ready, true);
      // Deliberately exceed the unchanged production gate timeout: the child must stay frozen.
      if (phase === "during-intent") await new Promise(resolve => setTimeout(resolve, 1200));
      const done = once(child, "exit"); child.kill("SIGKILL"); await done;
      const j = f.job(), h = f.open().offlineHandoffs.get(j.jobId);
      assert.equal(j.state, "authorization_pending");
      assert.equal(h?.outcome, phase === "before-intent" ? undefined : phase === "during-intent" ? "intent" : "recorded");
      await assert.rejects(f.create("restart", f.open()).coordinate("different_creation", f.request, TOKEN));
      assert.equal(f.runs(), 0);
      assert.equal(f.store.jobs.getJob(j.jobId)!.signingAuthorization, "not_granted");
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
}

test("HTTP server exposes neither signing nor durable authorization routes", async () => {
  let calls = 0;
  const server = createVerifierServer({ verify: async () => { calls++; throw new Error("forbidden_route"); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    for (const route of ["/sign", "/authorize", "/offline-authorize", "/jobs/authorize"]) {
      const response: Response = await fetch("http://127.0.0.1:" + address.port + route, {
        method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN },
        body: JSON.stringify({ approved: true, message: "forged" }),
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "invalid_request" });
    }
    assert.equal(calls, 0);
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});

test("revocation during GitHub verification prevents starting the acceptance runner", async t => {
  const f = await setup(t), gate = barrier();
  f.githubHook(async url => { if (url.endsWith("/user")) await gate.wait(); });
  const pending = f.coordinator.coordinate("first", f.request, TOKEN), rejected = assert.rejects(pending);
  await gate.entered; f.revoke(); gate.release(); await rejected;
  assert.equal(f.runs(), 0);
  assert.equal(f.store.offlineHandoffs.get(f.job().jobId), undefined);
});

for (const reason of ["infrastructure_failure", "request_in_progress", "github_api_failure", "github_rate_limit",
  "missing_commit", "missing_onchain_state", "invalid_onchain_state", "runner_timeout", "runner_unavailable",
  "runner_failure", "invalid_github_identity", undefined] as const) {
  test("transient/unclassified verifier failure " + reason + " permits only explicit pre-authorization recovery", async t => {
    const f = await setup(t);
    const transient = { verify: async () => ({ status: "failed" as const, approved: false, reason, outcomes: [],
      startedAt: "", finishedAt: "" }) };
    await assert.rejects(f.create("worker", f.store, { mode: "offline-mock" }, transient).coordinate("request", f.request, TOKEN));
    const failed = f.job();
    assert.equal(failed.state, "recovery_required"); assert.equal(failed.recoveryReason, "verification_interrupted");
    assert.equal(failed.verificationOutcome, "none"); assert.equal(f.store.offlineHandoffs.get(failed.jobId), undefined);
    // A recoverable pre-authorization interruption still uses the same permanent operation.
    const receipt = await f.create("replacement", f.open()).coordinate("different_creation", f.request, TOKEN);
    assert.equal(receipt.jobId, failed.jobId);
    assert.equal(f.store.jobs.getJob(failed.jobId)!.generation, failed.generation + 1);
    assert.equal(f.store.offlineHandoffs.get(receipt.jobId)!.outcome, "recorded");
  });
}
for (const reason of ["invalid_request", "invalid_manifest", "requirements_mismatch", "evidence_mismatch",
  "repository_mismatch", "commit_mismatch", "provenance_mismatch", "tests_failed"] as const satisfies readonly Failure[]) {
  test("definitive evidence rejection " + reason + " cannot restart authorization", async t => {
    const f = await setup(t);
    const rejecting = { verify: async () => ({ status: "failed" as const, approved: false, reason, outcomes: [],
      startedAt: "", finishedAt: "" }) };
    await assert.rejects(f.create("worker", f.store, { mode: "offline-mock" }, rejecting).coordinate("request", f.request, TOKEN));
    assert.equal(f.job().state, "verification_rejected");
    await assert.rejects(f.create("replacement", f.open()).coordinate("different_creation", f.request, TOKEN));
    assert.equal(f.store.offlineHandoffs.get(f.job().jobId), undefined);
  });
}

test("actual GitHub outage interrupts instead of permanently rejecting evidence", async t => {
  const f = await setup(t); f.githubUnavailable(true);
  await assert.rejects(f.coordinator.coordinate("first", f.request, TOKEN));
  const j = f.job(); assert.equal(j.recoveryReason, "verification_interrupted");
  assert.equal(j.verificationOutcome, "none"); assert.equal(f.runs(), 0);
  f.githubUnavailable(false);
  const receipt = await f.create("replacement", f.open()).coordinate("new_creation", f.request, TOKEN);
  assert.equal(receipt.jobId, j.jobId); assert.equal(f.runs(), 1);
});
