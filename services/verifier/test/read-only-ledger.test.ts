import {test} from "node:test";
import assert from "node:assert/strict";
import {fork,type ChildProcess} from "node:child_process";
import {once} from "node:events";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {LifecycleStore} from "@proofwork/lifecycle";
import {OfflineReadOnlyObservationAdapter} from "../src/read-only-observation.js";
import {ledgerFixture,mockSource} from "./read-only-helpers.js";
function setup(t:any){
 const dir=mkdtempSync(join(tmpdir(),"pow-readonly-observation-")),path=join(dir,"ledger.sqlite");
 const x=ledgerFixture(path);t.after(()=>{x.s.close();rmSync(dir,{recursive:true,force:true});});return {...x,path};
}
test("real schema-v5 execution lookup is read-only and existing trusted-observation capability cannot be forged",async t=>{
 const x=setup(t),before=x.snapshot();
 const r=await new OfflineReadOnlyObservationAdapter([mockSource(x.bundle)],x.lookup,{readTimeoutMs:1000}).observe(x.plan);
 assert.equal(r.classification,"matching_finalized_candidate");assert.deepEqual(x.snapshot(),before);
 assert.throws(()=>x.s.executionAttempts.recordSubmissionIntent(x.claim,x.job.revision,x.plan.attempt,r as any));
 const fence={jobId:x.job.jobId,identity:x.job.identity,revision:x.job.revision,generation:x.job.generation,workerId:x.job.workerId,operatorId:"operator"};
 assert.throws(()=>x.s.executionRecovery.applyObservation(fence,x.plan.attempt,r as any));
 assert.deepEqual(x.snapshot(),before);
 assert.equal(x.s.jobs.createOrGetJob("same_reserved_operation",x.plan.anchor.bindings).jobId,x.job.jobId);
 const db=new DatabaseSync(x.path);assert.equal(db.prepare("PRAGMA user_version").get()!.user_version,7);
 assert.equal(db.prepare("PRAGMA journal_mode").get()!.journal_mode,"delete");db.close();
});
test("external worker revocation between reads forces reconciliation without mutating attempts or releasing uniqueness",async t=>{
 const x=setup(t),originalAttempt=x.s.executionAttempts.get(x.attempt.attemptId),history=x.s.executionAttempts.history(x.attempt.attemptId);
 const source=mockSource(x.bundle),read=source.readAccounts;
 source.readAccounts=async q=>{x.s.jobRecovery.interruptJob(x.job.jobId,x.job.identity,x.job.revision,"operator");return read(q);};
 const r=await new OfflineReadOnlyObservationAdapter([source],x.lookup,{readTimeoutMs:1000}).observe(x.plan);
 assert.equal(r.classification,"reconciliation_required");assert(r.reasons.includes("execution_context_changed"));
 assert.equal(x.s.executionAttempts.get(x.attempt.attemptId)!.revision,originalAttempt!.revision);
 assert.deepEqual(x.s.executionAttempts.history(x.attempt.attemptId),history);
 assert.equal(x.s.executionAttempts.get(x.attempt.attemptId)!.reservationRetained,true);
});
test("reads after revocation stay offline and cannot revive prior worker authority",async t=>{
 const x=setup(t);x.s.jobRecovery.interruptJob(x.job.jobId,x.job.identity,x.job.revision,"operator");
 const before=x.snapshot(),r=await new OfflineReadOnlyObservationAdapter([mockSource(x.bundle)],x.lookup,{readTimeoutMs:1000}).observe(x.plan);
 assert.equal(r.reconciliationRequired,true);assert.equal(r.signingAuthorization,"not_granted");assert.equal(r.retryAuthorized,false);
 assert.deepEqual(x.snapshot(),before);assert.equal(x.s.executionAttempts.get(x.attempt.attemptId)!.intent.reconciliationRequired,true);
});
const windows=["before_read","during_status","after_status","during_accounts","between_status_accounts","after_complete",
 "during_classification","after_revocation","after_restart","missing_history"] as const;
for(const window of windows)test("real process kill at "+window+" preserves v5 ambiguity and permanent reservation",{timeout:20000},async t=>{
 const x=setup(t);
 if(window==="after_revocation")x.s.jobRecovery.interruptJob(x.job.jobId,x.job.identity,x.job.revision,"operator");
 const before=x.snapshot(),children:ChildProcess[]=[];
 t.after(()=>{for(const c of children)if(c.exitCode===null&&c.signalCode===null)c.kill("SIGKILL");});
 const child=fork(new URL("./read-only-process.js",import.meta.url),[x.path,window],{stdio:["ignore","ignore","pipe","ipc","pipe"]});
 children.push(child);const watchdog=setTimeout(()=>child.kill("SIGKILL"),12000);
 const exit=once(child,"exit");child.once("exit",()=>clearTimeout(watchdog));
 await once(child,"message");const checkpoint=once(child.stdio[4]!,"data");
 child.send({plan:x.plan,bundle:x.bundle});
 await Promise.race([checkpoint,exit.then(()=>{throw Error("missing_checkpoint_"+window);})]);child.kill("SIGKILL");await exit;
 const restarted=new LifecycleStore(x.path);
 try{
  assert.deepEqual(restarted.executionAttempts.get(x.attempt.attemptId),before.attempt);
  assert.deepEqual(restarted.executionAttempts.history(x.attempt.attemptId),before.history);
  assert.deepEqual(restarted.jobs.getJob(x.job.jobId),before.job);
  assert.deepEqual(restarted.transactionIntents.getIntentHistory(x.attempt.intent.intentId),before.intentHistory);
  const missing=structuredClone(x.bundle);(missing.status as any).evidence={kind:"missing",reason:"history_missing"};
  const r=await new OfflineReadOnlyObservationAdapter([mockSource(missing)],{get:id=>restarted.executionAttempts.get(id)},{readTimeoutMs:1000}).observe(x.plan);
  assert.equal(r.classification,"missing_evidence");assert.equal(r.retryAuthorized,false);assert.equal(r.reservationReleaseAuthorized,false);
  assert.deepEqual(restarted.executionAttempts.history(x.attempt.attemptId),before.history);
  assert.equal(restarted.jobs.createOrGetJob("restart_reserved_operation",x.plan.anchor.bindings).jobId,x.job.jobId);
 }finally{restarted.close();}
});
test("process restart does not hydrate observation authority from serialized complete fixture result",async t=>{
 const x=setup(t),observer=new OfflineReadOnlyObservationAdapter([mockSource(x.bundle)],x.lookup,{readTimeoutMs:1000});
 const result=JSON.parse(JSON.stringify(await observer.observe(x.plan))),before=x.snapshot();
 const reopened=new LifecycleStore(x.path);
 try{
  assert.throws(()=>reopened.executionAttempts.recordSubmissionIntent(x.claim,x.job.revision,x.plan.attempt,result));
  assert.deepEqual(x.snapshot(),before);
 }finally{reopened.close();}
});
