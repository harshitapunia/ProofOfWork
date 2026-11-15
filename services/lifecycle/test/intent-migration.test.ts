import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { LifecycleStore as V1Store } from "./fixtures/storage-v1.js";
import { LifecycleStore as V2Store } from "./fixtures/storage-v2.js";
import { LifecycleStore as V3Store } from "./fixtures/storage-v3.js";
import { migrateLifecycleSchema } from "../src/schema.js";
import { bindings, error, temp } from "./job-helpers.js";
import { ready, metadata } from "./intent-helpers.js";

test("genuine v3 fixture provenance matches approved main source exactly after import reversal", () => {
  for (const [name, expected] of [
    ["storage", "ee274ee9961853fa561eb8e598be3c33c49e35f402200eab695c0fb61e7c66f9"],
    ["schema", "41db58163fbaa3c3b2d2f1d38bd2eba5e08ff0cac64fe87784b65cc102d58911"],
  ]) {
    const text = readFileSync(new URL("../../test/fixtures/" + name + "-v3.ts", import.meta.url), "utf8")
      .split("\n").slice(1).join("\n").replaceAll('"../../src/common.js"', '"./common.js"')
      .replaceAll('"../../src/jobs.js"', '"./jobs.js"').replaceAll('"../../src/offline-handoffs.js"', '"./offline-handoffs.js"')
      .replaceAll('"./schema-v3.js"', '"./schema.js"');
    assert.equal(createHash("sha256").update(text).digest("hex"), expected);
  }
});
for (const version of [1, 2, 3] as const) {
  test("real v" + version + "-to-v4 migration preserves every historical row and hash", async t => {
    const x = temp(t), b = bindings();
    const old = version === 1 ? new V1Store(x.path) : version === 2 ? new V2Store(x.path) : new V3Store(x.path);
    const reserved = old.reserveInternship(b.sponsor, 9007199254740993n);
    old.transition(reserved.id, 0, "prepared", { messageDigest: "ab".repeat(32) });
    if (old instanceof V2Store || old instanceof V3Store) {
      const c = ready(old);
      if (old instanceof V3Store) {
        old.offlineHandoffs.begin(c.claim, c.job.revision, "cd".repeat(32));
        old.offlineHandoffs.finish(c.claim, c.job.revision, "cd".repeat(32), "recorded", "acknowledged");
      }
    }
    old.close();
    const raw = x.raw();
    const tables = ["counters", "reservations", "history", ...(version >= 2 ? ["verification_jobs", "verification_job_history"] : []),
      ...(version === 3 ? ["verification_offline_handoffs"] : [])];
    const before = tables.map(name => raw.prepare("SELECT * FROM " + name + " ORDER BY rowid").all());
    assert.equal(raw.prepare("PRAGMA user_version").get()!.user_version, version);
    const current = x.store();
    assert.equal(raw.prepare("PRAGMA user_version").get()!.user_version, 4);
    assert.deepEqual(tables.map(name => raw.prepare("SELECT * FROM " + name + " ORDER BY rowid").all()), before);
    assert.equal(current.reserveInternship(b.sponsor).value, 9007199254740994n);
    assert.equal(current.transactionIntents.listOutstandingIntents().entries.length, 0);
    current.close(); assert.throws(() => version === 1 ? new V1Store(x.path) : version === 2 ? new V2Store(x.path) : new V3Store(x.path), error("schema_mismatch"));
  });
}
test("v3 altered schema is rejected before adding any v4 objects", t => {
  const x = temp(t), old = new V3Store(x.path); old.close(); const raw = x.raw();
  raw.exec("DROP TRIGGER verification_handoff_no_update");
  assert.throws(() => x.store(), error("schema_mismatch"));
  assert.equal(raw.prepare("PRAGMA user_version").get()!.user_version, 3);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='transaction_intents'").get()!.n, 0);
});
test("transactional v4 migration failure rolls back all DDL and version changes", t => {
  const x = temp(t), old = new V3Store(x.path); const r = old.reserveInternship(bindings().sponsor); old.close();
  const raw = x.raw();
  // Pinned Node's test-only authorizer fault denies the second new table.
  const instrumented = raw as unknown as { setAuthorizer(fn: ((action: number, table: string | null) => number) | null): void };
  instrumented.setAuthorizer((_action, table) => table === "transaction_intent_history" ? 1 : 0); // SQLITE_DENY / SQLITE_OK.
  raw.exec("BEGIN IMMEDIATE");
  assert.throws(() => migrateLifecycleSchema(raw));
  raw.exec("ROLLBACK"); instrumented.setAuthorizer(null);
  assert.equal(raw.prepare("PRAGMA user_version").get()!.user_version, 3);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='transaction_intents'").get()!.n, 0);
  const original = new V3Store(x.path); assert.equal(original.get(r.id)!.value, 0n); original.close();
  assert.equal(x.store().get(r.id)!.value, 0n);
});
for (const table of ["transaction_intents", "transaction_intent_history"] as const) {
  test(table + " cannot be deleted and intent identity cannot be rewritten", t => {
    const x = temp(t), s = x.store(), { job, claim } = ready(s);
    const a = s.transactionIntents.createIntent(claim, job.revision, "request", job.bindings.sponsor).intent;
    const raw = x.raw();
    assert.throws(() => raw.exec("DELETE FROM " + table));
    for (const column of ["intent_id", "request_id", "job_id", "fee_payer", "identity"])
      assert.throws(() => raw.prepare("UPDATE transaction_intents SET " + column + "=?").run("forged"));
    assert.throws(() => raw.exec("UPDATE transaction_intent_history SET digest='forged'"));
    assert.deepEqual(s.transactionIntents.getIntent(a.intentId), a);
  });
}
for (const column of ["state", "revision", "identity"] as const) {
  test("intent head corruption " + column + " fails closed", t => {
    const x = temp(t), s = x.store(), { job, claim } = ready(s);
    const a = s.transactionIntents.createIntent(claim, job.revision, "request", job.bindings.sponsor).intent;
    const raw = x.raw(); raw.exec("DROP TRIGGER transaction_intent_identity_immutable");
    raw.prepare("UPDATE transaction_intents SET " + column + "=?").run(column === "state" ? "preparation_recorded" : column === "revision" ? 1 : "cd".repeat(32));
    assert.throws(() => s.transactionIntents.getIntent(a.intentId), error("corrupt_store"));
    assert.throws(() => s.transactionIntents.listOutstandingIntents(), error("corrupt_store"));
  });
}
for (const column of ["event", "digest"] as const) {
  test("intent history corruption " + column + " fails closed", t => {
    const x = temp(t), s = x.store(), { job, claim } = ready(s);
    const a = s.transactionIntents.createIntent(claim, job.revision, "request", job.bindings.sponsor).intent;
    const raw = x.raw(); raw.exec("DROP TRIGGER transaction_intent_history_no_update");
    raw.prepare("UPDATE transaction_intent_history SET " + column + "=?").run(column === "event" ? '["forged"]' : "cd".repeat(32));
    assert.throws(() => s.transactionIntents.getIntentHistory(a.intentId), error("corrupt_store"));
  });
}
test("failed history append rolls back head mutation and preserves permanent operation", t => {
  const x = temp(t), s = x.store(), { job, claim } = ready(s);
  const a = s.transactionIntents.createIntent(claim, job.revision, "request", job.bindings.sponsor).intent;
  x.raw().exec("CREATE TRIGGER fail_intent_history BEFORE INSERT ON transaction_intent_history BEGIN SELECT RAISE(ABORT,'test_fault'); END");
  assert.throws(() => s.transactionIntents.recordPreparation(claim, job.revision, a.intentId, a.identity, 0, metadata()));
  assert.deepEqual(s.transactionIntents.getIntent(a.intentId), a);
  assert.equal(s.transactionIntents.createIntent(claim, job.revision, "alias", job.bindings.sponsor).created, false);
});
test("current v4 exact schema detects dropped intent triggers on restart", t => {
  const x = temp(t); x.store().close(); x.raw().exec("DROP TRIGGER transaction_intent_no_delete");
  assert.throws(() => x.store(), error("schema_mismatch"));
});
