import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { LifecycleStore as V4Store } from "./fixtures/storage-v4.js";
import { migrateLifecycleSchema } from "../src/schema.js";
import { temp, bindings, error } from "./job-helpers.js";
import { ready, metadata } from "./intent-helpers.js";

test("genuine v4 schema/storage fixtures retain approved source provenance",()=>{
  for(const [name,hash] of [["storage","4c3e04bcce6f05e6551be7597945f5f4072a4ca5830d03d4ef17521b982055a7"],
    ["schema","4ab4e41f01ee78f8ac08e2f2e4d393121bfe0fb34830e42a7b9755cc98386f91"]]) {
    const text=readFileSync(new URL("../../test/fixtures/"+name+"-v4.ts",import.meta.url),"utf8").split("\n").slice(1).join("\n")
      .replaceAll('"../../src/common.js"','"./common.js"').replaceAll('"../../src/jobs.js"','"./jobs.js"')
      .replaceAll('"../../src/offline-handoffs.js"','"./offline-handoffs.js"').replaceAll('"../../src/transaction-intents.js"','"./transaction-intents.js"')
      .replaceAll('"./schema-v4.js"','"./schema.js"');
    assert.equal(createHash("sha256").update(text).digest("hex"),hash);
  }
});
test("genuine populated v4 migrates through v5 to v6 preserving every reservation/job/handoff/intent row and digest",t=>{
  const x=temp(t),old=new V4Store(x.path),b=bindings(),r=old.reserveInternship(b.sponsor,9007199254740993n);
  old.transition(r.id,0,"prepared",{messageDigest:"ab".repeat(32)});
  const c=ready(old);old.offlineHandoffs.begin(c.claim,c.job.revision,"cd".repeat(32));
  old.offlineHandoffs.finish(c.claim,c.job.revision,"cd".repeat(32),"recorded","acknowledged");
  const i=old.transactionIntents.createIntent(c.claim,c.job.revision,"intent",b.sponsor).intent;
  old.transactionIntents.recordPreparation(c.claim,c.job.revision,i.intentId,i.identity,0,metadata());
  old.transactionIntents.requireReconciliation(c.claim,c.job.revision,i.intentId,i.identity,1);
  old.close();
  const db=x.raw(),tables=["counters","reservations","history","verification_jobs","verification_job_history",
    "verification_offline_handoffs","transaction_intents","transaction_intent_history"];
  const rows=()=>tables.map(t=>db.prepare("SELECT * FROM "+t+" ORDER BY rowid").all()),before=rows();
  const s=x.store();assert.deepEqual(rows(),before);assert.equal(db.prepare("PRAGMA user_version").get()!.user_version,7);
  assert.equal(s.reserveInternship(b.sponsor).value,9007199254740994n);
  assert.equal(s.transactionIntents.getIntent(i.intentId)!.state,"reconciliation_required");
  assert.equal(s.executionAttempts.list().length,0);
  assert.throws(()=>new V4Store(x.path),error("schema_mismatch"));
});
test("v5 migration failure rolls back both new tables, triggers and version atomically",t=>{
  const x=temp(t),old=new V4Store(x.path);old.reserveInternship(bindings().sponsor);old.close();
  const db=x.raw(),instrumented=db as unknown as {setAuthorizer(fn:((a:number,t:string|null)=>number)|null):void};
  instrumented.setAuthorizer((_a,t)=>t==="execution_history"?1:0);
  db.exec("BEGIN IMMEDIATE");assert.throws(()=>migrateLifecycleSchema(db));db.exec("ROLLBACK");
  instrumented.setAuthorizer(null);
  assert.equal(db.prepare("PRAGMA user_version").get()!.user_version,4);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'execution_%'").get()!.n,0);
  const same=new V4Store(x.path);assert.equal(same.listOutstanding().length,1);same.close();
  assert.equal(x.store().executionAttempts.list().length,0);
});
test("altered v4 and foreign/unknown versions cannot be implicitly repaired",t=>{
  const x=temp(t),old=new V4Store(x.path);old.close();const db=x.raw();
  db.exec("DROP TRIGGER transaction_intent_no_delete");
  assert.throws(()=>x.store(),error("schema_mismatch"));
  assert.equal(db.prepare("PRAGMA user_version").get()!.user_version,4);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='execution_attempts'").get()!.n,0);
});
