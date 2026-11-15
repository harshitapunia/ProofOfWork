import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { OfflineExecutionCoordinator } from "../src/offline-execution.js";
import { executionFixture, executionRef } from "./execution-helpers.js";
import { ephemeral } from "./signing-helpers.js";

async function fixture(t:any,create=false) {
  const dir=mkdtempSync(join(tmpdir(),"pow-coordinator-")),x=await executionFixture(join(dir,"db.sqlite"),create);
  t.after(()=>{x.s.close();rmSync(dir,{recursive:true,force:true});});return x;
}
for(const mode of ["return","throw","timeout","revoked"] as const) {
  test("coordinator "+mode+" never invents acknowledgment, execution or retry authority",async t=>{
    const x=await fixture(t);let calls=0;
    const coordinator=new OfflineExecutionCoordinator(x.s.executionAttempts,x.observer(),
      {mode:"offline-invocation-double",simulate:async input=>{
        calls++;assert.deepEqual(Object.keys(input).sort(),["attemptId","identity","wireDigest"]);assert.ok(Object.isFrozen(input));
        if(mode==="throw")throw Error("ambiguous");
        if(mode==="timeout")await new Promise(()=>{});
        if(mode==="revoked")x.s.jobRecovery.interruptJob(x.job.jobId,x.job.identity,x.job.revision,"operator");
      }},20);
    const run=()=>coordinator.model(x.claim,x.job.revision,"coordinator",x.intent.intentId,x.intent.identity,x.authorityKey);
    if(mode==="return") {
      const result=await run();assert.equal(result.result,"returned_no_execution_claim");assert.equal(result.attempt.outcome,"none");
    }else await assert.rejects(run());
    const a=x.s.executionAttempts.list()[0]!;assert.equal(a.invocationRecorded,true);
    assert.equal(a.finality,0);assert.equal(a.outcome,"none");assert.equal(a.reconciliationRequired,true);
    assert.equal(a.submissionAuthorized,false);assert.equal(a.retryAuthorized,false);
    await assert.rejects(run());assert.equal(calls,1);assert.equal(x.s.executionAttempts.list().length,1);
  });
}
test("existing created row cannot resume after crash even with genuine independent fixture evidence",async t=>{
  const x=await fixture(t,true);let calls=0;
  const coordinator=new OfflineExecutionCoordinator(x.s.executionAttempts,x.observer(),
    {mode:"offline-invocation-double",simulate:async()=>{calls++;}});
  await assert.rejects(coordinator.model(x.claim,x.job.revision,"new",x.intent.intentId,x.intent.identity,x.authorityKey));
  assert.equal(calls,0);assert.equal(x.s.executionAttempts.get(x.attempt.attemptId)!.revision,0);
});
test("wrong signer roles, wrong payer, alternate encoding, extra instruction and malformed IDs reject",async t=>{
  const x=await fixture(t,true);
  for(const mutation of ["payer","verifier","program","milestone","blockhash","extra","v0"] as const) {
    const tx=x.f.transaction(),other=ephemeral("fee_payer");
    if(mutation==="payer")tx.feePayer=new PublicKey(other.publicKey);
    if(mutation==="verifier")tx.instructions[0]!.keys[0]!.pubkey=new PublicKey(other.publicKey);
    if(mutation==="program")tx.instructions[0]!.programId=new PublicKey(other.publicKey);
    if(mutation==="milestone")tx.instructions[0]!.keys[2]!.pubkey=new PublicKey(other.publicKey);
    if(mutation==="blockhash")tx.recentBlockhash=other.publicKey;
    if(mutation==="extra")tx.add(tx.instructions[0]!);
    if(mutation==="v0") {
      const msg=new TransactionMessage({payerKey:new PublicKey(x.f.payer.publicKey),recentBlockhash:x.f.observation.blockhash,
        instructions:tx.instructions}).compileToV0Message();
      const v=new VersionedTransaction(msg);v.addSignature(new PublicKey(x.f.payer.publicKey),x.f.payer.signForTest(msg.serialize()));
      v.addSignature(new PublicKey(x.f.verifier.publicKey),x.f.verifier.signForTest(msg.serialize()));
      await assert.rejects(x.observer({},Buffer.from(v.serialize())).observe(x.attempt));continue;
    }
    const message=tx.serializeMessage();
    tx.addSignature(tx.feePayer!,mutation==="payer"?other.signForTest(message):x.f.payer.signForTest(message));
    tx.addSignature(tx.instructions[0]!.keys[0]!.pubkey,mutation==="verifier"?other.signForTest(message):x.f.verifier.signForTest(message));
    await assert.rejects(x.observer({},tx.serialize()).observe(x.attempt));
  }
  for(const id of ["bad","1".repeat(88),"0".repeat(88)])await assert.rejects(x.observer({testTransactionId:id}).observe(x.attempt));
});
test("same finality and conflicting error cannot overwrite a confirmed failure",async t=>{
  const x=await fixture(t,true);let a=await x.signed();
  a=await x.record(a,{kind:"status",finality:2,outcome:"failure",error:"InstructionError",transactionSlot:"110",contextSlot:"111"});
  await assert.rejects(x.record(a,{kind:"status",finality:2,outcome:"failure",error:"InstructionError",transactionSlot:"110",contextSlot:"111"}));
  await assert.rejects(x.record(a,{kind:"status",finality:3,outcome:"failure",error:"OtherError",transactionSlot:"110",contextSlot:"111"}));
  assert.equal(x.s.executionAttempts.get(a.attemptId)!.revision,a.revision);
});
test("foreign authority envelope and stale signed identity never gain signing authorization",async t=>{
  const x=await fixture(t,true),y=await fixture(t,true);
  const env=y.envelope(x.attempt);
  const {offlineExecutionObserver}=await import("../src/offline-execution.js");
  const foreign=offlineExecutionObserver({mode:"offline-test-observation-source",read:async()=>env},x.fixture);
  await assert.rejects(foreign.observe(x.attempt));
  const token=await x.observer().observe(x.attempt);
  const a=x.s.executionAttempts.markUncertain(x.claim,x.job.revision,executionRef(x.attempt),"interrupted");
  assert.throws(()=>x.s.executionAttempts.recordSubmissionIntent(x.claim,x.job.revision,executionRef(a),token));
  assert.equal(a.signingAuthorization,"not_granted");
});
