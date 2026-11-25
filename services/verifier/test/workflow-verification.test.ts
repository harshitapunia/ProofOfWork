import {DurableOfflineCoordinator} from "../src/durable-offline-coordinator.js";
import {closeApplicationStore,startApplication} from "../src/application-main.js";
import {VerificationError,type Failure} from "../src/errors.js";
import {test,type TestContext} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync,writeFileSync,chmodSync,symlinkSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {PublicKey} from "@solana/web3.js";
import {LifecycleStore} from "@proofwork/lifecycle";
import {DEMO_MINT,TOKEN_PROGRAM_ID,deriveVault,deriveVaultAuthority,SETTLEMENT_DEVNET_GENESIS,SETTLEMENT_DEVNET_RPC} from "@proofwork/finance-client";
import {WorkflowVerification,admittedContributor,LIVE_VERIFIER_DISPATCH} from "../src/workflow-verification.js";
import {WorkflowStateReader} from "../src/workflow-state.js";
import {ReadOnlyWalletRpc} from "../src/devnet-wallet-review.js";
import {VerifierService} from "../src/service.js";
import {GitHub} from "../src/github.js";
import {DevnetAttestationReader} from "../src/attestation-chain.js";
import {CASES} from "../src/manifest.js";
import {fixture,githubFetch,TOKEN} from "./helpers.js";
function setup(t:TestContext,admitted=true,passed=true,reason?:Failure){
 const f=fixture(),sponsor=new PublicKey(f.i.subarray(8,40)).toBase58();new PublicKey(DEMO_MINT).toBuffer().copy(f.m,136);f.m[274]=deriveVault(f.milestone)[1];f.m[275]=deriveVaultAuthority(f.milestone)[1];
 const dir=mkdtempSync(join(tmpdir(),"pow-admitted-verification-")),path=join(dir,"store.sqlite"),store=new LifecycleStore(path);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const vault=Buffer.alloc(165);new PublicKey(DEMO_MINT).toBuffer().copy(vault);deriveVaultAuthority(f.milestone)[0].toBuffer().copy(vault,32);vault.writeBigUInt64LE(10n,64);vault[108]=1;
 const rpc=new ReadOnlyWalletRpc(async(_url,init)=>{const q=JSON.parse(init!.body as string);return Response.json({jsonrpc:"2.0",id:q.id,result:q.method==="getGenesisHash"?SETTLEMENT_DEVNET_GENESIS:{context:{slot:200},value:q.params[0].map((address:string)=>{const v=address===deriveVault(f.milestone)[0].toBase58()?vault:f.accounts.get(address);return v?{owner:v===vault?TOKEN_PROGRAM_ID:"J2FkqDuuuHT14gxjVMhSryrX3Bs4Knct45NMLA79dGdZ",executable:false,data:[v.toString("base64"),"base64"]}:null;})}});});
 let receipt:Parameters<DurableOfflineCoordinator["readMockMessage"]>[0]|undefined;
 let calls=0,release:(()=>void)|undefined,held=false;
 const service=new VerifierService(new GitHub(githubFetch()),new DevnetAttestationReader(SETTLEMENT_DEVNET_RPC,f.verifier.toBase58(),f.rpc),{run:async()=>{calls++;if(held)await new Promise<void>(r=>{release=r;});if(reason)throw new VerificationError(reason);return CASES.map(c=>({id:c.id,passed}));}});
 const reader=new WorkflowStateReader(rpc,"offline_fixture"),chain=new DevnetAttestationReader(SETTLEMENT_DEVNET_RPC,f.verifier.toBase58(),f.rpc);
 const coordinator=new DurableOfflineCoordinator(store,service,chain,{verifier:f.verifier.toBase58(),feePayer:sponsor,maxAgeMs:30000,minRemainingBlockHeights:10},"browser_verifier",{read:async()=>({rpc:SETTLEMENT_DEVNET_RPC,genesisHash:SETTLEMENT_DEVNET_GENESIS,blockhash:new PublicKey(Buffer.alloc(32,7)).toBase58(),lastValidBlockHeight:500,currentBlockHeight:100,observedAtMs:performance.now(),valid:true})});
 const dispatcher=new WorkflowVerification(reader,store,coordinator,async binding=>{assert.equal(binding.contributorId,f.request.contributorId);assert.equal(Object.hasOwn(binding,"nonce"),false);return admitted?TOKEN:null;},value=>{receipt=value;});
 const input={apiVersion:"proofwork-application-api-v1",cluster:"devnet",sponsor,internshipId:"1",milestoneId:"1",evidence:f.request};
 return {...f,path,store,reader,dispatcher,service,coordinator,receipt:()=>receipt!,input,sponsor,calls:()=>calls,hold:()=>{held=true;},release:()=>release?.()};
}
test("admitted real submission creates one existing v5 job and runs the existing verifier; no authority or private evidence is persisted",async t=>{
 const f=setup(t),job=await f.dispatcher.dispatch(f.input,f.request.student,()=>{});await f.dispatcher.drain();
 assert.equal(f.store.jobs.getJob(job.jobId)!.state,"authorization_pending");assert.equal(f.calls(),1);assert.equal(job.attestation,"not_authorized");
 const repeated=await f.dispatcher.dispatch(f.input,f.request.student,()=>{});await f.dispatcher.drain();assert.equal(repeated.jobId,job.jobId);assert.equal(f.calls(),1);
 const bytes=readFileSync(f.path);for(const secret of [TOKEN,f.request.nonce,f.request.manifestBase64])assert.equal(bytes.includes(Buffer.from(secret)),false);
 assert.equal(f.store.offlineHandoffs.get(job.jobId)?.outcome,"recorded");assert.equal(f.store.jobs.getJob(job.jobId)!.signingAuthorization,"not_granted");
 const original=f.coordinator.readMockMessage(f.receipt());assert(original.length>0);assert.throws(()=>f.coordinator.readMockMessage(structuredClone(f.receipt())),/invalid_mock_receipt/);
 original.fill(0);assert(f.coordinator.readMockMessage(f.receipt()).some(n=>n!==0));
 const restarted=new WorkflowVerification(f.reader,f.store,f.coordinator,async()=>TOKEN);assert.equal((await restarted.dispatch(f.input,f.request.student,()=>{})).jobId,job.jobId);await restarted.drain();assert.equal(f.calls(),1);
});
test("wallet authentication cannot replace independent GitHub contributor admission",async t=>{
 const f=setup(t,false);await assert.rejects(f.dispatcher.dispatch(f.input,f.request.student,()=>{}),/github_contributor_admission_required/);assert.equal(f.calls(),0);assert.equal(f.store.jobs.listRecoveryRequired().entries.length,0);
});
test("sponsor, mismatched commitments and caller credential fields cannot dispatch",async t=>{
 const f=setup(t);await assert.rejects(f.dispatcher.dispatch(f.input,f.sponsor,()=>{}));
 await assert.rejects(f.dispatcher.dispatch({...f.input,evidence:{...f.request,nonce:"aa".repeat(32)}},f.request.student,()=>{}));
 await assert.rejects(f.dispatcher.dispatch({...f.input,githubToken:TOKEN},f.request.student,()=>{}));assert.equal(f.calls(),0);
});
test("failed independent checks persist rejection and cannot authorize or rerun",async t=>{
 const f=setup(t,true,false),job=await f.dispatcher.dispatch(f.input,f.request.student,()=>{});await f.dispatcher.drain();
 assert.equal(f.store.jobs.getJob(job.jobId)!.state,"verification_rejected");await f.dispatcher.dispatch(f.input,f.request.student,()=>{});assert.equal(f.calls(),1);
});
test("session revocation during admission creates no job",async t=>{
 const f=setup(t);let checks=0;await assert.rejects(f.dispatcher.dispatch(f.input,f.request.student,()=>{if(++checks>=3)throw Error("session_revoked");}),/session_revoked/);assert.equal(f.calls(),0);assert.equal(f.store.jobs.listRecoveryRequired().entries.length,0);
});

