import { DatabaseSync } from "node:sqlite";
import { LifecycleStore } from "../src/index.js";
import { HANDOFF_SCHEMA_V3 } from "../src/schema.js";
const [path, mode] = process.argv.slice(2) as [string, string];
if (mode === "migration-v3") {
  const db = new DatabaseSync(path); db.exec("BEGIN IMMEDIATE");
  db.exec(HANDOFF_SCHEMA_V3[0]!); db.exec("PRAGMA user_version=3");
} else {
  const s = new LifecycleStore(path), job = s.jobs.listRecoveryRequired().entries[0]!.job;
  const claim = { jobId: job.jobId, identity: job.identity, workerId: job.workerId!, generation: job.generation };
  if (mode !== "before-intent") s.offlineHandoffs.begin(claim, job.revision, "ab".repeat(32));
  if (mode === "recorded") s.offlineHandoffs.finish(claim, job.revision, "ab".repeat(32), "recorded", "acknowledged");
  if (mode === "uncommitted-receipt") {
    const db = new DatabaseSync(path); db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO verification_offline_handoffs VALUES(?,1,?,?)").run(job.jobId, "[]", "uncommitted");
  }
}
process.send!({ ready: true });
process.on("message", () => {}); // Parent kills only this owned crash fixture.
