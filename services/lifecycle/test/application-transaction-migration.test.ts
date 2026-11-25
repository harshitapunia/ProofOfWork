import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LifecycleStore } from "../src/storage.js";
import {
  RESERVATION_SCHEMA_V1,
  JOB_SCHEMA_V2,
  HANDOFF_SCHEMA_V3,
  INTENT_SCHEMA_V4,
  EXECUTION_SCHEMA_V5,
  APPLICATION_TRANSACTION_SCHEMA_V6,
  APPLICATION_RECOVERY_SCHEMA_V7,
} from "../src/schema.js";
test("v5 database migrates additively and preserves old schema and rows", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "proofwork-v6-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.sqlite"),
    raw = new DatabaseSync(path);
  t.after(() => raw.close());
  for (const sql of [
    ...RESERVATION_SCHEMA_V1,
    ...JOB_SCHEMA_V2,
    ...HANDOFF_SCHEMA_V3,
    ...INTENT_SCHEMA_V4,
    ...EXECUTION_SCHEMA_V5,
  ])
    raw.exec(sql);
  raw.exec("PRAGMA application_id=1347376972; PRAGMA user_version=5");
  raw
    .prepare(
      "INSERT INTO counters VALUES('internship','fixture','00000000000000000001')"
    )
    .run();
  const before = raw
    .prepare("SELECT sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'")
    .all();
  const store = new LifecycleStore(path);
  t.after(() => store.close());
  assert.equal(raw.prepare("PRAGMA user_version").get()!.user_version, 7);
  assert.deepEqual(
    raw.prepare("SELECT * FROM counters").all(),
    [
      { kind: "internship", scope: "fixture", next: "00000000000000000001" },
    ].map((v) => Object.assign(Object.create(null), v))
  );
  const after = raw
    .prepare("SELECT sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'")
    .all();
  for (const row of before) assert(after.some((v) => v.sql === row.sql));
  for (const sql of [...APPLICATION_TRANSACTION_SCHEMA_V6,...APPLICATION_RECOVERY_SCHEMA_V7])
    assert(after.some((v) => v.sql === sql));
});
test("partial application schema is rejected without migration or row deletion", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "proofwork-v6-invalid-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.sqlite"),
    raw = new DatabaseSync(path);
  t.after(() => raw.close());
  raw.exec(APPLICATION_TRANSACTION_SCHEMA_V6[0]!);
  assert.throws(() => new LifecycleStore(path));
  assert.equal(raw.prepare("PRAGMA user_version").get()!.user_version, 0);
  assert(
    raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='application_transactions'"
      )
      .get()
  );
});

test("v6 history survives v7 and a new attempt cannot supersede a reserved send",t=>{
 const dir=mkdtempSync(join(tmpdir(),"proofwork-v7-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,"ledger.sqlite"),raw=new DatabaseSync(path);
 for(const sql of [
  ...RESERVATION_SCHEMA_V1,...JOB_SCHEMA_V2,...HANDOFF_SCHEMA_V3,...INTENT_SCHEMA_V4,...EXECUTION_SCHEMA_V5,...APPLICATION_TRANSACTION_SCHEMA_V6
 ])raw.exec(sql);
 raw.exec("PRAGMA application_id=1347376972; PRAGMA user_version=6");
 const id="11111111-1111-4111-8111-111111111111",wallet="249mMS9awYGUyMe22zabsSCo8cH4RDo3MeN3mAHFdy69",key="fixture-operation";
 const context="{}",hash="44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
 raw.prepare("INSERT INTO application_transactions VALUES(?,?,?,?,?,?,?,?,?,'signing_reserved',NULL,0,0)")
  .run(id,key,wallet,"old","ab".repeat(32),"cd".repeat(32),context,hash,"application-v1");
 const before=raw.prepare("SELECT * FROM application_transactions").all();raw.close();
 const store=new LifecycleStore(path);t.after(()=>store.close());
 const inspect=new DatabaseSync(path,{readOnly:true});t.after(()=>inspect.close());
 assert.equal(inspect.prepare("PRAGMA user_version").get()!.user_version,7);
 assert.deepEqual(inspect.prepare("SELECT * FROM application_transactions").all(),before);
 const record=(nextId:string,approvalId:string)=>({id:nextId,operationKey:key,wallet,approvalId,
  messageDigest:"ef".repeat(32),scopeDigest:"cd".repeat(32),context});
 const next="22222222-2222-4222-8222-222222222222";
 store.applicationTransactions.reserve(record(next,"next"),id);
 assert.deepEqual(inspect.prepare("SELECT * FROM application_transactions WHERE id=?").all(id),before);
 assert.throws(()=>store.applicationTransactions.transition(id,0,"unknown"),{code:"application_attempt_superseded"});
 // Use a structurally valid synthetic 64-byte signature. No wallet or live transaction.
 const sig="1".repeat(63)+"2";
 const signed=store.applicationTransactions.transition(next,0,"signed",sig);
 store.applicationTransactions.transition(next,signed.revision,"send_reserved");
 assert.throws(()=>store.applicationTransactions.reserve(record("33333333-3333-4333-8333-333333333333","third"),next),{code:"application_attempt_not_reopenable"});
 assert.equal(store.applicationTransactions.getForOperation(key)?.id,next);
});
