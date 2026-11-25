import {test} from "node:test";
import assert from "node:assert/strict";
import {fork} from "node:child_process";
import {once} from "node:events";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {LifecycleStore} from "@proofwork/lifecycle";
import {SecureOfflineAttestationIntegration} from "../src/secure-attestation-integration.js";
import {OfflineDualSignatureSimulation} from "../src/offline-signature-simulation.js";
import {VerifierService} from "../src/service.js";
import {GitHub} from "../src/github.js";
const windows=["before_job","after_job","after_preparation","before_execution","after_execution","before_verifier",
 "after_verifier","after_payer","before_hold","after_hold","during_observation","after_matching","after_revocation"] as const;
for(const window of windows)test("integrated process crash "+window+" retains committed identity and cannot restore authority",{timeout:25000},async t=>{
 const dir=mkdtempSync(join(tmpdir(),"pow-integration-crash-")),path=join(dir,"ledger.sqlite");
 const child=fork(new URL("./secure-integration-process.js",import.meta.url),[path,window],{stdio:["ignore","ignore","pipe","ipc","pipe"]});
 const watchdog=setTimeout(()=>child.kill("SIGKILL"),18000);
 t.after(()=>{clearTimeout(watchdog);if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");rmSync(dir,{recursive:true,force:true});});
 const exit=once(child,"exit"),[message]=await once(child,"message"),payload=message as any;
 assert.equal(payload.ready,true);assert(!/privateKey|secretKey|seedPhrase/.test(JSON.stringify(payload)));
 const checkpoint=once(child.stdio[4]!,"data");child.send({start:true});
 await Promise.race([checkpoint,exit.then(()=>{throw Error("missing_checkpoint_"+window);})]);child.kill("SIGKILL");await exit;
 const store=new LifecycleStore(path);
 try{
  const rows=store.executionAttempts.list(),jobs=store.jobs.listRecoveryRequired().entries;
  const expectedAttempt=!["before_job","after_job","after_preparation","before_execution"].includes(window);
  assert.equal(rows.length,expectedAttempt?1:0);assert.equal(jobs.length,window==="before_job"?0:1);
  const db=new DatabaseSync(path);assert.equal(db.prepare("PRAGMA user_version").get()!.user_version,6);
  assert.equal(db.prepare("PRAGMA journal_mode").get()!.journal_mode,"delete");db.close();
  if(jobs.length)assert.equal(store.jobs.createOrGetJob("retained_after_crash",jobs[0]!.job.bindings).jobId,jobs[0]!.job.jobId);
  for(const a of rows){
   const before=store.executionAttempts.history(a.attemptId);assert.equal(a.uncertain,true);assert.equal(a.invocationRecorded,false);
   assert.equal(a.reservationRetained,true);assert.equal(a.rpcAuthenticated,false);assert.equal(a.submissionAuthorized,false);
   assert.equal(a.wireDigest,null);assert.equal(a.testTransactionId,null);
   assert.equal(a.phase,["after_hold","during_observation","after_matching"].includes(window)?"submission_uncertain":"execution_record_created");
   let effects=0;const forbidden=async()=>{effects++;throw Error("effect_forbidden_after_restart");};
   const chain={read:async()=>payload.state},service=new VerifierService(new GitHub(forbidden),chain,{run:forbidden});
   const simulation=new OfflineDualSignatureSimulation({mode:"ephemeral-offline-test",publicKey:payload.config.policy.verifier,simulateAttestation:forbidden},
    {mode:"ephemeral-offline-test",publicKey:payload.config.policy.feePayer,simulateAttestation:forbidden},()=>0);
   const integration=new SecureOfflineAttestationIntegration(store,service,chain,{read:forbidden},payload.config,simulation,()=>0);
   const result=await integration.inspect({mode:"offline-only",attemptId:a.attemptId,identity:a.identity,revision:a.revision});
   assert.equal(result.code,"observation_pending");assert.equal(result.verification,null);assert.equal(result.simulation,null);
   assert.equal(result.operationalAuthorization,false);assert.equal(result.retryAuthorized,false);assert.equal(result.reservationReleaseAuthorized,false);
   assert.equal(effects,0);assert.deepEqual(store.executionAttempts.history(a.attemptId),before);
  }
 }finally{store.close();}
});