test("worker revocation while the runner is in flight cannot finish or automatically retry",async t=>{
 const f=setup(t);f.hold();const view=await f.dispatcher.dispatch(f.input,f.request.student,()=>{});
 while(!f.calls())await new Promise<void>(resolve=>setImmediate(resolve));
 const recovered=await f.dispatcher.dispatch(f.input,f.request.student,()=>{});assert.equal(recovered.jobId,view.jobId);assert.equal(recovered.state,"verification_running");assert.equal(f.calls(),1);
 const job=f.store.jobs.getJob(view.jobId)!;f.store.jobRecovery.interruptJob(job.jobId,job.identity,job.revision,"operator_test");f.release();await f.dispatcher.drain();
 assert.equal(f.store.jobs.getJob(job.jobId)!.state,"recovery_required");await f.dispatcher.dispatch(f.input,f.request.student,()=>{});assert.equal(f.calls(),1);
});
test("one-commit contributor admission is explicit, private, scoped and refuses symlinks",async t=>{
 assert.equal(admittedContributor({}),undefined);assert.throws(()=>admittedContributor({APP_GITHUB_USER_TOKEN_FILE:"/not/configured"}),/verification_admission_configuration_required/);
 const dir=mkdtempSync(join(tmpdir(),"pow-admission-fixture-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,"fixture-credential"),r=fixture().request;
 writeFileSync(file,"syntheticTestCredential\n",{mode:0o600});
 const env={APP_GITHUB_USER_TOKEN_FILE:file,APP_VERIFICATION_MILESTONE:r.milestone,APP_VERIFICATION_REPOSITORY_ID:r.repositoryId,APP_VERIFICATION_CONTRIBUTOR_ID:r.contributorId,APP_VERIFICATION_COMMIT:r.commit};
 const admit=admittedContributor(env)!;const binding={milestone:r.milestone,student:r.student,repositoryId:r.repositoryId,contributorId:r.contributorId,commit:r.commit};assert.equal(await admit(binding),"syntheticTestCredential");assert.equal(await admit({...binding,commit:"aa".repeat(20)}),null);
 chmodSync(file,0o644);await assert.rejects(admit(binding),/verification_admission_unavailable/);chmodSync(file,0o600);
 const link=join(dir,"link");symlinkSync(file,link);await assert.rejects(admittedContributor({...env,APP_GITHUB_USER_TOKEN_FILE:link})!(binding),/verification_admission_unavailable/);
});

for(const reason of ["runner_unavailable","runner_failure","runner_timeout","github_rate_limit","github_api_failure","invalid_onchain_state","request_in_progress"] as const)test("infrastructure failure remains recoverable, never rejected: "+reason,async t=>{
 const f=setup(t,true,true,reason),job=await f.dispatcher.dispatch(f.input,f.request.student,()=>{});await f.dispatcher.drain();
 assert.equal(f.store.jobs.getJob(job.jobId)!.state,"recovery_required");assert.equal(f.store.jobs.getJob(job.jobId)!.verificationOutcome,"none");await f.dispatcher.dispatch(f.input,f.request.student,()=>{});assert.equal(f.calls(),1);
});
test("ordinary shutdown drains accepted verification before closing its store",async()=>{
 const events:string[]=[];let release!:()=>void;const done=closeApplicationStore({close:()=>{events.push("closed");}},{drain:async()=>{events.push("draining");await new Promise<void>(r=>{release=r;});events.push("completed");}});
 assert.deepEqual(events,["draining"]);release();await done;assert.deepEqual(events,["draining","completed","closed"]);
});

test("production CLI cannot activate live verifier dispatch using configuration",async()=>{
 assert.equal(LIVE_VERIFIER_DISPATCH,false);const r=fixture().request;
 await assert.rejects(startApplication({APP_GITHUB_USER_TOKEN_FILE:"/unread/offline-fixture",APP_VERIFICATION_MILESTONE:r.milestone,APP_VERIFICATION_REPOSITORY_ID:r.repositoryId,APP_VERIFICATION_CONTRIBUTOR_ID:r.contributorId,APP_VERIFICATION_COMMIT:r.commit}),/live_verifier_dispatch_disabled/);
});

test("offline dispatch adapter rejects a production RPC provenance reader",t=>{
 const f=setup(t);assert.throws(()=>new WorkflowVerification(new WorkflowStateReader(),f.store,f.coordinator,async()=>TOKEN),/invalid_verification_configuration/);
});
