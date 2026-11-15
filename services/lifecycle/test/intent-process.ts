import { DatabaseSync } from "node:sqlite";
import { writeSync } from "node:fs";
import { LifecycleStore } from "../src/index.js";
import { createTransactionIntents } from "../src/transaction-intents.js";
import { INTENT_SCHEMA_V4 } from "../src/schema.js";
import { metadata } from "./intent-helpers.js";
const [path, mode] = process.argv.slice(2) as [string, string];
function freeze(): never {
  writeSync(4, "checkpoint\n");
  process.kill(process.pid, "SIGSTOP"); // Owned Linux test child; freezes timers and synchronous DB work.
  throw Error("crash_fixture_must_not_resume");
}
if (mode === "migration") {
  const db = new DatabaseSync(path); db.exec("BEGIN IMMEDIATE"); db.exec(INTENT_SCHEMA_V4[0]!); db.exec("PRAGMA user_version=4");
  freeze();
} else if (mode === "race-create" || mode === "race-record") {
  const store = new LifecycleStore(path, 5000);
  process.once("message", (q: any) => {
    try {
      const result = mode === "race-create"
        ? store.transactionIntents.createIntent(q.claim, q.jobRevision, q.requestId, q.payer)
        : store.transactionIntents.recordPreparation(q.claim, q.jobRevision, q.intentId, q.identity, 0, metadata());
      process.send!({ ok: true, result }, () => { store.close(); process.disconnect(); });
    } catch (e) { process.send!({ ok: false, code: (e as { code?: string }).code }, () => { store.close(); process.disconnect(); }); }
  });
  process.send!({ ready: true });
} else {
  const store = new LifecycleStore(path, 5000), job = store.jobs.listRecoveryRequired().entries[0]!.job;
  const claim = { jobId: job.jobId, identity: job.identity, workerId: job.workerId!, generation: job.generation };
  if (mode === "before-insert") freeze();
  if (mode === "during-insert" || mode === "during-record") {
    if (mode === "during-record") store.transactionIntents.createIntent(claim, job.revision, "request", job.bindings.sponsor);
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys=ON; PRAGMA synchronous=EXTRA; PRAGMA trusted_schema=OFF");
    const intents = createTransactionIntents((fn, write = true) => {
      db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
      const value = fn(db);
      if (write) freeze(); // Actual production factory writes completed, but COMMIT has not happened.
      db.exec("COMMIT"); return value;
    });
    if (mode === "during-insert") intents.createIntent(claim, job.revision, "request", job.bindings.sponsor);
    else {
      const a = store.transactionIntents.listOutstandingIntents().entries[0]!;
      intents.recordPreparation(claim, job.revision, a.intentId, a.identity, 0, metadata());
    }
  } else {
    const a = store.transactionIntents.createIntent(claim, job.revision, "request", job.bindings.sponsor).intent;
    if (mode === "recorded") store.transactionIntents.recordPreparation(claim, job.revision, a.intentId, a.identity, 0, metadata());
    if (mode === "uncertain") store.transactionIntents.markPreparationUncertain(claim, job.revision, a.intentId, a.identity, 0);
    if (mode === "revoked") store.jobRecovery.interruptJob(job.jobId, job.identity, job.revision, "operator");
    freeze();
  }
}
