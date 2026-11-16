import {test, type TestContext} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {LifecycleStore,INTENT_FORMAT} from "@proofwork/lifecycle";
import {PublicKey} from "@solana/web3.js";
import {secureFixture} from "./secure-integration-helpers.js";
import {TOKEN,githubFetch} from "./helpers.js";
import {barrier,ephemeral} from "./signing-helpers.js";
import {OfflineDualSignatureSimulation,takeOfflineRoleMessage} from "../src/offline-signature-simulation.js";
import {SecureOfflineAttestationIntegration,type OfflineIntegrationResult} from "../src/secure-attestation-integration.js";
import {VerifierService} from "../src/service.js";
import {GitHub} from "../src/github.js";
import {CASES} from "../src/manifest.js";
import {mutateBytes} from "./read-only-helpers.js";
import {validateObservation} from "../src/operational-protocol.js";
import {takeOfflinePolicyMessage} from "../src/transaction-policy.js";
async function setup(t:TestContext){
 const dir=mkdtempSync(join(tmpdir(),"pow-secure-integration-")),path=join(dir,"ledger.sqlite");
 const f=await secureFixture(path);t.after(()=>{f.store.close();rmSync(dir,{recursive:true,force:true});});return {...f,path};
}
function denied(r:OfflineIntegrationResult){
 assert.equal(r.mode,"offline-only");assert.equal(r.operationalAuthorization,false);assert.equal(r.signingAuthorization,"not_granted");
 for(const k of ["submissionAuthorized","retryAuthorized","reservationReleaseAuthorized","rpcAuthenticated","onChainStateVerified","settlementPermission"] as const)assert.equal(r[k],false,k);
 assert.equal(r.reconciliationRequired,true);assert(Object.isFrozen(r));
 assert(!JSON.stringify(r).includes(TOKEN));assert(!JSON.stringify(r).includes('wireBase64'));assert(!JSON.stringify(r).includes('signatureBase64'));
}
test("real trusted verification, authorization, v4 intent, dual signatures, v5 hold and raw finalized fixture compose",async t=>{
 const f=await setup(t),r=await f.integration.investigate(f.request,TOKEN);denied(r);
 assert.equal(r.code,"matching_finalized_candidate");assert.equal(r.verification!.status,"passed");assert.equal(f.runs(),1);
 assert.deepEqual(r.stages,["job_identity_resolved","verification_completed","authorization_consumed","preparation_recorded",
  "execution_bookkeeping_recorded","offline_signature_evidence_observed","observation_classified"]);
 assert.equal(r.simulation!.verifiedSignatureCount,2);assert.deepEqual(f.verifier.messages[0],f.expected);assert.deepEqual(f.payer.messages[0],f.expected);
 const a=f.rows()[0]!;assert.equal(a.intent.state,"reconciliation_required");assert.equal(a.phase,"submission_uncertain");
 assert.equal(a.invocationRecorded,false);assert.equal(a.wireDigest,null);assert.equal(a.testTransactionId,null);assert.equal(a.uncertain,true);
 assert.deepEqual(f.store.executionAttempts.history(a.attemptId).map(h=>h.evidence),["created","uncertain"]);
 assert.equal(f.store.jobs.createOrGetJob("same_operation",a.intent.bindings).jobId,r.jobId);
 const db=new DatabaseSync(f.path);assert.equal(db.prepare("PRAGMA user_version").get()!.user_version,5);db.close();
});
for(const patch of [{approved:true},{authorization:{}},{transaction:new Uint8Array()},{privateKey:"invalid-field"},
 {cluster:"unsupported"},{programId:"invalid"},{simulation:"operational"},{feePayer:"invalid"}])
 test("request cannot inject "+Object.keys(patch)[0],async t=>{
 const f=await setup(t),r=await f.integration.investigate({...f.request,evidence:{...f.request.evidence,...patch}},TOKEN);
 assert.equal(r.code,"invalid_request");denied(r);assert.equal(f.runs(),0);assert.equal(f.rows().length,0);
 });
