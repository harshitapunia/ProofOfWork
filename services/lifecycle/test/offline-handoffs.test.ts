import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fork } from "node:child_process";
import { once } from "node:events";
import { LifecycleStore as V2Store } from "./fixtures/storage-v2.js";
import { bindings, error, temp } from "./job-helpers.js";

function pending(s: Pick<ReturnType<ReturnType<typeof temp>["store"]>, "jobs">) {
  const j = s.jobs.createOrGetJob("request", bindings()), c = s.jobs.claimJob(j.jobId, j.identity, 0, "worker");
  let job = s.jobs.transitionJob(c.claim, c.job.revision, "verification_running");
  job = s.jobs.transitionJob(c.claim, job.revision, "verification_completed");
  job = s.jobs.transitionJob(c.claim, job.revision, "authorization_pending");
  return { job, claim: c.claim };
}
const digest = "ab".repeat(32);
test("genuine v2 records and hash-chained job histories survive transactional v3 migration", t => {
  const x = temp(t), old = new V2Store(x.path), reservation = old.reserveInternship(bindings().sponsor);
  const { job, claim } = pending(old), history = old.jobs.getJobHistory(job.jobId);
  old.close();
  const s = x.store();
  assert.equal(x.raw().prepare("PRAGMA user_version").get()!.user_version, 3);
  assert.deepEqual(s.jobs.getJob(job.jobId), job); assert.deepEqual(s.jobs.getJobHistory(job.jobId), history);
  assert.deepEqual(s.get(reservation.id), reservation);
  assert.equal(s.offlineHandoffs.get(job.jobId), undefined);
  s.offlineHandoffs.begin(claim, job.revision, digest);
  assert.equal(s.offlineHandoffs.finish(claim, job.revision, digest, "recorded", "acknowledged").outcome, "recorded");
  s.close(); assert.throws(() => new V2Store(x.path), error("schema_mismatch"));
});
test("receipt intent/outcome are append only and permanent across connections", t => {
  const x = temp(t), s = x.store(), { job, claim } = pending(s);
  assert.throws(() => s.offlineHandoffs.finish(claim, job.revision, digest, "recorded", "acknowledged"));
  s.offlineHandoffs.begin(claim, job.revision, digest);
  assert.throws(() => s.offlineHandoffs.begin(claim, job.revision, digest), error("duplicate_handoff"));
  assert.throws(() => s.offlineHandoffs.finish(claim, job.revision, "cd".repeat(32), "recorded", "acknowledged"));
  const h = s.offlineHandoffs.finish(claim, job.revision, digest, "recorded", "acknowledged");
  assert.equal(h.signingAuthorization, "not_granted");
  assert.throws(() => s.offlineHandoffs.finish(claim, job.revision, digest, "recorded", "acknowledged"));
  const raw = x.raw();
  assert.throws(() => raw.exec("DELETE FROM verification_offline_handoffs"));
  assert.throws(() => raw.exec("UPDATE verification_offline_handoffs SET digest='forged'"));
  assert.deepEqual(x.store().offlineHandoffs.get(job.jobId), h);
});
for (const field of ["identity", "generation", "workerId", "revision"] as const) {
  test("handoff mutations reject stale/substituted " + field, t => {
    const s = temp(t).store(), { job, claim } = pending(s);
    const bad = { ...claim, ...(field === "identity" ? { identity: "00".repeat(32) }
      : field === "generation" ? { generation: 0 } : field === "workerId" ? { workerId: "other" } : {}) };
    const revision = field === "revision" ? job.revision - 1 : job.revision;
    assert.throws(() => s.offlineHandoffs.begin(bad, revision, digest));
    s.offlineHandoffs.begin(claim, job.revision, digest);
    assert.throws(() => s.offlineHandoffs.finish(bad, revision, digest, "recorded", "acknowledged"));
    assert.equal(s.offlineHandoffs.get(job.jobId)!.outcome, "intent");
  });
}
test("revoked intent remains valid historical evidence but cannot be completed by its former worker", t => {
  const s = temp(t).store(), { job, claim } = pending(s);
  s.offlineHandoffs.begin(claim, job.revision, digest);
  const revoked = s.jobRecovery.interruptJob(job.jobId, job.identity, job.revision, "operator");
  assert.equal(s.offlineHandoffs.get(job.jobId)!.outcome, "intent");
  assert.throws(() => s.offlineHandoffs.finish(claim, revoked.revision, digest, "recorded", "acknowledged"));
  assert.throws(() => s.jobs.claimJob(job.jobId, job.identity, revoked.revision, "replacement"));
});
test("mock rejection and recovery transition commit together", t => {
  const s = temp(t).store(), { job, claim } = pending(s);
  s.offlineHandoffs.begin(claim, job.revision, digest);
  s.offlineHandoffs.finish(claim, job.revision, digest, "rejected", "mock_rejected");
  assert.equal(s.jobs.getJob(job.jobId)!.recoveryReason, "authorization_uncertain");
  assert.equal(s.jobs.getJob(job.jobId)!.generation, claim.generation + 1);
});
test("failure transition rollback does not leave a committed outcome", t => {
  const x = temp(t), s = x.store(), { job, claim } = pending(s);
  s.offlineHandoffs.begin(claim, job.revision, digest);
  // Controlled database fault, outside the production API.
  x.raw().exec("CREATE TRIGGER fail_job_write BEFORE UPDATE ON verification_jobs BEGIN SELECT RAISE(ABORT,'test_failure'); END");
  assert.throws(() => s.offlineHandoffs.finish(claim, job.revision, digest, "uncertain", "mock_failure"));
  assert.equal(s.offlineHandoffs.get(job.jobId)!.outcome, "intent");
  assert.deepEqual(s.jobs.getJob(job.jobId), job);
});
test("altered v2 schema fails before adding v3 journal", t => {
  const x = temp(t), old = new V2Store(x.path); old.close();
  const raw = x.raw(); raw.exec("DROP TRIGGER verification_history_no_update");
  assert.throws(() => x.store(), error("schema_mismatch"));
  assert.equal(raw.prepare("PRAGMA user_version").get()!.user_version, 2);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='verification_offline_handoffs'").get()!.n, 0);
});
test("modified journal schema cannot be adopted on restart", t => {
  const x = temp(t); x.store().close();
  x.raw().exec("DROP TRIGGER verification_handoff_no_update");
  assert.throws(() => x.store(), error("schema_mismatch"));
});
for (const mode of ["migration-v3", "before-intent", "intent", "uncommitted-receipt", "recorded"] as const) {
  test("owned process crash at " + mode + " retains conservative recovery without retry", { timeout: 15000 }, async t => {
    const x = temp(t);
    if (mode === "migration-v3") {
      const old = new V2Store(x.path); pending(old); old.close();
    } else {
      const s = x.store(); pending(s); s.close();
    }
    const child = fork(new URL("./offline-process.js", import.meta.url), [x.path, mode], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      const [message] = await once(child, "message"); assert.equal(message.ready, true);
      const done = once(child, "exit"); child.kill("SIGKILL"); await done;
      const s = x.store(), job = s.jobs.listRecoveryRequired().entries[0]!.job;
      const h = s.offlineHandoffs.get(job.jobId);
      assert.equal(h?.outcome, mode === "recorded" ? "recorded" : ["intent", "uncommitted-receipt"].includes(mode) ? "intent" : undefined);
      assert.throws(() => s.jobs.claimJob(job.jobId, job.identity, job.revision, "restart"));
      assert.equal(job.signingAuthorization, "not_granted");
      assert.equal(s.jobs.createOrGetJob("new_creation", bindings()).jobId, job.jobId);
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  });
}

test("v2 migration fixture provenance matches approved main source", () => {
  for (const [name, expected] of [
    ["storage", "4d72d1803035dfd31d0afc15ff6a761f937a1981e7738f830255100f15cac42b"],
    ["schema", "27dfc186025c171a552b93c5c01aa1535f361679f8b36ffd449a3ecc625b89b8"],
  ]) {
    const source = readFileSync(new URL("../../test/fixtures/" + name + "-v2.ts", import.meta.url), "utf8")
      .split("\n").slice(1).join("\n").replaceAll('"../../src/common.js"', '"./common.js"')
      .replaceAll('"../../src/jobs.js"', '"./jobs.js"').replaceAll('"./schema-v2.js"', '"./schema.js"');
    assert.equal(createHash("sha256").update(source).digest("hex"), expected);
  }
});

for (const column of ["event", "digest"] as const) {
  test("corrupted journal " + column + " fails closed without authorizing", t => {
    const x = temp(t), s = x.store(), { job, claim } = pending(s);
    s.offlineHandoffs.begin(claim, job.revision, digest);
    const raw = x.raw(); raw.exec("DROP TRIGGER verification_handoff_no_update");
    raw.prepare("UPDATE verification_offline_handoffs SET " + column + "=? WHERE job_id=?")
      .run(column === "event" ? '["forged"]' : "00".repeat(32), job.jobId);
    assert.throws(() => s.offlineHandoffs.get(job.jobId), error("corrupt_store"));
    assert.throws(() => s.offlineHandoffs.finish(claim, job.revision, digest, "recorded", "acknowledged"));
    assert.equal(s.jobs.getJob(job.jobId)!.signingAuthorization, "not_granted");
  });
}
