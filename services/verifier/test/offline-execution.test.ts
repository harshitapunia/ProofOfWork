import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LifecycleStore, createOfflineTestExecutionObserver, type ExecutionAttempt, type ExecutionEvidence } from "@proofwork/lifecycle";
import { executionFixture, executionRef, controlFence } from "./execution-helpers.js";
import { offlineExecutionObserver, OfflineExecutionCoordinator } from "../src/offline-execution.js";

async function fixture(t: any) {
  const dir=mkdtempSync(join(tmpdir(),"pow-execution-")),x=await executionFixture(join(dir,"ledger.sqlite"));
  t.after(()=>{x.s.close();rmSync(dir,{recursive:true,force:true});}); return {...x,dir};
}
const status=(finality:number,outcome:"success"|"failure"="success"):Partial<ExecutionEvidence> => ({
  kind:"status",finality,outcome,error:outcome==="success"?null:"InstructionError",transactionSlot:"110",contextSlot:"111"});
test("actual two-signature message advances distinct modeled intent/invocation/ack/processed/confirmed/finalized states",async t=>{
  const x=await fixture(t);let a=await x.signed();
  assert.equal(a.phase,"submission_intent_recorded");assert.equal(a.invocationRecorded,false);
  a=x.s.executionAttempts.recordSimulatedInvocation(x.claim,x.job.revision,executionRef(a),"invoke");
  a=await x.record(a,{kind:"ack"});assert.equal(a.outcome,"none");
  a=await x.record(a,status(1));assert.equal(a.phase,"confirmation_pending");
  a=await x.record(a,status(2));assert.equal(a.phase,"confirmed_success_observed");assert.equal(a.reconciliationRequired,true);
  a=await x.record(a,status(3));assert.equal(a.phase,"finalized_success_observed");
  assert.equal(a.rpcAuthenticated,false);assert.equal(a.submissionAuthorized,false);assert.equal(a.retryAuthorized,false);
  assert.equal(a.signingAuthorization,"not_granted");assert.equal(a.reservationRetained,true);
  assert.throws(()=>x.s.executionRecovery.requireReconciliation(controlFence(x.s,a),executionRef(a),"reopen"));
  assert.equal(JSON.stringify(x.s.executionAttempts.history(a.attemptId)).includes("wireBase64"),false);
  assert.equal(x.s.transactionIntents.getIntent(x.intent.intentId)!.state,"preparation_recorded");
  const restart=new LifecycleStore(join(x.dir,"ledger.sqlite"));assert.deepEqual(restart.executionAttempts.get(a.attemptId),a);restart.close();
});
for(const kind of ["unknown","timeout","null_lookup","history_missing","expired"] as const) {
  test(kind+" preserves ambiguous outcome and permanent identity without retry",async t=>{
    const x=await fixture(t);let a=await x.signed();
    a=await x.record(a,{kind,observedBlockHeight:kind==="expired"?"201":"100"});
    assert.equal(a.phase,"submission_uncertain");assert.equal(a.outcome,"none");assert.equal(a.retryAuthorized,false);
    const again=x.s.executionAttempts.create(x.claim,x.job.revision,"alias",x.intent.intentId,x.intent.identity,x.authorityKey);
    assert.equal(again.created,false);assert.equal(again.attempt.identity,a.identity);
    assert.throws(()=>x.s.executionAttempts.recordSimulatedInvocation(x.claim,x.job.revision,executionRef(a),"retry"));
  });
}
test("revoked worker is fenced while explicit current recovery control can retain and strengthen evidence",async t=>{
  const x=await fixture(t);let a=await x.signed();const prior=controlFence(x.s,a);
  x.s.jobRecovery.interruptJob(x.job.jobId,x.job.identity,x.job.revision,"operator");
  assert.throws(()=>x.s.executionAttempts.markUncertain(x.claim,x.job.revision,executionRef(a),"stale"));
  assert.throws(()=>x.s.executionRecovery.requireReconciliation(prior,executionRef(a),"stale-control"));
  a=x.s.executionAttempts.get(a.attemptId)!;
  a=x.s.executionRecovery.requireReconciliation(controlFence(x.s,a),executionRef(a),"recovery");
  a=await x.record(a,status(2));a=await x.record(a,status(3));
  assert.equal(a.reconciliationRequired,true);assert.equal(a.submissionAuthorized,false);
  assert.throws(()=>x.s.jobs.claimJob(x.job.jobId,x.job.identity,x.s.jobs.getJob(x.job.jobId)!.revision,"new"));
});
for(const patch of [
  {identity:"aa".repeat(32)},{intentIdentity:"aa".repeat(32)},{preparationIdentity:"aa".repeat(32)},
  {bindingDigest:"aa".repeat(32)},{revision:99},{testTransactionId:"bad"},{wireDigest:"aa".repeat(32)},
] as Partial<ExecutionEvidence>[]) {
  test("authenticated fixture cannot substitute "+Object.keys(patch)[0],async t=>{
    const x=await fixture(t);await assert.rejects(x.observer(patch).observe(x.attempt));
    assert.equal(x.s.executionAttempts.get(x.attempt.attemptId)!.revision,0);
  });
}
for(const corrupt of ["partial","bad-signature","changed-message","extra-bytes"] as const) {
  test("rejects signed transaction "+corrupt,async t=>{
    const x=await fixture(t),wire=Buffer.from(x.wire);
    if(corrupt==="partial")wire.fill(0,1,65);
    if(corrupt==="bad-signature")wire[2]=wire[2]!^1;
    if(corrupt==="changed-message")wire[wire.length-1]=wire[wire.length-1]!^1;
    await assert.rejects(x.observer({},corrupt==="extra-bytes"?Buffer.concat([wire,Buffer.from([0])]):wire).observe(x.attempt));
  });
}
test("unsigned provenance, forged JSON, cloned snapshots and serialized tokens cannot authenticate",async t=>{
  const x=await fixture(t),env=x.envelope(x.attempt);
  const observer=offlineExecutionObserver({mode:"offline-test-observation-source",read:async()=>({...env,authoritySignatureBase64:Buffer.alloc(64).toString("base64")})},x.fixture);
  await assert.rejects(observer.observe(x.attempt));
  await assert.rejects(x.observer().observe(structuredClone(x.attempt)));
  for(const token of [{confirmed:true},x.attempt,env,{},JSON.parse(JSON.stringify(await x.observer().observe(x.attempt)))])
    assert.throws(()=>x.s.executionAttempts.recordSubmissionIntent(x.claim,x.job.revision,executionRef(x.attempt),token));
});
test("tokens burn before write, stale CAS or failed writes cannot reuse evidence",async t=>{
  const x=await fixture(t),token=await x.observer().observe(x.attempt);
  assert.throws(()=>x.s.executionAttempts.recordSubmissionIntent(x.claim,x.job.revision,{...executionRef(x.attempt),revision:1},token));
  assert.throws(()=>x.s.executionAttempts.recordSubmissionIntent(x.claim,x.job.revision,executionRef(x.attempt),token));
  let a=await x.signed();const stale=await x.observer({kind:"ack"}).observe(a);
  a=x.s.executionAttempts.markUncertain(x.claim,x.job.revision,executionRef(a),"unknown");
  assert.throws(()=>x.s.executionRecovery.applyObservation(controlFence(x.s,a),executionRef(a),stale));
  assert.equal(x.s.executionAttempts.get(a.attemptId)!.phase,"submission_uncertain");
});
for(const patch of [
  {finality:1},{outcome:"failure",error:"InstructionError"},{error:"unexpected"},{transactionSlot:"109"},
  {contextSlot:"109"},{observedBlockHeight:"099"},{kind:"expired",observedBlockHeight:"100",finality:0,outcome:"none",error:null,transactionSlot:null,contextSlot:null},
] as Partial<ExecutionEvidence>[]) {
  test("rejects contradictory or regressive finality "+JSON.stringify(patch),async t=>{
    const x=await fixture(t);let a=await x.signed();a=await x.record(a,status(2));
    await assert.rejects(x.record(a,{...status(3),...patch}));
    assert.equal(x.s.executionAttempts.get(a.attemptId)!.phase,"confirmed_success_observed");
  });
}
test("matching failure can strengthen to finalized failure without success or account-state claims",async t=>{
  const x=await fixture(t);let a=await x.signed();a=await x.record(a,status(2,"failure"));a=await x.record(a,status(3,"failure"));
  assert.equal(a.phase,"finalized_failure_observed");assert.equal(a.error,"InstructionError");assert.equal(a.submissionAuthorized,false);
});
test("replayed event identity rolls back head even with fresh token",async t=>{
  const x=await fixture(t);let a=await x.signed();a=await x.record(a,{kind:"ack",eventId:"ack"});
  await assert.rejects(x.record(a,{...status(2),eventId:"ack"}));
  assert.equal(x.s.executionAttempts.get(a.attemptId)!.revision,a.revision);
});
test("late unknown evidence preserves known confirmed facts and uncertainty",async t=>{
  const x=await fixture(t);let a=await x.signed();a=await x.record(a,status(2));a=await x.record(a,{kind:"history_missing"});
  assert.equal(a.phase,"confirmed_success_observed");assert.equal(a.transactionSlot,"110");assert.equal(a.reconciliationRequired,true);
});
test("message validator rebuilds original ABI and rejects wrong program, milestone, verifier, payer, genesis and commitments",async t=>{
  const x=await fixture(t);
  for(const key of ["programId","milestone","verifier","feePayer","genesisHash","requirementsHash","evidenceHash"]) {
    const cloned=structuredClone(x.attempt) as ExecutionAttempt;
    if(key==="feePayer")Object.assign(cloned.intent,{feePayer:x.f.verifier.publicKey});
    else Object.assign(cloned.intent.bindings,{[key]:"bad"});
    await assert.rejects(x.observer().observe(cloned)); // Database snapshots, not caller JSON, are required.
  }
  for(const key of ["milestone","verifier","student","requirementsHash","evidenceHash","sponsor"] as const) {
    const observer=offlineExecutionObserver({mode:"offline-test-observation-source",read:async a=>x.envelope(a)},
      {mode:"offline-attestation-fixture",read:async()=>({...x.f.state,[key]:"bad"})});
    await assert.rejects(observer.observe(x.attempt));
  }
});
test("input copied before validator await; later mutation cannot change accepted evidence",async t=>{
  const x=await fixture(t),env=x.envelope(x.attempt);
  const observer=createOfflineTestExecutionObserver({mode:"offline-test-observation-source",read:async()=>env},
    {mode:"offline-fixture-message-validator",validate:async()=>{(env.evidence as any).kind="ack";}});
  const a=x.s.executionAttempts.recordSubmissionIntent(x.claim,x.job.revision,executionRef(x.attempt),await observer.observe(x.attempt));
  assert.equal(a.phase,"submission_intent_recorded");
});
test("history append failure atomically rolls back head and leaves permanent identity",async t=>{
  const x=await fixture(t),raw=new DatabaseSync(join(x.dir,"ledger.sqlite"));
  raw.exec("CREATE TRIGGER fail_execution BEFORE INSERT ON execution_history BEGIN SELECT RAISE(ABORT,'test_fault'); END");
  await assert.rejects(x.signed());assert.equal(x.s.executionAttempts.get(x.attempt.attemptId)!.revision,0);
  raw.close();
});
test("no network/credential/signer/route capability is introduced in execution modules",()=>{
  for(const f of ["execution-attempts","execution-model","execution-observations"]) {
    const text=readFileSync(new URL("../../../lifecycle/src/"+f+".ts",import.meta.url),"utf8");
    assert.doesNotMatch(text,/sendRawTransaction\s*\(|sendTransaction\s*\(|fetch\s*\(|process\.env|readFile|privateKey|generateKeyPair/);
  }
  const text=readFileSync(new URL("../../src/offline-execution.ts",import.meta.url),"utf8");
  assert.doesNotMatch(text,/sendRawTransaction\s*\(|sendTransaction\s*\(|fetch\s*\(|process\.env|privateKey/);
  assert.equal(typeof OfflineExecutionCoordinator,"function");
});

test("observation slots and heights preserve u64 beyond JavaScript safe integers",async t=>{
  const x=await fixture(t);let a=await x.signed();
  a=await x.record(a,{kind:"status",finality:2,outcome:"success",transactionSlot:"9007199254740993",
    contextSlot:"18446744073709551615",observedBlockHeight:"18446744073709551615"});
  assert.equal(a.transactionSlot,"9007199254740993");assert.equal(a.contextSlot,"18446744073709551615");
  await assert.rejects(x.record(a,{kind:"status",finality:3,outcome:"success",transactionSlot:"9007199254740993",
    contextSlot:"18446744073709551616",observedBlockHeight:"18446744073709551615"}));
});

test("unknown after acknowledgment retains the known ack phase and requires reconciliation",async t=>{
  const x=await fixture(t);let a=await x.signed();a=await x.record(a,{kind:"ack"});
  a=await x.record(a,{kind:"null_lookup"});
  assert.equal(a.phase,"acknowledgment_observed");assert.equal(a.reconciliationRequired,true);assert.equal(a.outcome,"none");
});

test("post-crash control can attach independently verified signed identity after worker revocation without invocation authority",async t=>{
  const x=await fixture(t);
  x.s.jobRecovery.interruptJob(x.job.jobId,x.job.identity,x.job.revision,"operator");
  let a=x.s.executionAttempts.get(x.attempt.attemptId)!;
  a=await x.record(a,{kind:"signed_identity"});
  assert.equal(a.phase,"submission_intent_recorded");assert.equal(a.invocationRecorded,false);
  assert.throws(()=>x.s.executionAttempts.recordSimulatedInvocation(x.claim,x.job.revision,executionRef(a),"stale-invocation"));
  a=await x.record(a,{kind:"status",finality:3,outcome:"success",transactionSlot:"110",contextSlot:"111"});
  assert.equal(a.phase,"finalized_success_observed");assert.equal(a.invocationRecorded,false);
  assert.equal(a.reconciliationRequired,true);assert.equal(a.submissionAuthorized,false);
  assert.equal(x.s.transactionIntents.getIntent(x.intent.intentId)!.signingAuthorization,"not_granted");
});

for(const revoked of [false,true]) {
  test("trusted control attaches identity after pre-identity uncertainty without reopening invocation; revoked="+revoked,async t=>{
    const x=await fixture(t);
    let a=x.s.executionAttempts.markUncertain(x.claim,x.job.revision,executionRef(x.attempt),"uncertain-before-identity");
    if(revoked)x.s.jobRecovery.interruptJob(x.job.jobId,x.job.identity,x.job.revision,"operator");
    a=x.s.executionAttempts.get(a.attemptId)!;
    const workerToken=await x.observer().observe(a);
    assert.throws(()=>x.s.executionAttempts.recordSubmissionIntent(x.claim,x.job.revision,executionRef(a),workerToken));
    a=await x.record(a,{kind:"signed_identity"});
    assert.equal(a.phase,"submission_uncertain");assert.notEqual(a.wireDigest,null);assert.equal(a.invocationRecorded,false);
    assert.throws(()=>x.s.executionAttempts.recordSimulatedInvocation(x.claim,x.job.revision,executionRef(a),"forbidden-invocation"));
    await assert.rejects(x.record(a,{kind:"signed_identity",eventId:"duplicate-identity"}));
    a=await x.record(a,{kind:"status",finality:3,outcome:"success",transactionSlot:"110",contextSlot:"111"});
    assert.equal(a.phase,"finalized_success_observed");assert.equal(a.invocationRecorded,false);
    assert.equal(a.submissionAuthorized,false);assert.equal(a.retryAuthorized,false);assert.equal(a.signingAuthorization,"not_granted");
    assert.equal(a.reconciliationRequired,revoked);
  });
}
