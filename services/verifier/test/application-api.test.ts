/** Auth resolution is a TEST dependency only; no production authentication provider is implemented. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { DevnetLifecycleReader, LifecycleStore } from "@proofwork/lifecycle";
import { SETTLEMENT_DEVNET_GENESIS, SETTLEMENT_DEVNET_RPC } from "@proofwork/finance-client";
import { ApplicationQueries } from "../src/application-queries.js";
import { APPLICATION_API_VERSION, applicationHealth, type ApiReply, type ApplicationResource } from "../src/application-api-contracts.js";
import { createVerifierServer } from "../src/server.js";
import { takeOfflinePolicyMessage } from "../src/transaction-policy.js";
import { ledgerFixture, mutateBytes, settled } from "./read-only-helpers.js";
import { TOKEN } from "./helpers.js";

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "pow-application-api-")), path = join(dir, "ledger.sqlite"), f = ledgerFixture(path);
  t.after(() => { f.s.close(); rmSync(dir, { recursive: true, force: true }); });
  let principal: unknown = { subject: "test_subject", role: "organization", wallet: f.job.bindings.sponsor };
  let authHook = async (_n: number): Promise<void> => {}, rpcHook = async (_method: string): Promise<void> => {};
  let authCalls = 0, genesis = SETTLEMENT_DEVNET_GENESIS;
  const calls: string[] = [], request: typeof fetch = async (url, init) => {
    assert.equal(url, SETTLEMENT_DEVNET_RPC); assert.equal(init!.redirect, "error");
    const message = JSON.parse(init!.body as string); calls.push(message.method); await rpcHook(message.method);
    const accounts = new Map(Object.values(f.accounts).map(v => [v.address, v.account]));
    assert(["getGenesisHash", "getMultipleAccounts"].includes(message.method), "no send/sign method");
    return Response.json({ jsonrpc: "2.0", id: 1, result: message.method === "getGenesisHash" ? genesis
      : { context: { slot: 200 }, value: message.params[0].map((address: string) => accounts.get(address) ?? null) } });
  };
  const authentication = { resolve: async () => { await authHook(++authCalls); return principal; } };
  const chain = { reader: new DevnetLifecycleReader("finalized", request), provenance: "offline_fixture" as const };
  const create = (timeoutMs = 1000) => new ApplicationQueries(f.s, { timeoutMs, authentication, chain });
  const query = (resource: ApplicationResource = "job") => ({ apiVersion: APPLICATION_API_VERSION, cluster: "devnet", resource, jobId: f.job.jobId });
  return { ...f, path, calls, authentication, chain, create, query, authCalls: () => authCalls,
    principal: (value: unknown) => { principal = value; }, onAuth: (fn: typeof authHook) => { authHook = fn; },
    onRpc: (fn: typeof rpcHook) => { rpcHook = fn; }, genesis: (value: string) => { genesis = value; } };
}
function safe(reply: ApiReply) {
  assert.equal(reply.body.apiVersion, APPLICATION_API_VERSION); assert.equal(reply.body.cluster, "devnet");
  assert.match(reply.body.requestId, /^[0-9a-f-]{36}$/); assert(Object.isFrozen(reply.body));
  assert.equal(reply.body.permissions.signingAuthorization, "not_granted");
  for (const [key, value] of Object.entries(reply.body.permissions)) if (key !== "signingAuthorization") assert.equal(value, false, key);
  for (const field of [TOKEN, "workerId", "actorId", "repositoryId", "contributorId", "nonce", "wireBase64", "signatureBase64", "messageDigest", "blockhash"])
    assert(!JSON.stringify(reply).includes(field), field);
}
for (const role of ["organization", "student", "operator"] as const) for (const resource of ["job", "execution", "milestone"] as const) {
  test("authorized internal " + role + " reads " + resource + " through real v5/reader interfaces", async t => {
    const f = setup(t), before = f.snapshot();
    f.principal({ subject: "test_" + role, role, wallet: role === "operator" ? null : f.job.bindings[role === "organization" ? "sponsor" : "student"] });
    const r = await f.create().read(f.query(resource)); assert.equal(r.statusCode, 200); safe(r); assert.equal(f.authCalls(), 2);
    assert.equal(r.body.provenance, resource === "milestone" ? "offline_fixture" : "lifecycle_v5_offline");
    assert.deepEqual(f.snapshot(), before); assert.equal(f.calls.length, resource === "milestone" ? 2 : 0);
  });
}
test("missing approved authentication adapter denies before storage or RPC", async t => {
  const f = setup(t); Object.defineProperty(f.s, "jobs", { get() { throw Error(TOKEN); } });
  const r = await new ApplicationQueries(f.s, { timeoutMs: 100 }).read(f.query());
  assert.equal(r.statusCode, 503); assert.equal(r.body.error!.code, "authentication_unavailable"); assert.deepEqual(f.calls, []); safe(r);
});
test("unauthenticated resolution rejects without database access", async t => {
  const f = setup(t); f.principal(null); Object.defineProperty(f.s, "jobs", { get() { throw Error(TOKEN); } });
  const r = await f.create().read(f.query()); assert.equal(r.statusCode, 401); assert.equal(r.body.error!.code, "authentication_required"); safe(r);
});
for (const resource of ["job", "execution", "milestone"] as const) test("wrong principal cannot read " + resource + " or discover its existence", async t => {
  const f = setup(t); f.principal({ subject: "other_org", role: "organization", wallet: f.job.bindings.student });
  const r = await f.create().read(f.query(resource)), missing = await f.create().read({ ...f.query(resource), jobId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
  assert.equal(r.statusCode, 404); assert.deepEqual(r.body.error, missing.body.error); assert.equal(r.body.data, null); assert.deepEqual(f.calls, []); safe(r);
});
for (const principal of [{ subject: "fake", role: "admin", wallet: null }, { subject: "fake", role: "operator", wallet: "bad" },
  { subject: "fake", role: "student", wallet: "bad" }, { subject: "fake", role: "operator", wallet: null, authenticated: true }])
  test("malformed principal from test auth boundary rejects " + JSON.stringify(principal), async t => {
    const f = setup(t); f.principal(principal); const r = await f.create().read(f.query()); assert.equal(r.statusCode, 401); safe(r);
  });
for (const patch of [{ apiVersion: "unknown" }, { cluster: "unsupported" }, { jobId: "bad" }, { resource: "settle" },
  { principal: { role: "operator" } }, { wallet: "unverified_address" }, { approved: true }, { endpoint: "unapproved" }])
  test("strict query input rejects " + Object.keys(patch)[0], async t => {
    const f = setup(t), r = await f.create().read({ ...f.query(), ...patch }); assert.equal(r.statusCode, 400);
    assert.equal(r.body.error!.code, "invalid_request"); assert.equal(f.authCalls(), 0); assert.deepEqual(f.calls, []); safe(r);
  });
test("request getters are rejected without execution", async t => {
  const f = setup(t); let count = 0; const request = f.query();
  Object.defineProperty(request, "jobId", { enumerable: true, get() { count++; return f.job.jobId; } });
  assert.equal((await f.create().read(request)).statusCode, 400); assert.equal(count, 0);
});
test("unknown authorized job returns no private details", async t => {
  const f = setup(t), r = await f.create().read({ ...f.query(), jobId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
  assert.equal(r.statusCode, 404); assert.equal(r.body.data, null); safe(r);
});
test("job view preserves unavailable historical verification details and timestamps", async t => {
  const f = setup(t), r = await f.create().read(f.query()); const v: any = r.body.data;
  assert.equal(v.state, "authorization_pending"); assert.equal(v.verificationOutcome, "passed");
  assert.equal(v.reconciliationRequired, true); assert.equal(v.fullVerificationResult, "not_persisted");
  assert.deepEqual(v.timestamps, { createdAt: null, startedAt: null, finishedAt: null }); safe(r);
});
test("revoked job projection uses a safe error classification, not operator or worker details", async t => {
  const f = setup(t); f.s.jobRecovery.interruptJob(f.job.jobId, f.job.identity, f.job.revision, "test_private_operator");
  const r = await f.create().read(f.query()); assert.equal((r.body.data as any).errorClassification, "reconciliation_required");
  assert(!JSON.stringify(r).includes("test_private_operator")); safe(r);
});
test("offline attempt never becomes a live transaction or payment claim", async t => {
  const f = setup(t); f.s.executionAttempts.markUncertain(f.claim, f.job.revision,
    { attemptId: f.attempt.attemptId, identity: f.attempt.identity, revision: f.attempt.revision }, "test_unknown");
  const r = await f.create().read(f.query("execution")), v: any = r.body.data;
  assert.equal(v.intentId, f.attempt.intent.intentId); assert.equal(v.mode, "offline-test-model"); assert.equal(v.phase, "submission_uncertain");
  assert.equal(v.operationalExecution, "unavailable"); assert.equal(v.offlineObservation, "unavailable");
  assert.equal(v.liveTransactionId, null); assert.equal(v.rewardPayment, "not_established"); safe(r);
});
test("indexed joins return the exact validated intent/attempt without mutation", t => {
  const f = setup(t), before = f.snapshot(); assert.equal(f.s.transactionIntents.getForJob(f.job.jobId)!.intentId, f.attempt.intent.intentId);
  assert.equal(f.s.executionAttempts.getForIntent(f.attempt.intent.intentId)!.attemptId, f.attempt.attemptId);
  assert.equal(f.s.transactionIntents.getForJob("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), undefined);
  assert.equal(f.s.executionAttempts.getForIntent("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), undefined);
  assert.throws(() => f.s.transactionIntents.getForJob("invalid")); assert.throws(() => f.s.executionAttempts.getForIntent("invalid"));
  assert.deepEqual(f.snapshot(), before);
});
for (const rejected of [false, true]) test("unprepared job remains " + (rejected ? "verification rejected" : "verification pending"), async t => {
  const f = setup(t), dir = mkdtempSync(join(tmpdir(), "pow-api-unprepared-")), s = new LifecycleStore(join(dir, "ledger.sqlite"));
  t.after(() => { s.close(); rmSync(dir, { recursive: true, force: true }); });
  let job = s.jobs.createOrGetJob("unprepared", f.job.bindings);
  if (rejected) {
    const c = s.jobs.claimJob(job.jobId, job.identity, job.revision, "test_worker");
    job = s.jobs.transitionJob(c.claim, c.job.revision, "verification_running");
    job = s.jobs.transitionJob(c.claim, job.revision, "verification_rejected");
  }
  const q = new ApplicationQueries(s, { timeoutMs: 1000, authentication: f.authentication });
  const result = await q.read({ ...f.query(), jobId: job.jobId }), view: any = result.body.data;
  assert.equal(result.statusCode, 200); assert.equal(view.state, rejected ? "verification_rejected" : "created");
  assert.equal(view.verificationOutcome, rejected ? "rejected" : "none");
  assert.equal(view.errorClassification, rejected ? "verification_rejected" : null); safe(result);
  const execution = await q.read({ ...f.query("execution"), jobId: job.jobId }), status: any = execution.body.data;
  assert.equal(execution.statusCode, 200); assert.equal(status.intentId, null); assert.equal(status.attemptId, null);
  assert.equal(status.preparation, "unavailable"); assert.equal(status.offlineObservation, "unavailable"); safe(execution);
});
test("no configured chain source is an explicit unavailable state", async t => {
  const f = setup(t), r = await new ApplicationQueries(f.s, { timeoutMs: 100, authentication: f.authentication }).read(f.query("milestone"));
  assert.equal(r.statusCode, 503); assert.equal(r.body.error!.code, "chain_reader_unavailable"); safe(r);
});
test("wrong Devnet genesis rejects without fallback", async t => {
  const f = setup(t); f.genesis("unsupported_genesis"); const r = await f.create().read(f.query("milestone"));
  assert.equal(r.body.error!.code, "chain_context_invalid"); assert.deepEqual(f.calls, ["getGenesisHash"]); safe(r);
});
for (const issue of ["missing", "owner", "size", "discriminator", "pda", "commitment"] as const) test("real account decoder rejects " + issue + " chain data", async t => {
  const f = setup(t);
  if (issue === "missing") (f.accounts.milestone as any).account = null;
  else if (issue === "owner") (f.accounts.milestone.account as any).owner = f.job.bindings.student;
  else if (issue === "size") (f.accounts.milestone.account!.data as [string,string])[0] = "AA==";
  else mutateBytes(f.accounts, "milestone", d => { const at = issue === "discriminator" ? 0 : issue === "pda" ? 273 : 200; d[at] = d[at]! ^ 1; });
  const r = await f.create().read(f.query("milestone")); assert.equal(r.statusCode, 503);
  assert.equal(r.body.error!.code, issue === "missing" ? "chain_state_unavailable" : issue === "commitment" ? "chain_state_mismatch" : "chain_state_invalid"); safe(r);
});
test("actual decoded amounts and timestamps remain lossless, with no invented payment/deployment proof", async t => {
  const f = setup(t); mutateBytes(f.accounts, "milestone", d => d.writeBigUInt64LE(0xffffffffffffffffn, 240));
  const r = await f.create().read(f.query("milestone")), v: any = r.body.data;
  assert.equal(v.rewardAmountRaw, "18446744073709551615"); assert.equal(v.status, "Verified");
  assert.equal(v.verifiedAt, "160"); assert.equal(v.programDeployment, "not_verified"); assert.equal(v.rewardPayment, "not_established"); safe(r);
});
test("settled completion can be observed but is not claimed as authenticated payment", async t => {
  const f = setup(t); settled(f); const r = await f.create().read(f.query("milestone")), v: any = r.body.data;
  assert.equal(v.status, "Settled"); assert.equal(v.settledAt, "170"); assert.equal(v.rewardPayment, "not_established"); safe(r);
});
test("database unavailable and unexpected dependency messages are safely classified", async t => {
  const f = setup(t); f.s.close(); const r = await f.create().read(f.query());
  assert.equal(r.body.error!.code, "storage_unavailable"); safe(r);
});
test("storage exception contents cannot leak credentials", async t => {
  const f = setup(t); Object.defineProperty(f.s, "jobs", { get() { throw Error(TOKEN); } });
  const r = await f.create().read(f.query()); assert.equal(r.body.error!.code, "dependency_unavailable"); safe(r);
});
for (const table of ["verification_job_history", "transaction_intent_history", "execution_history"]) test("indexed API reads fail closed on corrupt " + table, async t => {
  const f = setup(t), db = new DatabaseSync(f.path);
  const trigger = table === "verification_job_history" ? "verification_history_no_update" : table === "transaction_intent_history" ? "transaction_intent_history_no_update" : "execution_history_no_update";
  db.exec("DROP TRIGGER " + trigger + "; UPDATE " + table + " SET digest='corrupt' WHERE revision=0"); db.close();
  const r = await f.create().read(f.query("execution")); assert.equal(r.body.error!.code, "storage_integrity_failure"); safe(r);
});
test("authentication failure/timeout cannot leak tokens or permit later queries", async t => {
  const f = setup(t); f.onAuth(async () => { throw Error(TOKEN); });
  assert.equal((await f.create().read(f.query())).body.error!.code, "authentication_unavailable");
  f.onAuth(async () => { await new Promise(() => {}); });
  const r = await f.create(5).read(f.query()); assert.equal(r.body.error!.code, "authentication_unavailable"); assert.deepEqual(f.calls, []); safe(r);
});
test("RPC timeout does not retry or accept a late observation", async t => {
  const f = setup(t); let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  f.onRpc(async () => { await gate; }); const before = f.snapshot(), r = await f.create(5).read(f.query("milestone"));
  assert.equal(r.body.error!.code, "chain_timeout"); assert.equal(f.calls.length, 1); release();
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(f.authCalls(), 1); assert.deepEqual(f.snapshot(), before); safe(r);
});
test("RPC dependency exception is redacted with no fallback/retry", async t => {
  const f = setup(t); f.onRpc(async () => { throw Error(TOKEN); }); const r = await f.create().read(f.query("milestone"));
  assert.equal(r.body.error!.code, "chain_unavailable"); assert.equal(f.calls.length, 1); safe(r);
});
test("revoked authentication during awaited chain read suppresses its result", async t => {
  const f = setup(t); f.onRpc(async () => { f.principal(null); }); const r = await f.create().read(f.query("milestone"));
  assert.equal(r.statusCode, 401); assert.equal(r.body.data, null); safe(r);
});
test("changed authenticated subject during a read is rejected", async t => {
  const f = setup(t); f.onAuth(async n => { if (n === 2) f.principal({ subject: "replacement", role: "organization", wallet: f.job.bindings.sponsor }); });
  const r = await f.create().read(f.query()); assert.equal(r.body.error!.code, "authentication_changed"); safe(r);
});
test("concurrent job revision change yields an explicit stale read, never an update or retry", async t => {
  const f = setup(t); let changed = false;
  f.onRpc(async () => { if (!changed) { changed = true; f.s.jobRecovery.interruptJob(f.job.jobId, f.job.identity, f.job.revision, "operator"); } });
  const r = await f.create().read(f.query("milestone")); assert.equal(r.body.error!.code, "resource_changed"); assert.equal(r.body.data, null); safe(r);
});
test("schema v5 and read-only capability isolation are preserved", async t => {
  const f = setup(t), before = f.snapshot(), r = await f.create().read(f.query("execution"));
  assert.throws(() => takeOfflinePolicyMessage(r.body)); assert.throws(() => takeOfflinePolicyMessage(structuredClone(r.body)));
  assert.throws(() => f.s.executionAttempts.recordSubmissionIntent(f.claim, f.job.revision,
    { attemptId: f.attempt.attemptId, identity: f.attempt.identity, revision: f.attempt.revision }, r.body));
  assert.deepEqual(f.snapshot(), before); const db = new DatabaseSync(f.path, { readOnly: true });
  try { assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 6); assert.equal(db.prepare("PRAGMA journal_mode").get()!.journal_mode, "delete"); }
  finally { db.close(); }
});
test("health is non-sensitive and probes neither storage nor chain", () => {
  const r = applicationHealth(); assert.equal(r.statusCode, 200); assert.equal(r.body.availability, "limited");
  assert.equal(r.body.data!.storage, "not_probed"); assert.equal(r.body.data!.chain, "not_probed"); safe(r);
});
async function httpFixture(t: TestContext) {
  let calls = 0; const server = createVerifierServer({ verify: async () => { calls++; return { status: "failed", approved: false, outcomes: [], startedAt: "", finishedAt: "" }; } });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const at = server.address(); assert(at && typeof at === "object");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); });
  return { url: "http://127.0.0.1:" + at.port, calls: () => calls };
}
test("registered public health uses versioned JSON and existing security headers without invoking verifier", async t => {
  const f = await httpFixture(t), response = await fetch(f.url + "/api/v1/health", { headers: { authorization: "Bearer " + TOKEN } });
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff"); assert.match(response.headers.get("content-type")!, /application\/json/);
  const body = await response.json(); assert.equal(body.apiVersion, APPLICATION_API_VERSION); assert.equal(body.data.applicationReads, "http_routes_not_registered");
  assert(!JSON.stringify(body).includes(TOKEN)); assert.equal(f.calls(), 0);
});
for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) test("health rejects unsupported method " + method, async t => {
  const f = await httpFixture(t), response = await fetch(f.url + "/api/v1/health", { method });
  assert.equal(response.status, 405); assert.equal(response.headers.get("allow"), "GET"); assert.equal((await response.json()).error.code, "method_not_allowed"); assert.equal(f.calls(), 0);
});
for (const path of ["/api/v1/jobs", "/api/v1/milestones", "/api/v1/execution", "/api/v1/sign", "/api/v1/settle", "/api/v2/health", "/api/v1/health?cluster=unsupported"])
  test("sensitive/unsupported route remains unregistered " + path, async t => {
    const f = await httpFixture(t), response = await fetch(f.url + path, { headers: { authorization: "Bearer " + TOKEN } });
    assert.equal(response.status, 404); assert.equal((await response.json()).error.code, "route_not_registered"); assert.equal(f.calls(), 0);
  });
test("health retains Origin rejection and legacy verify request compatibility", async t => {
  const f = await httpFixture(t); assert.equal((await fetch(f.url + "/api/v1/health", { headers: { origin: "https://example.invalid" } })).status, 400);
  const legacy = await fetch(f.url + "/verify", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN }, body: "{}" });
  assert.equal(legacy.status, 200); assert.equal((await legacy.json()).approved, false); assert.equal(f.calls(), 1);
  assert.equal((await fetch(f.url + "/verify")).status, 400);
});
