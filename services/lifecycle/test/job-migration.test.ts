import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fork } from "node:child_process";
import { once } from "node:events";
import { LifecycleStore as V1Store } from "./fixtures/storage-v1.js";
import { bindings,error,temp } from "./job-helpers.js";
test("v1 migration fixture is the actual approved implementation",()=>{
 const source=readFileSync(new URL("../../test/fixtures/storage-v1.ts",import.meta.url),"utf8")
  .split("\n").slice(2).join("\n").replace('from "../../src/common.js"','from "./common.js"');
 const expected=readFileSync(new URL("../../test/fixtures/storage-v1.sha256",import.meta.url),"utf8").trim();
 assert.equal(createHash("sha256").update(source).digest("hex"),expected);
});
test("fresh v5 initialization and repeated opening share the original strict database",t=>{
 const x=temp(t),s=x.store(),raw=x.raw();
 assert.equal(raw.prepare("PRAGMA user_version").get()!.user_version,7);
 assert.equal(raw.prepare("PRAGMA journal_mode").get()!.journal_mode,"delete");
 const j=s.jobs.createOrGetJob("request",bindings());s.close();
 assert.deepEqual(x.store().jobs.getJob(j.jobId),j);
});
test("real v1 reservations and histories survive explicit migration to v4",async t=>{
 const x=temp(t),b=bindings(),old=new V1Store(x.path);
 const i=old.reserveInternship(b.sponsor,9007199254740993n),m=old.reserveMilestone(b.internship);
 old.transition(i.id,0,"prepared",{messageDigest:"ab".repeat(32)});
 const f=await old.reserveFallback({caller:b.verifier,sponsor:b.sponsor,student:b.student,internshipId:0n,milestoneId:0n,seed:"migration-fixture"});
 const records=[i,m,f].map(r=>old.get(r.id)!);const histories=records.map(r=>old.history(r.id));
 old.close();
 const current=x.store();
 for(const [n,r] of records.entries()){assert.deepEqual(current.get(r.id),r);assert.deepEqual(current.history(r.id),histories[n]);}
 assert.equal(current.reserveInternship(b.sponsor).value,9007199254740994n);
 assert.equal(current.jobs.createOrGetJob("new_job",b).state,"created");
 current.close();assert.throws(()=>new V1Store(x.path),error("schema_mismatch"));
});
test("altered v1 schema is rejected before creating job tables",t=>{
 const x=temp(t),old=new V1Store(x.path),r=old.reserveInternship(bindings().sponsor);old.close();
 const raw=x.raw();raw.exec("CREATE TABLE sqliteCache(value TEXT)");
 assert.throws(()=>x.store(),error("schema_mismatch"));
 assert.equal(raw.prepare("PRAGMA user_version").get()!.user_version,1);
 assert.equal(raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='verification_jobs'").get()!.n,0);
 assert.equal(raw.prepare("SELECT id FROM reservations").get()!.id,r.id);
});
test("foreign application and unsupported versions cannot be adopted",t=>{
 const x=temp(t),old=new V1Store(x.path);old.close();const raw=x.raw();
 raw.exec("PRAGMA application_id=123");assert.throws(()=>x.store(),error("schema_mismatch"));
 raw.exec("PRAGMA application_id=1347376972;PRAGMA user_version=8");
 assert.throws(()=>x.store(),error("schema_mismatch"));
});
test("unexpected current-schema objects and changed triggers fail exact schema validation",t=>{
 const x=temp(t);x.store().close();const raw=x.raw();
 raw.exec("DROP TRIGGER verification_job_no_delete");
 raw.exec("CREATE TRIGGER verification_job_no_delete BEFORE DELETE ON verification_jobs BEGIN SELECT 1; END");
 assert.throws(()=>x.store(),error("schema_mismatch"));
});
test("partial migration DDL/version writes roll back after process kill",{timeout:20000},async t=>{
 const x=temp(t),old=new V1Store(x.path),record=old.reserveInternship(bindings().sponsor);old.close();
 const child=fork(new URL("./job-process.js",import.meta.url),[x.path,"migration"],{stdio:["ignore","ignore","pipe","ipc"]});
 try{
  await once(child,"message");const done=once(child,"exit");child.kill("SIGKILL");await done;
  const legacy=new V1Store(x.path);assert.equal(legacy.get(record.id)!.value,0n);legacy.close();
  const current=x.store();assert.equal(current.get(record.id)!.value,0n);
  assert.equal(x.raw().prepare("PRAGMA user_version").get()!.user_version,7);
 }finally{if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");}
});
