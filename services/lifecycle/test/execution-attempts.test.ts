import { test } from "node:test";
import assert from "node:assert/strict";
import { temp, error } from "./job-helpers.js";
import { ready, metadata } from "./intent-helpers.js";
import { type ExecutionControlFence } from "../src/index.js";
const ref=(a:{attemptId:string;identity:string;revision:number})=>({attemptId:a.attemptId,identity:a.identity,revision:a.revision});
function setup(t:any) {
  const x=temp(t),s=x.store(),{job,claim}=ready(s);
  const i=s.transactionIntents.createIntent(claim,job.revision,"intent",job.bindings.sponsor).intent;
  const intent=s.transactionIntents.recordPreparation(claim,job.revision,i.intentId,i.identity,0,metadata());
  const create=(request="attempt")=>s.executionAttempts.create(claim,job.revision,request,intent.intentId,intent.identity,job.bindings.student);
  const attempt=create().attempt;
  const fence:ExecutionControlFence={jobId:job.jobId,identity:job.identity,revision:job.revision,
    generation:job.generation,workerId:job.workerId,operatorId:"operator"};
  return {x,s,job,claim,intent,attempt,create,fence};
}
test("same DB connections retain one canonical attempt and first request identity",t=>{
  const a=setup(t),other=a.x.store();
  const again=other.executionAttempts.create(a.claim,a.job.revision,"alias",a.intent.intentId,a.intent.identity,a.job.bindings.student);
  assert.equal(again.created,false);assert.deepEqual(again.attempt,a.attempt);
  assert.equal(again.attempt.requestId,"attempt");assert.equal(a.s.executionAttempts.list().length,1);
  assert.equal(a.s.executionAttempts.history(a.attempt.attemptId).length,1);
});
for(const changed of ["identity","workerId","generation","revision"] as const) {
  test("worker mutation fences changed "+changed,t=>{
    const a=setup(t),claim={...a.claim,...(changed==="identity"?{identity:"ab".repeat(32)}:
      changed==="workerId"?{workerId:"other"}:changed==="generation"?{generation:0}:{})};
    assert.throws(()=>a.s.executionAttempts.markUncertain(claim,changed==="revision"?0:a.job.revision,ref(a.attempt),"uncertain"));
    assert.deepEqual(a.s.executionAttempts.get(a.attempt.attemptId),a.attempt);
  });
}
for(const changed of ["jobId","identity","revision","generation","workerId"] as const) {
  test("trusted recovery requires explicit current fence "+changed,t=>{
    const a=setup(t),f={...a.fence,...(changed==="jobId"?{jobId:a.attempt.attemptId}:changed==="identity"?{identity:"ab".repeat(32)}:
      changed==="revision"?{revision:0}:changed==="generation"?{generation:0}:{workerId:"other"})};
    assert.throws(()=>a.s.executionRecovery.requireReconciliation(f,ref(a.attempt),"control"));
    assert.equal(a.s.executionAttempts.history(a.attempt.attemptId).length,1);
  });
}
test("retired v4 preparation may only be referenced as audit metadata, never promoted or reopened",t=>{
  const a=setup(t);
  a.s.transactionIntents.requireReconciliation(a.claim,a.job.revision,a.intent.intentId,a.intent.identity,1);
  assert.equal(a.create("alias").created,false);
  const retained=a.s.executionAttempts.get(a.attempt.attemptId)!;
  assert.equal(retained.intent.state,"reconciliation_required");assert.equal(retained.submissionAuthorized,false);
  assert.throws(()=>a.s.executionAttempts.recordSubmissionIntent(a.claim,a.job.revision,ref(retained),retained.intent));
  assert.throws(()=>a.s.executionAttempts.recordSubmissionIntent(a.claim,a.job.revision,ref(retained),a.s.offlineHandoffs));
});
for(const column of ["attempt_id","request_id","intent_id","observation_authority","identity"] as const) {
  test("execution header immutable "+column,t=>{
    const a=setup(t);assert.throws(()=>a.x.raw().prepare("UPDATE execution_attempts SET "+column+"=?").run("forged"));
    assert.deepEqual(a.s.executionAttempts.get(a.attempt.attemptId),a.attempt);
  });
}
for(const table of ["execution_attempts","execution_history"]) {
  test("permanent "+table+" forbids deletion and history rewrite",t=>{
    const a=setup(t),db=a.x.raw();assert.throws(()=>db.exec("DELETE FROM "+table));
    assert.throws(()=>db.exec("UPDATE execution_history SET digest='forged'"));
    assert.deepEqual(a.s.executionAttempts.get(a.attempt.attemptId),a.attempt);
  });
}
for(const column of ["revision","identity","event","digest"] as const) {
  test("corrupt "+column+" fails closed on reads/list/history",t=>{
    const a=setup(t),db=a.x.raw();
    if(column==="revision")db.exec("UPDATE execution_attempts SET revision=1");
    else if(column==="identity"){db.exec("DROP TRIGGER execution_identity_immutable");db.exec("UPDATE execution_attempts SET identity='forged'");}
    else {db.exec("DROP TRIGGER execution_history_no_update");db.prepare("UPDATE execution_history SET "+column+"=?").run(column==="event"?'{}':"forged");}
    assert.throws(()=>a.s.executionAttempts.get(a.attempt.attemptId),error("corrupt_store"));
    assert.throws(()=>a.s.executionAttempts.list(),error("corrupt_store"));
    assert.throws(()=>a.s.executionAttempts.history(a.attempt.attemptId),error("corrupt_store"));
  });
}
test("failed append, stale CAS, invalid limits and close fail without releasing identity",t=>{
  const a=setup(t);
  assert.throws(()=>a.s.executionRecovery.requireReconciliation(a.fence,{...ref(a.attempt),revision:1},"stale"));
  a.x.raw().exec("CREATE TRIGGER fail_execution BEFORE INSERT ON execution_history BEGIN SELECT RAISE(ABORT,'fault'); END");
  assert.throws(()=>a.s.executionRecovery.requireReconciliation(a.fence,ref(a.attempt),"fault"));
  assert.deepEqual(a.s.executionAttempts.get(a.attempt.attemptId),a.attempt);
  for(const limit of [0,101,NaN])assert.throws(()=>a.s.executionAttempts.list(undefined,limit));
  a.s.close();assert.throws(()=>a.s.executionAttempts.list(),error("closed"));
});
test("uncertainty cannot be reset into a new invocation or signed intent",t=>{
  const a=setup(t),uncertain=a.s.executionAttempts.markUncertain(a.claim,a.job.revision,ref(a.attempt),"unknown");
  assert.equal(uncertain.phase,"submission_uncertain");
  assert.throws(()=>a.s.executionAttempts.recordSimulatedInvocation(a.claim,a.job.revision,ref(uncertain),"retry"));
  assert.equal(a.create("retry").created,false);
});
test("schema-v5 exact validation detects missing execution triggers on restart",t=>{
  const a=setup(t);a.x.raw().exec("DROP TRIGGER execution_history_no_update");
  assert.throws(()=>a.x.store(),error("schema_mismatch"));
});