for(const patch of [{mode:"operational"},{requestId:"bad id"},{endpoint:"invalid"}])test("strict investigation envelope "+Object.keys(patch)[0],async t=>{
 const f=await setup(t),r=await f.integration.investigate({...f.request,...patch},TOKEN);assert.equal(r.code,"invalid_request");denied(r);
});
test("request accessors are rejected without execution",async t=>{
 const f=await setup(t);let calls=0;const r={...f.request};Object.defineProperty(r,"evidence",{enumerable:true,get(){calls++;return f.request.evidence;}});
 assert.equal((await f.integration.investigate(r,TOKEN)).code,"invalid_request");assert.equal(calls,0);
});
for(const field of ["nonce","commit","repositoryId","contributorId","student","milestone","manifestBase64"] as const)
 test("incorrect request commitment/binding "+field+" fails without signatures",async t=>{
 const f=await setup(t),e={...f.request.evidence};
 (e as any)[field]=field==="manifestBase64"?"AA==":field==="student"||field==="milestone"?PublicKey.default.toBase58():field==="repositoryId"||field==="contributorId"?"9999":"aa".repeat(field==="commit"?20:32);
 const r=await f.integration.investigate({...f.request,evidence:e},TOKEN);assert.notEqual(r.code,"matching_finalized_candidate");denied(r);
 assert.equal(f.verifier.signatures.length,0);assert.equal(f.payer.signatures.length,0);
});
const githubCases:[string,Record<string,unknown>,string][]=[
 ["wrong contributor",{"/user":{id:9999}},"invalid_github_identity"],
 ["wrong repository",{"/repos/proofwork-demo/assignment":{id:9999}},"repository_mismatch"],
 ["wrong commit",{["/repos/proofwork-demo/assignment/commits/"+"cd".repeat(20)]:{sha:"aa".repeat(20)}},"commit_mismatch"],
];
for(const [name,patch,reason] of githubCases)test("real GitHub adapter rejects "+name,async t=>{
 const f=await setup(t),service=new VerifierService(new GitHub(githubFetch(patch)),f.chain,{run:async()=>CASES.map(c=>({id:c.id,passed:true}))});
 const integration=new SecureOfflineAttestationIntegration(f.store,service,f.chain,f.source,f.config,f.simulation,f.now,f.observationConfig);
 const r=await integration.investigate(f.request,TOKEN);assert.equal(r.code,"verification_failed");assert.equal(r.verification!.reason,reason);
 assert(r.jobId);assert.equal(r.intentId,null);assert.equal(f.rows().length,0);assert.equal(f.verifier.signatures.length,0);denied(r);
});
test("actual runner rejection retains a failed verification result and no authorization",async t=>{
 const f=await setup(t),service=new VerifierService(new GitHub(githubFetch()),f.chain,{run:async()=>CASES.map(c=>({id:c.id,passed:false}))});
 const r=await new SecureOfflineAttestationIntegration(f.store,service,f.chain,f.source,f.config,f.simulation,f.now,f.observationConfig).investigate(f.request,TOKEN);
 assert.equal(r.code,"verification_failed");assert.equal(r.verification!.reason,"tests_failed");assert.equal(f.job().state,"verification_rejected");
 assert(!r.stages.includes("authorization_consumed"));assert.equal(f.rows().length,0);denied(r);
});
test("a forged result from a replaced trusted method still fails the real authorizer's binding checks",async t=>{
 const f=await setup(t);f.service.verify=async()=>({approved:true,status:"passed",outcomes:[],startedAt:"",finishedAt:""});
 const r=await f.integration.investigate(f.request,TOKEN);assert.equal(r.code,"verification_failed");assert.equal(f.verifier.signatures.length,0);denied(r);
});
for(const changed of ["revision","generation"] as const)test("stale worker "+changed+" during real verification cannot continue",async t=>{
 const f=await setup(t);f.onRun(async()=>{const j=f.job();
  if(changed==="revision")f.store.jobs.transitionJob({jobId:j.jobId,identity:j.identity,workerId:j.workerId!,generation:j.generation},j.revision,"verification_completed");
  else{const revoked=f.revoke();f.store.jobs.claimJob(revoked.jobId,revoked.identity,revoked.revision,"replacement");}});
 const r=await f.integration.investigate(f.request,TOKEN);assert.equal(r.code,"stale_worker");assert.equal(f.rows().length,0);assert.equal(f.verifier.signatures.length,0);denied(r);
});
test("original authorization expiry is never renewed by integration",async t=>{
 const f=await setup(t);f.onBlock(async()=>f.clock(100000));const r=await f.integration.investigate(f.request,TOKEN);
 assert.equal(r.code,"expired_authorization");assert.equal(f.verifier.signatures.length,0);assert.equal(f.rows().length,0);denied(r);
});
test("changing the approved blockhash rejects the exact message",async t=>{
 const f=await setup(t);f.onBlock(async n=>{if(n>=2)f.observation.blockhash=f.state.sponsor;});
 const r=await f.integration.investigate(f.request,TOKEN);assert.equal(r.code,"invalid_message");assert.equal(f.verifier.signatures.length,0);denied(r);
});
for(const role of ["verifier","payer"] as const)test("wrong "+role+" identity is rejected at composition",async t=>{
 const f=await setup(t),wrong=ephemeral(role==="payer"?"fee_payer":"verifier");
 const sim=new OfflineDualSignatureSimulation(role==="verifier"?wrong.provider:f.verifier.provider,role==="payer"?wrong.provider:f.payer.provider,f.now);
 assert.throws(()=>f.create(f.store,f.observationConfig,sim));assert.equal(f.runs(),0);assert.equal(f.rows().length,0);
});
for(const variant of ["same","new_request","new_instance","restart"] as const)test("permanent duplicate cannot resume through "+variant,async t=>{
 const f=await setup(t);const first=await f.integration.investigate(f.request,TOKEN);assert.equal(first.code,"matching_finalized_candidate");
 const before=f.store.executionAttempts.history(first.execution!.attemptId);let s=f.store;
 if(variant==="restart")s=new LifecycleStore(f.path);
 try{const instance=variant==="same"?f.integration:f.create(s);
  const r=await instance.investigate({...f.request,requestId:variant==="new_request"?"another":"integration"},TOKEN);
  assert.equal(r.code,"duplicate_operation");assert.equal(f.runs(),1);assert.equal(f.verifier.signatures.length,1);assert.equal(f.payer.signatures.length,1);
  assert.deepEqual(s.executionAttempts.history(first.execution!.attemptId),before);denied(r);
 }finally{if(s!==f.store)s.close();}
});
test("two genuine coordinators on separate connections preserve one intent and one signature simulation",async t=>{
 const f=await setup(t),other=new LifecycleStore(f.path);try{
  const results=await Promise.all([f.integration.investigate(f.request,TOKEN),f.create(other).investigate({...f.request,requestId:"racer"},TOKEN)]);
  assert.equal(results.filter(r=>r.code==="matching_finalized_candidate").length,1);assert.equal(f.rows().length,1);
  assert.equal(f.verifier.signatures.length,1);assert.equal(f.payer.signatures.length,1);results.forEach(denied);
 }finally{other.close();}
});
for(const withAttempt of [false,true])test("pre-existing permanent intent"+(withAttempt?" and execution":"")+" cannot become a fresh simulation",async t=>{
 const f=await setup(t);let made=false;
 f.onChain(async()=>{const j=f.store.jobs.listRecoveryRequired().entries[0]?.job;if(!made&&j?.state==="authorization_pending"){
  made=true;const claim={jobId:j.jobId,identity:j.identity,workerId:j.workerId!,generation:j.generation};
  const i=f.store.transactionIntents.createIntent(claim,j.revision,"prior",f.config.policy.feePayer).intent;
  const p=f.store.transactionIntents.recordPreparation(claim,j.revision,i.intentId,i.identity,0,{format:INTENT_FORMAT,
   messageDigest:(await import("node:crypto")).createHash("sha256").update(f.expected).digest("hex"),blockhash:f.observation.blockhash,lastValidBlockHeight:"200",observedBlockHeight:"100"});
  if(withAttempt)f.store.executionAttempts.create(claim,j.revision,"prior_execution",p.intentId,p.identity,f.config.observationAuthority);
 }});
 const r=await f.integration.investigate(f.request,TOKEN);assert.equal(r.code,"existing_permanent_intent");
 assert.equal(f.verifier.signatures.length,0);assert.equal(f.payer.signatures.length,0);assert.equal(f.rows().length,withAttempt?1:0);denied(r);
});
for(const role of ["verifier","payer"] as const)test("corrupt "+role+" signature cannot yield accepted simulation evidence",async t=>{
 const f=await setup(t);f[role].response(()=>new Uint8Array(64));const r=await f.integration.investigate(f.request,TOKEN);
 assert.equal(r.code,"signing_uncertain");assert.equal(r.simulation,null);assert.equal(r.observation,null);
 assert.equal(f.rows().length,1);assert.equal(f.rows()[0]!.uncertain,true);assert.equal(f.rows()[0]!.invocationRecorded,false);denied(r);
});
test("consumed role requests and reconstructed policy metadata cannot be replayed",async t=>{
 const f=await setup(t),r=await f.integration.investigate(f.request,TOKEN);assert.equal(r.code,"matching_finalized_candidate");
 assert.throws(()=>takeOfflineRoleMessage(f.verifier.tokens[0],"verifier",f.verifier.publicKey));
 for(const input of [r, r.execution, r.simulation, f.expected, structuredClone(r.execution)])assert.throws(()=>takeOfflinePolicyMessage(input));
 assert.equal(f.verifier.signatures.length,1);denied(r);
});
for(const when of ["before","after"] as const)test("signing timeout "+when+" test cryptography retains uncertainty and blocks the other role",async t=>{
 const f=await setup(t),gate=barrier();if(when==="before")f.verifier.before(gate.wait);else f.verifier.after(gate.wait);
 const integration=f.create(f.store,f.observationConfig,f.simulator(10));const r=await integration.investigate(f.request,TOKEN);
 assert.equal(r.code,"signing_timeout");assert.equal(r.simulation,null);assert.equal(f.rows()[0]!.uncertain,true);
 gate.release();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(f.payer.signatures.length,0);denied(r);
});
for(const role of ["verifier","payer"] as const)test("revocation during "+role+" simulation cannot accept a stale result",async t=>{
 const f=await setup(t);f[role].after(async()=>{f.revoke();});const r=await f.integration.investigate(f.request,TOKEN);
 assert.equal(r.code,"stale_worker");assert.equal(r.simulation,null);assert.equal(f.rows()[0]!.reconciliationRequired,true);denied(r);
});
const observations:[string,(b:any)=>void,string][]=[
 ["missing status",b=>{b.status=null;},"missing_evidence"],
 ["missing history",b=>{b.status.evidence={kind:"missing",reason:"history_missing"};},"missing_evidence"],
 ["incomplete detail",b=>{b.transaction=null;},"reconciliation_required"],
 ["missing accounts",b=>{b.accounts=null;},"finalized_success_candidate"],
 ["incorrect program owner",b=>{b.accounts.accounts.milestone.account.owner=PublicKey.default.toBase58();},"account_state_mismatch"],
 ["wrong milestone state",b=>{mutateBytes(b.accounts.accounts,"milestone",d=>{d[272]=3;});},"account_state_mismatch"],
 ["wrong account commitment",b=>{mutateBytes(b.accounts.accounts,"submission",d=>{d[72]=d[72]!^1;});},"account_state_mismatch"],
 ["processed only",b=>{b.status.evidence.finality="processed";b.transaction.commitment="processed";},"provisional_observation"],
 ["confirmed only",b=>{b.status.evidence.finality="confirmed";b.transaction.commitment="confirmed";},"confirmed_observation"],
 ["finalized failure",b=>{Object.assign(b.status.evidence,{outcome:"failure",errorCode:"InstructionError"});Object.assign(b.transaction,{outcome:"failure",errorCode:"InstructionError"});},"finalized_failure"],
 ["contradictory detail",b=>{Object.assign(b.transaction,{outcome:"failure",errorCode:"InstructionError"});},"conflicting_evidence"],
 ["substituted TX identity",b=>{b.transaction.transactionId="1".repeat(64);},"reconciliation_required"],
 ["forged authentication",b=>{b.status.authenticated=true;},"reconciliation_required"],
];
for(const [name,patch,expected] of observations)test("integrated observation: "+name,async t=>{
 const f=await setup(t);f.bundle(patch);const r=await f.integration.investigate(f.request,TOKEN);
 assert.equal(r.code,expected);assert.equal(r.observation!.classification,expected);assert.equal(r.simulation!.verifiedSignatureCount,2);
 assert.equal(f.rows()[0]!.phase,"submission_uncertain");assert.equal(f.rows()[0]!.invocationRecorded,false);denied(r);
});
test("an observation fixture for another attempt is rejected before read callbacks",async t=>{
 const f=await setup(t);f.plan(p=>Object.assign(p.attempt,{attemptId:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}));
 const r=await f.integration.investigate(f.request,TOKEN);assert.equal(r.code,"evidence_incomplete");assert.deepEqual(f.calls,[]);denied(r);
});
test("missing observation is reported pending without fabricating finality",async t=>{
 const f=await setup(t),integration=new SecureOfflineAttestationIntegration(f.store,f.service,f.chain,f.source,f.config,f.simulation,f.now);
 const r=await integration.investigate(f.request,TOKEN);assert.equal(r.code,"observation_pending");assert.equal(r.observation,null);assert(r.execution);denied(r);
});
for(const timeout of [false,true])test("observation "+(timeout?"timeout":"exception")+" cannot clear the durable hold",async t=>{
 const f=await setup(t);f.onStatus(async()=>{if(timeout)await new Promise(()=>{});else throw Error(TOKEN);});
 const r=await f.create(f.store,{...f.observationConfig,readTimeoutMs:5}).investigate(f.request,TOKEN);
 assert.equal(r.code,"missing_evidence");assert.equal(r.execution!.uncertain,true);assert.equal(f.calls.filter(c=>c==="status").length,1);denied(r);
});
test("current job fence independently rejects revocation even when the retained v4 flag was already true",async t=>{
 const f=await setup(t);f.onAccounts(async()=>{f.revoke();});const r=await f.integration.investigate(f.request,TOKEN);
 assert.equal(r.code,"stale_worker");assert(r.observation);
 // The old observer sees immutable intent fields and an already-true reconciliation flag.
 // Its matching fixture is retained; the separate current job fence must reject acceptance.
 assert.equal(r.observation!.classification,"matching_finalized_candidate");
 assert.equal(r.observation!.operationalStateMutationAuthorized,false);
 assert.equal(f.rows()[0]!.revision,1);assert.equal(f.rows()[0]!.reconciliationRequired,true);denied(r);
});
test("read-only inspection after restart never restores verification, authorization or signature providers",async t=>{
 const f=await setup(t),first=await f.integration.investigate(f.request,TOKEN),a=f.rows()[0]!,history=f.store.executionAttempts.history(a.attemptId);
 const s=new LifecycleStore(f.path);try{
  const r=await f.create(s).inspect({mode:"offline-only",attemptId:a.attemptId,identity:a.identity,revision:a.revision});
  assert.equal(r.code,"matching_finalized_candidate");assert.equal(r.verification,null);assert.equal(r.simulation,null);
  assert(!r.stages.includes("authorization_consumed"));assert.equal(f.verifier.signatures.length,1);assert.deepEqual(s.executionAttempts.history(a.attemptId),history);
  assert.throws(()=>s.executionAttempts.recordSubmissionIntent({jobId:a.intent.jobId,identity:a.intent.jobIdentity,workerId:a.intent.workerId,generation:a.intent.generation},a.intent.jobRevision,
   {attemptId:a.attemptId,identity:a.identity,revision:a.revision},first.observation));denied(r);
 }finally{s.close();}
});
test("historical fixture DTO remains compatible without becoming a trusted v5 observation",async t=>{
 const f=await setup(t),r=await f.integration.investigate(f.request,TOKEN),p=f.lastPlan()!;
 const dto=r.observation!.observations[0]!.protocol!;
 assert.equal(validateObservation(dto,p.submission,p.admission,p.anchor,p.snapshot).authenticated,false);denied(r);
});
test("corrupted historical execution evidence fails closed",async t=>{
 const f=await setup(t);await f.integration.investigate(f.request,TOKEN);const a=f.rows()[0]!,db=new DatabaseSync(f.path);
 db.exec("DROP TRIGGER execution_history_no_update; UPDATE execution_history SET digest='corrupt' WHERE revision=0");db.close();
 const r=await f.integration.inspect({mode:"offline-only",attemptId:a.attemptId,identity:a.identity,revision:a.revision});
 assert.equal(r.code,"inconsistent_history");assert.equal(r.observation,null);assert.equal(f.verifier.signatures.length,1);denied(r);
});
for(const patch of [{attemptId:"bad"},{identity:"bad"},{revision:-1},{approved:true},{mode:"live"}])test("historical inspection rejects malformed "+Object.keys(patch)[0],async t=>{
 const f=await setup(t),r=await f.integration.inspect({mode:"offline-only",attemptId:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",identity:"aa".repeat(32),revision:0,...patch});
 assert.equal(r.code,"invalid_request");assert.equal(f.runs(),0);assert.equal(f.rows().length,0);denied(r);
});
test("missing historical attempt never starts a workflow",async t=>{
 const f=await setup(t),r=await f.integration.inspect({mode:"offline-only",attemptId:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",identity:"aa".repeat(32),revision:0});
 assert.equal(r.code,"missing_job");assert.equal(f.runs(),0);denied(r);
});
test("no fetch, credential/result leakage, submission invocation or settlement occurs",async t=>{
 const f=await setup(t),old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error("forbidden_network");};
 try{const r=await f.integration.investigate(f.request,TOKEN);assert.equal(r.code,"matching_finalized_candidate");assert.equal(calls,0);
  assert.equal(r.execution!.invocationRecorded,false);assert(!JSON.stringify(r).includes(f.request.evidence.nonce));assert(Object.isFrozen(r.verification!.outcomes));denied(r);
 }finally{globalThis.fetch=old;}
});
test("a signature over changed message bytes cannot satisfy genuine policy consumption",async t=>{
 const f=await setup(t);f.verifier.response((_signature,message)=>{const changed=Buffer.from(message);changed[0]=changed[0]!^1;return f.verifier.signForTest(changed);});
 const r=await f.integration.investigate(f.request,TOKEN);assert.equal(r.code,"signing_uncertain");assert.equal(r.simulation,null);
 assert.equal(f.payer.signatures.length,0);assert.equal(f.rows()[0]!.uncertain,true);denied(r);
});
test("the verifier signature cannot substitute for separate payer approval",async t=>{
 const f=await setup(t);f.payer.response(()=>f.verifier.signatures[0]!);const r=await f.integration.investigate(f.request,TOKEN);
 assert.equal(r.code,"signing_uncertain");assert.equal(r.simulation,null);denied(r);
});
test("request role substitution burns the genuine request and never produces a signature",async t=>{
 const f=await setup(t);f.verifier.before(async request=>{takeOfflineRoleMessage(request,"fee_payer",f.payer.publicKey);});
 const r=await f.integration.investigate(f.request,TOKEN);assert.equal(r.code,"signing_uncertain");assert.equal(f.verifier.signatures.length,0);denied(r);
});
test("independent fixture sources retain conflicting outcomes in the integrated result",async t=>{
 const f=await setup(t);f.plan(p=>{(p.snapshot.sourceIds as string[]).push("second_fixture");
  (p.events as any).push({sourceId:"second_fixture",eventId:"second_event"});});
 function second(value:unknown){const copy=structuredClone(value) as any;copy.provenance.sourceId="second_fixture";copy.provenance.eventId="second_event";return copy;}
 const source={mode:"offline_mock" as const,sourceId:"second_fixture",
  readStatus:async()=>{const c=second(f.lastBundle()!.status);Object.assign(c.evidence,{outcome:"failure",errorCode:"InstructionError"});return c;},
  readTransaction:async()=>{const c=second(f.lastBundle()!.transaction);Object.assign(c,{outcome:"failure",errorCode:"InstructionError"});return c;},
  readAccounts:async()=>{throw Error("failed_transaction_must_not_read_accounts");}};
 const r=await f.create(f.store,{...f.observationConfig,sources:[f.readSource,source]}).investigate(f.request,TOKEN);
 assert.equal(r.code,"conflicting_evidence");assert.equal(r.observation!.observations.length,2);
 assert(r.observation!.reasons.includes("cross_source_transaction_conflict"));assert.equal(f.rows()[0]!.revision,1);denied(r);
});
test("runner exceptions cannot disclose tokens or synthesize authorization",async t=>{
 const f=await setup(t);f.onRun(async()=>{throw Error(TOKEN+f.request.evidence.nonce);});
 const r=await f.integration.investigate(f.request,TOKEN);assert.equal(r.code,"verification_failed");assert.equal(r.verification!.reason,"infrastructure_failure");
 assert.equal(r.simulation,null);assert.equal(f.rows().length,0);denied(r);
});
