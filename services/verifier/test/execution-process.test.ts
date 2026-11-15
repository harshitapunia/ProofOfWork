import { test } from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LifecycleStore } from "@proofwork/lifecycle";
import { executionFixture, executionRef, controlFence } from "./execution-helpers.js";
const { LifecycleStore: V4Store } = await import(new URL("../../../lifecycle/dist/test/fixtures/storage-v4.js",import.meta.url).href);
function launch(path:string,mode:string) { return fork(new URL("./execution-process.js",import.meta.url),[path,mode],
  {stdio:["ignore","ignore","pipe","ipc","pipe"]}); }
async function setup(t:any,create=true) {
  const dir=mkdtempSync(join(tmpdir(),"pow-execution-process-")),path=join(dir,"ledger.sqlite");
  const x=await executionFixture(path,create);
  const children:ChildProcess[]=[];t.after(()=>{for(const c of children)if(c.exitCode===null&&c.signalCode===null)c.kill("SIGKILL");
    x.s.close();rmSync(dir,{recursive:true,force:true});});
  function child(mode:string) {
    const c=launch(path,mode);children.push(c);const watchdog=setTimeout(()=>c.kill("SIGKILL"),15000);
    c.once("exit",()=>clearTimeout(watchdog));return c;
  }
  return {...x,path,child};
}
const cases=[
  ["before-attempt","create","before"],["during-attempt","create","during"],["after-attempt","create","after"],
  ["before-submission-intent","signed","before"],["after-submission-intent","signed","after"],
  ["during-simulated-submission","simulate","inside-simulation"],["after-simulation-before-ack","simulate","pause"],
  ["during-ack","ack","during"],["after-ack","ack","after"],
  ["during-confirmation","confirmed","during"],["after-confirmed","confirmed","after"],
  ["during-finalization","finalized","during"],["after-revocation","uncertain","after"],
  ["before-restart","ack","after"],["after-restart","confirmed","after"],
] as const;
for(const [name,action,mode] of cases) {
 test("real process interruption "+name+" preserves committed evidence and never authorizes retry",{timeout:25000},async t=>{
  const x=await setup(t,action!=="create");let a=x.attempt;
  if(!["create","signed"].includes(action))a=await x.signed();
  if(["ack","confirmed","finalized"].includes(action))a=x.s.executionAttempts.recordSimulatedInvocation(x.claim,x.job.revision,executionRef(a),"invoke");
  if(action==="finalized")a=await x.record(a,{kind:"status",finality:2,outcome:"success",transactionSlot:"110",contextSlot:"111"});
  if(action==="uncertain")x.s.jobRecovery.interruptJob(x.job.jobId,x.job.identity,x.job.revision,"operator");
  const before=x.s.executionAttempts.list()[0],historyBefore=before?x.s.executionAttempts.history(before.attemptId):[];
  const patch=action==="ack"?{kind:"ack" as const}:action==="confirmed"||action==="finalized"
    ?{kind:"status" as const,finality:action==="finalized"?3:2,outcome:"success" as const,transactionSlot:"110",contextSlot:"111"}:{};
  const c=x.child(mode),exit=once(c,"exit");
  await once(c,"message");const checkpoint=once(c.stdio[4]!,"data");
  c.send({action:action==="ack"||action==="confirmed"||action==="finalized"?"observe":action,
    claim:x.claim,jobRevision:x.job.revision,requestId:"execution",intentId:x.intent.intentId,intentIdentity:x.intent.identity,
    authority:x.authorityKey,ref:a?executionRef(a):undefined,fence:a?controlFence(x.s,a):undefined,
    envelope:a?x.envelope(a,patch):undefined,state:x.f.state,eventId:"uncertain"});
  await Promise.race([checkpoint,exit.then(()=>{throw Error("missing_checkpoint");})]);
  c.kill("SIGKILL");await exit;
  const s=new LifecycleStore(x.path),rows=s.executionAttempts.list();
  if(mode==="before"||mode==="during") {
    assert.equal(rows.length,before?1:0);if(before)assert.deepEqual(s.executionAttempts.history(before.attemptId),historyBefore);
  }else {
    assert.equal(rows.length,1);assert.equal(rows[0]!.revision,(before?.revision??-1)+1);
    const expected=action==="create"?"execution_record_created":action==="signed"?"submission_intent_recorded":
      action==="simulate"?"submission_initiated":action==="ack"?"acknowledgment_observed":
      action==="confirmed"?"confirmed_success_observed":"submission_uncertain";
    assert.equal(rows[0]!.phase,expected);
    if(action==="confirmed"){assert.equal(rows[0]!.finality,2);assert.equal(rows[0]!.outcome,"success");assert.equal(rows[0]!.transactionSlot,"110");}
  }
  for(const row of rows) {
    assert.equal(row.retryAuthorized,false);assert.equal(row.submissionAuthorized,false);assert.equal(row.reservationRetained,true);
    assert.equal(row.rpcAuthenticated,false);assert.equal(row.reconciliationRequired,true);
    assert.equal(s.executionAttempts.history(row.attemptId).length,row.revision+1);
  }
  s.close();
 });
}
for(const action of ["create","signed","observe-success","observe-conflict","observe-replay"] as const) {
 test("two real Node processes arbitrate "+action+" with SQLite uniqueness and revision CAS",{timeout:25000},async t=>{
  const x=await setup(t,action!=="create");let a=x.attempt;
  if(action.startsWith("observe"))a=await x.signed();
  const children=[x.child("race"),x.child("race")],exits=children.map(c=>once(c,"exit"));
  await Promise.all(children.map(c=>once(c,"message")));
  const replies=children.map(c=>once(c,"message"));
  children.forEach((c,n)=>c.send({action:action.startsWith("observe")?"observe":action,claim:x.claim,jobRevision:x.job.revision,
    requestId:"race_"+n,intentId:x.intent.intentId,intentIdentity:x.intent.identity,authority:x.authorityKey,
    ref:a?executionRef(a):undefined,fence:a?controlFence(x.s,a):undefined,state:x.f.state,
    envelope:a?x.envelope(a,action.startsWith("observe")?{kind:"status",eventId:action==="observe-replay"?"same-event":"status_"+n,finality:2,
      outcome:action==="observe-conflict"&&n===1?"failure":"success",error:action==="observe-conflict"&&n===1?"InstructionError":null,
      transactionSlot:"110",contextSlot:"111"}:{}):undefined}));
  const results=(await Promise.all(replies)).map(([r])=>r as any);await Promise.all(exits);
  if(action==="create") {assert.equal(results.filter(r=>r.ok&&r.result.created).length,1);assert.equal(results.filter(r=>r.ok&&!r.result.created).length,1);}
  else {assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.filter(r=>!r.ok).length,1);}
  const row=x.s.executionAttempts.list()[0]!;assert.equal(x.s.executionAttempts.list().length,1);
  assert.equal(row.revision,action==="create"?0:action==="signed"?1:2);
 });
}
test("real write lock contention uses bounded busy failure, not an in-memory lock",{timeout:25000},async t=>{
  const x=await setup(t),c=x.child("hold"),exit=once(c,"exit");await once(c,"message");
  const checkpoint=once(c.stdio[4]!,"data");c.send({});await checkpoint;
  assert.throws(()=>new LifecycleStore(x.path,0),(e:any)=>e.code==="storage_busy");
  c.kill("SIGKILL");await exit;assert.equal(x.s.executionAttempts.list().length,1);
});
test("killed v5 DDL rolls back to genuine v4 and migrates safely on restart",{timeout:25000},async ()=>{
  const dir=mkdtempSync(join(tmpdir(),"pow-v5-crash-")),path=join(dir,"ledger.sqlite");
  const old=new V4Store(path);old.close();
  const c=launch(path,"migration"),watchdog=setTimeout(()=>c.kill("SIGKILL"),15000);
  try {
    const exit=once(c,"exit");await once(c,"message");const checkpoint=once(c.stdio[4]!,"data");c.send({});
    await checkpoint;c.kill("SIGKILL");await exit;
    const db=new DatabaseSync(path);assert.equal(db.prepare("PRAGMA user_version").get()!.user_version,4);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'execution_%'").get()!.n,0);db.close();
    const original=new V4Store(path);original.close();const current=new LifecycleStore(path);current.close();
  }finally{clearTimeout(watchdog);c.kill("SIGKILL");rmSync(dir,{recursive:true,force:true});}
});
