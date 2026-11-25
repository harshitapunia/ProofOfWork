import { test } from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { LifecycleStore as V3Store } from "./fixtures/storage-v3.js";
import { temp } from "./job-helpers.js";
import { ready } from "./intent-helpers.js";
function child(path: string, mode: string): ChildProcess {
  return fork(new URL("./intent-process.js", import.meta.url), [path, mode],
    { stdio: ["ignore", "ignore", "pipe", "ipc", "pipe"] });
}
for (const mode of ["race-create", "race-record"] as const) {
  test("separate Node processes atomically arbitrate " + mode, { timeout: 20000 }, async t => {
    const x = temp(t), s = x.store(), { job, claim } = ready(s);
    const a = mode === "race-record" ? s.transactionIntents.createIntent(claim, job.revision, "request", job.bindings.sponsor).intent : undefined;
    const children = [child(x.path, mode), child(x.path, mode)];
    const exits = children.map(c => once(c, "exit"));
    const timer = setTimeout(() => { for (const c of children) c.kill("SIGKILL"); }, 15000);
    try {
      await Promise.all(children.map(c => once(c, "message")));
      const replies = children.map(c => once(c, "message"));
      children.forEach((c, n) => c.send({ claim, jobRevision: job.revision, requestId: "request_" + n,
        payer: job.bindings.sponsor, intentId: a?.intentId, identity: a?.identity }));
      const results = (await Promise.all(replies)).map(([v]) => v as any);
      if (mode === "race-create") {
        assert.equal(results.filter(r => r.ok && r.result.created).length, 1);
        assert.equal(results.filter(r => r.ok && !r.result.created).length, 1);
        assert.equal(results[0].result.intent.intentId, results[1].result.intent.intentId);
      } else {
        assert.equal(results.filter(r => r.ok).length, 1);
        assert.equal(results.filter(r => !r.ok && r.code === "conflict").length, 1);
      }
      const rows = s.transactionIntents.listOutstandingIntents().entries;
      assert.equal(rows.length, 1); assert.equal(rows[0]!.signingAuthorization, "not_granted");
      assert.equal(s.transactionIntents.getIntentHistory(rows[0]!.intentId).length, mode === "race-record" ? 2 : 1);
      await Promise.all(exits);
    } finally { clearTimeout(timer); for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL"); }
  });
}
for (const mode of ["before-insert", "during-insert", "after-insert", "before-preparation",
  "during-record", "recorded", "uncertain", "revoked", "migration"] as const) {
  test("owned-process crash at " + mode + " preserves exact committed ledger state", { timeout: 20000 }, async t => {
    const x = temp(t);
    if (mode === "migration") { const old = new V3Store(x.path); ready(old); old.close(); }
    else { const s = x.store(); ready(s); s.close(); }
    const c = child(x.path, mode), timer = setTimeout(() => c.kill("SIGKILL"), 15000);
    try {
      await Promise.race([once(c.stdio[4]!, "data"), once(c, "exit").then(() => { throw Error("child_exited_before_checkpoint"); })]);
      const exit = once(c, "exit"); c.kill("SIGKILL"); await exit;
      if (mode === "migration") {
        const v3 = new V3Store(x.path); assert.equal(v3.jobs.listRecoveryRequired().entries.length, 1); v3.close();
      }
      const reopened = x.store(), rows = reopened.transactionIntents.listOutstandingIntents().entries;
      if (["before-insert", "during-insert", "migration"].includes(mode)) assert.equal(rows.length, 0);
      else {
        assert.equal(rows.length, 1);
        const value = rows[0]!;
        assert.equal(value.state, mode === "recorded" ? "preparation_recorded" : mode === "uncertain" ? "preparation_uncertain" : "created");
        assert.equal(value.reconciliationRequired, mode !== "recorded");
        assert.equal(value.signingAuthorization, "not_granted"); assert.equal(value.retryAuthorized, false);
        const j = reopened.jobs.getJob(value.jobId)!;
        const claim = { jobId: j.jobId, identity: j.identity, workerId: value.workerId, generation: value.generation };
        if (mode === "revoked") assert.throws(() => reopened.transactionIntents.createIntent(claim, j.revision, "new_request", value.feePayer));
        else {
          const again = reopened.transactionIntents.createIntent(claim, j.revision, "new_request", value.feePayer);
          assert.equal(again.created, false); assert.equal(again.intent.intentId, value.intentId);
        }
        assert.equal(reopened.transactionIntents.getIntentHistory(value.intentId).length, mode === "recorded" || mode === "uncertain" ? 2 : 1);
      }
      assert.equal(x.raw().prepare("PRAGMA user_version").get()!.user_version, 6);
    } finally { clearTimeout(timer); if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL"); }
  });
}
