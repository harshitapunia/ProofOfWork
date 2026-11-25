import {admitContributorWithDeadline} from "../src/workflow-verification.js";
import {LifecycleStore} from "@proofwork/lifecycle";
import {ControlledActions,parseApproval,scopeDigest} from "../src/controlled-actions.js";
import {ControlledAttestation,attestationScope} from "../src/controlled-attestation.js";
import {DevnetAttestationReader} from "../src/attestation-chain.js";
import {WorkflowStateReader} from "../src/workflow-state.js";
import {VerifierService} from "../src/service.js";
import {GitHub} from "../src/github.js";
import {githubFetch,TOKEN} from "./helpers.js";
import {CASES} from "../src/manifest.js";
import {prepareWorkflow} from "../src/workflow-preparation.js";
import {deriveStudentAta,deriveCompletion} from "@proofwork/finance-client";
/** Synthetic public account fixtures and disposable RAM-only Ed25519 keys. No live RPC or send. */
import {test,type TestContext} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {Keypair,PublicKey,Transaction,Message,SystemProgram} from "@solana/web3.js";
import {PROGRAM_ID,DEMO_MINT,TOKEN_PROGRAM_ID,SETTLEMENT_DEVNET_GENESIS,deriveSponsorAta,deriveVault,deriveVaultAuthority} from "@proofwork/finance-client";
import {walletLedgerFixture} from "./wallet-ledger-helpers.js";
import {manifest} from "./helpers.js";
import {parseManifest} from "../src/manifest.js";
import {APPLICATION_API_VERSION} from "../src/application-api-contracts.js";
import {ReadOnlyWalletRpc,WalletExecutionReviewer,observeDeployment,validTransactionError,UPGRADEABLE_LOADER,type WalletOperation} from "../src/devnet-wallet-review.js";
const envelope={apiVersion:APPLICATION_API_VERSION,cluster:"devnet"};
function fixture(t:TestContext,op:WalletOperation="create_internship"){
 const sponsor=Keypair.generate(),student=Keypair.generate(),verifier=Keypair.generate(),sw=sponsor.publicKey.toBase58(),st=student.publicKey.toBase58();
 const dir=mkdtempSync(join(tmpdir(),"proofwork-wallet-review-")),ledger=walletLedgerFixture(dir,sw,st,verifier.publicKey.toBase58());
 t.after(()=>{ledger.s.close();rmSync(dir,{recursive:true,force:true});});
 let now=Date.now();const time=Math.floor(now/1000),b=ledger.job.bindings;
 const terms={title:"Synthetic internship",note:"Offline fixture only",sponsor:sw,student:st,verifier:verifier.publicKey.toBase58(),internshipId:b.internshipId,milestoneId:b.milestoneId,
 rewardAmountRaw:"10",assignBy:String(time+3600),submitBy:String(time+7200),owner:"proofwork-demo",repository:"assignment",manifest:JSON.stringify(manifest())};
 const evidence={contributorId:"2002",commit:"cd".repeat(20),nonce:"ef".repeat(32),pullRequest:7};
 const workflow={...envelope,action:op==="submit_milestone"?"submission":"organization",terms,...(op==="submit_milestone"?{evidence}:{})};
 const wallet=op==="submit_milestone"?student:sponsor;
 const accounts=new Map<string,any>(ledger.accounts);const originalParent=accounts.get(b.internship);const m=Buffer.from(accounts.get(b.milestone).data[0],"base64"),sub=Buffer.from(accounts.get(b.submission).data[0],"base64");
 const wrap=(owner:string,bytes:Buffer,executable=false,lamports=100000000)=>({owner,executable,lamports,data:[bytes.toString("base64"),"base64"]});
 verifier.publicKey.toBuffer().copy(m,104);parseManifest(Buffer.from(terms.manifest)).hash.copy(m,200);m.writeBigUInt64LE(10n,240);m.writeBigInt64LE(BigInt(terms.assignBy),248);m.writeBigInt64LE(BigInt(terms.submitBy),256);m.writeBigInt64LE(0n,264);
 m.fill(0,72,104);m.fill(0,168,200);m[272]=op==="assign_student"?1:op==="submit_milestone"?2:0;
 if(op==="submit_milestone")student.publicKey.toBuffer().copy(m,72);
 accounts.set(b.milestone,wrap(PROGRAM_ID,m));accounts.set(b.submission,null);
 for(const key of [sw,st])accounts.set(key,wrap(SystemProgram.programId.toBase58(),Buffer.alloc(0)));
 function token(authority:string,amount:bigint){const d=Buffer.alloc(165);new PublicKey(DEMO_MINT).toBuffer().copy(d);new PublicKey(authority).toBuffer().copy(d,32);d.writeBigUInt64LE(amount,64);d[108]=1;return wrap(TOKEN_PROGRAM_ID,d);}
 const vault=deriveVault(b.milestone)[0].toBase58(),ata=deriveSponsorAta(sw).toBase58();accounts.set(ata,token(sw,1000n));
 accounts.set(vault,["assign_student","submit_milestone"].includes(op)?token(deriveVaultAuthority(b.milestone)[0].toBase58(),10n):null);
 if(op==="create_internship")accounts.set(b.internship,null);if(op==="create_milestone")accounts.set(b.milestone,null);
 const mint=Buffer.alloc(82);mint.writeUInt32LE(1);new PublicKey("249mMS9awYGUyMe22zabsSCo8cH4RDo3MeN3mAHFdy69").toBuffer().copy(mint,4);mint.writeBigUInt64LE(1000n,36);mint[44]=6;mint[45]=1;accounts.set(DEMO_MINT,wrap(TOKEN_PROGRAM_ID,mint));
 const artifact={bytes:Buffer.from([127,69,76,70,1,2,3]),sha256:""};artifact.sha256=createHash("sha256").update(artifact.bytes).digest("hex");
 const pd=PublicKey.findProgramAddressSync([new PublicKey(PROGRAM_ID).toBuffer()],new PublicKey(UPGRADEABLE_LOADER))[0].toBase58();
 const p=Buffer.alloc(36);p.writeUInt32LE(2);new PublicKey(pd).toBuffer().copy(p,4);accounts.set(PROGRAM_ID,wrap(UPGRADEABLE_LOADER,p,true));
 const pdbytes=Buffer.alloc(45+artifact.bytes.length+8);pdbytes.writeUInt32LE(3);pdbytes.writeBigUInt64LE(1n,4);artifact.bytes.copy(pdbytes,45);accounts.set(pd,wrap(UPGRADEABLE_LOADER,pdbytes));
 const calls:string[]=[];const responses:any={getGenesisHash:SETTLEMENT_DEVNET_GENESIS,getBlockTime:time,getLatestBlockhash:{context:{slot:200},value:{blockhash:new PublicKey(Buffer.alloc(32,7)).toBase58(),lastValidBlockHeight:500}},getBlockHeight:100,isBlockhashValid:{context:{slot:200},value:true},getFeeForMessage:{context:{slot:200},value:5000},getMinimumBalanceForRentExemption:1000000,getSignatureStatuses:{context:{slot:200},value:[null]},getTransaction:null};
 const rpc=new ReadOnlyWalletRpc(async(_url,init)=>{const q=JSON.parse(String(init?.body));calls.push(q.method);const value=q.method==="getMultipleAccounts"?{context:{slot:200},value:q.params[0].map((at:string)=>accounts.get(at)??null)}:responses[q.method];
  if(value instanceof Error)throw value;return Response.json({jsonrpc:"2.0",id:q.id,result:value});});
 const reviewer=new WalletExecutionReviewer(rpc,async()=>artifact,()=>now);
 return {dir,store:ledger.s,reviewer,rpc,accounts,originalParent,terms,workflow,wallet,sponsor,student,verifierKeypair:verifier,b,m,sub,wrap,token,vault,ata,pd,artifact,calls,responses,op,input:{workflow,operation:op},advance:(n:number)=>{now+=n;}};
}
for(const op of ["create_internship","create_milestone","fund_milestone","assign_student","submit_milestone"] as const)test("fresh validated single-wallet instruction review: "+op,async t=>{
 const f=fixture(t,op),r=await f.reviewer.review(f.input,f.wallet.publicKey.toBase58());assert.equal(r.state,"ready_for_review");assert.equal(r.liveExecution,false);assert.deepEqual(r.blockers,["live_execution_disabled"]);
 const m=Message.from(Buffer.from(r.messageBase64!,"base64"));assert.equal(m.instructions.length,1);assert.equal(m.header.numRequiredSignatures,1);assert.equal(m.accountKeys[0]!.toBase58(),f.wallet.publicKey.toBase58());
 assert.equal(r.deployment?.artifactEquality,"rpc_bytes_match_reviewed_artifact");assert.equal(r.rewardPayment,"not_established");assert(!f.calls.some(c=>c.startsWith("send")));await f.reviewer.revalidate(r.reviewId!,r.wallet);
});
for(const [name,op,mutate,code] of [
 ["wrong genesis","create_internship",(f:any)=>{f.responses.getGenesisHash="wrong";},"wrong_cluster"],
 ["missing program","create_internship",(f:any)=>f.accounts.set(PROGRAM_ID,null),"missing_program"],
 ["wrong program owner","create_internship",(f:any)=>{f.accounts.get(PROGRAM_ID).owner=TOKEN_PROGRAM_ID;},"invalid_program_owner_or_executable"],
 ["program not executable","create_internship",(f:any)=>{f.accounts.get(PROGRAM_ID).executable=false;},"invalid_program_owner_or_executable"],
 ["wrong mint owner","create_internship",(f:any)=>{f.accounts.get(DEMO_MINT).owner=PROGRAM_ID;},"incorrect_mint_owner"],
 ["wrong mint decimals","create_internship",(f:any)=>{const a=f.accounts.get(DEMO_MINT),d=Buffer.from(a.data[0],"base64");d[44]=9;a.data[0]=d.toString("base64");},"incorrect_mint_configuration"],
 ["artifact mismatch","create_internship",(f:any)=>{const a=f.accounts.get(f.pd),d=Buffer.from(a.data[0],"base64");d[45]=1;a.data[0]=d.toString("base64");},"deployed_artifact_mismatch"],
 ["unapproved upgrade authority","create_internship",(f:any)=>{const a=f.accounts.get(f.pd),d=Buffer.from(a.data[0],"base64");d[12]=1;f.sponsor.publicKey.toBuffer().copy(d,13);a.data[0]=d.toString("base64");},"upgrade_authority_policy_unapproved"],
 ["duplicate internship","create_internship",(f:any)=>f.accounts.set(f.b.internship,f.wrap(PROGRAM_ID,Buffer.alloc(49))),"duplicate_internship"],
 ["duplicate milestone","create_milestone",(f:any)=>f.accounts.set(f.b.milestone,f.wrap(PROGRAM_ID,Buffer.alloc(276))),"duplicate_milestone"],
 ["insufficient tokens","fund_milestone",(f:any)=>f.accounts.set(f.ata,f.token(f.terms.sponsor,9n)),"insufficient_tokens"],
 ["wrong token authority","fund_milestone",(f:any)=>f.accounts.set(f.ata,f.token(f.terms.student,1000n)),"invalid_token_account"],
 ["insufficient rent and fee","create_internship",(f:any)=>{f.accounts.get(f.terms.sponsor).lamports=1;},"insufficient_lamports"],
 ["stale fee response","create_internship",(f:any)=>{f.responses.getFeeForMessage.context.slot=199;},"stale_rpc_context"],
 ["stale validity response","create_internship",(f:any)=>{f.responses.isBlockhashValid.context.slot=199;},"stale_rpc_context"],
 ["expired blockhash","create_internship",(f:any)=>{f.responses.isBlockhashValid.value=false;},"expired_blockhash"],
 ["expired height","create_internship",(f:any)=>{f.responses.getBlockHeight=500;},"expired_blockhash"],
 ["expired chain deadline","fund_milestone",(f:any)=>{f.responses.getBlockTime=Number(f.terms.assignBy);},"expired_deadline"],
 ["RPC failure","create_internship",(f:any)=>{f.responses.getGenesisHash=new Error("unsafe upstream detail");},"rpc_unavailable"],
] as const)test("review blocks "+name,async t=>{const f=fixture(t,op);mutate(f);const out=await f.reviewer.review(f.input,f.wallet.publicKey.toBase58());assert.equal(out.state,"blocked");assert.equal(out.messageBase64,null);assert.deepEqual(out.blockers,[code]);assert(!JSON.stringify(out).includes("unsafe upstream detail"));});
test("session wallet and instruction role cannot be supplied by proposal JSON",async t=>{const f=fixture(t,"submit_milestone");await assert.rejects(f.reviewer.review(f.input,f.sponsor.publicKey.toBase58()),{code:"workflow_forbidden"});
 await assert.rejects(f.reviewer.review({...f.input,operation:"fund_milestone"},f.wallet.publicKey.toBase58()),{code:"incorrect_required_signer"});});
test("expired lease and substituted signed transaction are rejected without broadcasting",async t=>{
 const f=fixture(t),r=await f.reviewer.review(f.input,f.wallet.publicKey.toBase58());const tx=Transaction.populate(Message.from(Buffer.from(r.messageBase64!,"base64")));tx.sign(f.wallet);
 const wire=tx.serialize().toString("base64");assert(f.reviewer.validateSigned(r.reviewId!,r.wallet,wire).signature);
 tx.recentBlockhash=new PublicKey(Buffer.alloc(32,9)).toBase58();tx.sign(f.wallet);assert.throws(()=>f.reviewer.validateSigned(r.reviewId!,r.wallet,tx.serialize().toString("base64")),{code:"transaction_substitution"});
 f.advance(20000);await assert.rejects(f.reviewer.revalidate(r.reviewId!,r.wallet),{code:"review_expired"});const count=f.calls.length;await assert.rejects(f.reviewer.broadcast(),{code:"live_execution_disabled"});assert.equal(f.calls.length,count);
});
test("status signatures, failures and wrong account postconditions never become confirmed",async t=>{
 const f=fixture(t),r=await f.reviewer.review(f.input,f.wallet.publicKey.toBase58()),tx=Transaction.populate(Message.from(Buffer.from(r.messageBase64!,"base64")));tx.sign(f.wallet);const wire=tx.serialize().toString("base64");
 assert.equal((await f.reviewer.confirm(r.reviewId!,r.wallet,wire)).state,"unknown");
 f.responses.getSignatureStatuses={context:{slot:200},value:[{slot:200,confirmationStatus:"confirmed",err:{InstructionError:[0,{Custom:6000}]}}]};assert.equal((await f.reviewer.confirm(r.reviewId!,r.wallet,wire)).state,"failed");
 f.responses.getSignatureStatuses.value[0].err=null;f.responses.getTransaction={slot:200,meta:{err:null},transaction:[wire,"base64"]};
 assert.equal((await f.reviewer.confirm(r.reviewId!,r.wallet,wire)).state,"unknown"); // status without actual initialized account is insufficient
 f.accounts.set(f.b.internship,f.originalParent); // Reuse the existing valid account fixture for the observed postcondition.
 const confirmed=await f.reviewer.confirm(r.reviewId!,r.wallet,wire);assert.equal(confirmed.state,"confirmed");assert(confirmed.explorerUrl?.endsWith("?cluster=devnet"));assert.equal(confirmed.rewardPayment,"not_established");
 f.responses.getTransaction.transaction[0]="changed";assert.equal((await f.reviewer.confirm(r.reviewId!,r.wallet,wire)).state,"unknown");
});
test("RPC method allowlist rejects sends and mutable configuration without any network",async()=>{let calls=0;const rpc=new ReadOnlyWalletRpc(async()=>{calls++;throw Error();});await assert.rejects(rpc.call("sendTransaction",[]),{code:"rpc_method_disabled"});assert.equal(calls,0);});

test("deployment missing mint and wrong ProgramData ownership are independently rejected",async t=>{
 const f=fixture(t),mint=f.accounts.get(DEMO_MINT);f.accounts.set(DEMO_MINT,null);const observed=await observeDeployment(f.rpc,f.artifact);assert.equal(observed.mint.exists,false);assert(observed.blockers.includes("missing_mint"));
 f.accounts.set(DEMO_MINT,mint);f.accounts.get(f.pd).owner=PROGRAM_ID;await assert.rejects(observeDeployment(f.rpc,f.artifact),{code:"invalid_programdata"});
});
for(const op of ["create_milestone","fund_milestone","assign_student","submit_milestone"] as const)test("confirmed exact transaction and "+op+" postconditions",async t=>{
 const f=fixture(t,op),r=await f.reviewer.review(f.input,f.wallet.publicKey.toBase58());assert.equal(r.state,"ready_for_review");
 const tx=Transaction.populate(Message.from(Buffer.from(r.messageBase64!,"base64")));tx.sign(f.wallet);const wire=tx.serialize().toString("base64");
 f.responses.getSignatureStatuses={context:{slot:200},value:[{slot:200,confirmationStatus:"confirmed",err:null}]};f.responses.getTransaction={slot:200,meta:{err:null},transaction:[wire,"base64"]};
 if(op==="create_milestone")f.accounts.set(f.b.milestone,f.wrap(PROGRAM_ID,f.m));
 if(op==="fund_milestone"){
  const index=tx.compileMessage().accountKeys.findIndex(k=>k.toBase58()===f.ata);
  const tokenRow=(amount:string)=>({accountIndex:index,owner:f.terms.sponsor,mint:DEMO_MINT,uiTokenAmount:{amount,decimals:6}});
  f.responses.getTransaction.meta.preTokenBalances=[tokenRow("1100")];
  f.responses.getTransaction.meta.postTokenBalances=[tokenRow("1090")];
  f.m[272]=1;f.accounts.set(f.b.milestone,f.wrap(PROGRAM_ID,f.m));f.accounts.set(f.vault,f.token(deriveVaultAuthority(f.b.milestone)[0].toBase58(),10n));f.accounts.set(f.ata,f.token(f.terms.sponsor,1130n));}
 if(op==="assign_student"){f.m[272]=2;f.student.publicKey.toBuffer().copy(f.m,72);f.accounts.set(f.b.milestone,f.wrap(PROGRAM_ID,f.m));}
 if(op==="submit_milestone"){
  f.m[272]=3;new PublicKey(f.b.submission).toBuffer().copy(f.m,168);f.accounts.set(f.b.milestone,f.wrap(PROGRAM_ID,f.m));
  const evidence=(await import("../src/workflow-preparation.js")).prepareWorkflow(f.workflow,f.wallet.publicKey.toBase58()).evidenceHash!;
  Buffer.from(evidence,"hex").copy(f.sub,72);f.sub.writeBigInt64LE(BigInt(f.responses.getBlockTime),104);f.accounts.set(f.b.submission,f.wrap(PROGRAM_ID,f.sub));
 }
 const confirmed=await f.reviewer.confirm(r.reviewId!,r.wallet,wire);assert.equal(confirmed.state,"confirmed");assert.equal(confirmed.rewardPayment,"not_established");
 f.responses.getSignatureStatuses=new Error("no response after send");assert.equal((await f.reviewer.confirm(r.reviewId!,r.wallet,wire)).state,"unknown");
});
test("invalid signature cannot be accepted as a connected wallet's authorization",async t=>{
 const f=fixture(t),r=await f.reviewer.review(f.input,f.wallet.publicKey.toBase58()),tx=Transaction.populate(Message.from(Buffer.from(r.messageBase64!,"base64")));tx.sign(f.wallet);tx.signatures[0]!.signature=Buffer.alloc(64,9);
 assert.throws(()=>f.reviewer.validateSigned(r.reviewId!,r.wallet,tx.serialize({verifySignatures:false}).toString("base64")),{code:"transaction_substitution"});
});

test("revalidation refreshes payer balance and rent before any wallet approval",async t=>{
 const f=fixture(t),r=await f.reviewer.review(f.input,f.wallet.publicKey.toBase58());f.accounts.get(r.wallet).lamports=1;
 await assert.rejects(f.reviewer.revalidate(r.reviewId!,r.wallet),{code:"insufficient_lamports"});f.accounts.get(r.wallet).lamports=100000000;
 f.responses.getMinimumBalanceForRentExemption=1000001;await assert.rejects(f.reviewer.revalidate(r.reviewId!,r.wallet),{code:"rent_changed"});
});

test("revalidation cannot use workflow accounts older than its fresh deployment observation",async t=>{
 const f=fixture(t),r=await f.reviewer.review(f.input,f.wallet.publicKey.toBase58());assert.equal(r.state,"ready_for_review");
 const original=f.rpc.call.bind(f.rpc);let minimum:number|null=null;
 f.rpc.call=async(method:string,params:unknown[]=[],signal?:AbortSignal)=>{
  const value=await original(method,params,signal);
  if(method==="getMultipleAccounts"){
   const [addresses,config]=params as [string[],{minContextSlot:number}];
   if(addresses[0]===PROGRAM_ID)value.context.slot=250;
   else minimum=config.minContextSlot; // workflow response deliberately remains at slot 200
  }
  return value;
 };
 await assert.rejects(f.reviewer.revalidate(r.reviewId!,r.wallet),{code:"invalid_rpc_response"});assert.equal(minimum,250);
});

function settlementFixture(t:TestContext,surplus=0n,changedAuthority=false){
 const f=fixture(t,"submit_milestone"),wallet=f.sponsor,scope={...envelope,sponsor:f.terms.sponsor,internshipId:f.terms.internshipId,milestoneId:f.terms.milestoneId};
 f.m[272]=4;new PublicKey(f.b.submission).toBuffer().copy(f.m,168);f.m.writeBigInt64LE(BigInt(f.responses.getBlockTime-1),264);f.sub.writeBigInt64LE(BigInt(f.responses.getBlockTime-10),104);
 f.accounts.set(f.b.internship,{...f.originalParent,lamports:1000000});f.accounts.set(f.b.milestone,f.wrap(PROGRAM_ID,f.m));f.accounts.set(f.b.submission,f.wrap(PROGRAM_ID,f.sub));
 f.accounts.set(f.vault,f.token(deriveVaultAuthority(f.b.milestone)[0].toBase58(),10n+surplus));const studentAta=deriveStudentAta(f.terms.student).toBase58();f.accounts.set(studentAta,f.token(f.terms.student,100n));
 if(changedAuthority)f.accounts.set(f.ata,f.token(f.terms.student,1000n));
 return {...f,wallet,scope,studentAta,surplus,changedAuthority,input:{operation:"settle_milestone",workflow:scope}};
}
async function settledReceipt(f:ReturnType<typeof settlementFixture>){
 const review=await f.reviewer.review(f.input,f.wallet.publicKey.toBase58());assert.equal(review.state,"ready_for_review",JSON.stringify(review.blockers));
 await f.reviewer.revalidate(review.reviewId!,review.wallet);
 const tx=Transaction.populate(Message.from(Buffer.from(review.messageBase64!,"base64")));tx.sign(f.wallet);const wire=tx.serialize().toString("base64"),keys=tx.compileMessage().accountKeys.map(k=>k.toBase58()),destination=tx.instructions.at(-1)!.keys[9]!.pubkey.toBase58(),completion=deriveCompletion(f.b.milestone)[0].toBase58();
 const index=(a:string)=>keys.indexOf(a),tokenRow=(a:string,owner:string,amount:bigint)=>({accountIndex:index(a),mint:DEMO_MINT,owner,uiTokenAmount:{amount:amount.toString(),decimals:6}});
 const pre=keys.map(k=>f.accounts.get(k)?.lamports??0),post=pre.slice(),vaultRent=pre[index(f.vault)]!;
 post[index(f.vault)]=0;post[index(completion)]=1000000;if(f.changedAuthority)post[index(destination)]=1000000;
 post[index(review.wallet)]=pre[index(review.wallet)]!+vaultRent-5000-Number(review.rentLamports);
 const meta={err:null,fee:5000,preBalances:pre,postBalances:post,
  preTokenBalances:[tokenRow(f.studentAta,f.terms.student,100n),tokenRow(f.vault,deriveVaultAuthority(f.b.milestone)[0].toBase58(),10n+f.surplus),...(f.changedAuthority?[]:[tokenRow(destination,f.terms.sponsor,1000n)])],
  postTokenBalances:[tokenRow(f.studentAta,f.terms.student,110n),tokenRow(destination,f.terms.sponsor,(f.changedAuthority?0n:1000n)+f.surplus)]};
 f.m[272]=5;f.accounts.set(f.b.milestone,f.wrap(PROGRAM_ID,f.m));f.accounts.set(f.vault,null);f.accounts.set(f.studentAta,f.token(f.terms.student,110n));f.accounts.set(destination,f.token(f.terms.sponsor,(f.changedAuthority?0n:1000n)+f.surplus));
 const record=Buffer.alloc(249);createHash("sha256").update("account:CompletionRecord").digest().copy(record,0,0,8);
 for(const [offset,value] of [[8,f.b.milestone],[40,f.terms.student],[72,f.terms.sponsor],[104,f.terms.verifier],[136,f.b.submission]] as const)new PublicKey(value).toBuffer().copy(record,offset);
 f.m.copy(record,168,200,232);f.sub.copy(record,200,72,104);record.writeBigInt64LE(f.m.readBigInt64LE(264),232);record.writeBigInt64LE(BigInt(f.responses.getBlockTime),240);record[248]=deriveCompletion(f.b.milestone)[1];f.accounts.set(completion,f.wrap(PROGRAM_ID,record,false,1000000));
 f.responses.getSignatureStatuses={context:{slot:200},value:[{slot:200,confirmationStatus:"confirmed",err:null}]};f.responses.getTransaction={slot:200,meta,transaction:[wire,"base64"]};
 return {review,wire,meta,tx,destination,completion,confirm:()=>f.reviewer.confirm(review.reviewId!,review.wallet,wire)};
}
for(const surplus of [0n,7n])for(const changed of [false,true])test("exact settlement receipt: surplus="+surplus+", changed sponsor ATA authority="+changed,async t=>{
 const f=settlementFixture(t,surplus,changed),x=await settledReceipt(f),v=await x.confirm();assert.equal(v.state,"confirmed");assert.equal(v.rewardPayment,"exact_reward_confirmed");assert.equal(v.settlement?.rewardAmountRaw,"10");assert.equal(v.settlement?.studentBeforeRaw,"100");assert.equal(v.settlement?.studentAfterRaw,"110");assert.equal(v.settlement?.sponsorSurplusRaw,surplus.toString());assert.equal(v.settlement?.completion,x.completion);
 assert.equal((await f.reviewer.review(f.input,f.wallet.publicKey.toBase58())).state,"blocked");await assert.rejects(f.reviewer.broadcast(),{code:"live_execution_disabled"});assert(!f.calls.some(c=>c.startsWith("send")));
});
for(const fault of ["student_delta","surplus_delta","rent_destination","missing_metadata","wrong_wire","processed_only","missing_completion","fee_changed","rent_cap_exceeded"])test("settlement receipt refuses "+fault,async t=>{
 const f=settlementFixture(t,7n),x=await settledReceipt(f);
 if(fault==="student_delta")x.meta.postTokenBalances[0]!.uiTokenAmount.amount="111";
 if(fault==="surplus_delta")x.meta.postTokenBalances[1]!.uiTokenAmount.amount="1008";
 if(fault==="rent_destination")x.meta.postBalances[x.tx.compileMessage().accountKeys.findIndex(k=>k.toBase58()===f.terms.sponsor)]!--;
 if(fault==="missing_metadata")delete (x.meta as any).preTokenBalances;
 if(fault==="wrong_wire")f.responses.getTransaction.transaction[0]="wrong";
 if(fault==="processed_only")f.responses.getSignatureStatuses.value[0].confirmationStatus="processed";
 if(fault==="fee_changed")x.meta.fee++;
 if(fault==="rent_cap_exceeded")x.meta.postBalances[x.tx.compileMessage().accountKeys.findIndex(k=>k.toBase58()===x.completion)]!++;
 if(fault==="missing_completion")f.accounts.set(x.completion,null);
 const result=await x.confirm();assert.equal(result.state,"unknown");assert.equal(result.rewardPayment,"not_established");assert.equal(result.retryAuthorized,false);
});

test("settlement uses transaction-local balances after independent credits and vault donations",async t=>{
 const f=settlementFixture(t,7n),x=await settledReceipt(f),rows=x.meta.preTokenBalances,after=x.meta.postTokenBalances;
 rows[0]!.uiTokenAmount.amount="105";after[0]!.uiTokenAmount.amount="115";
 rows[1]!.uiTokenAmount.amount="20";rows[2]!.uiTokenAmount.amount="1002";after[1]!.uiTokenAmount.amount="1012";
 const result=await x.confirm();assert.equal(result.state,"confirmed");assert.equal(result.settlement?.studentBeforeRaw,"105");assert.equal(result.settlement?.studentAfterRaw,"115");assert.equal(result.settlement?.sponsorSurplusRaw,"10");
});

test("settlement accounts for unsolicited vault rent donation using the correlated transaction",async t=>{
 const f=settlementFixture(t),x=await settledReceipt(f),keys=x.tx.compileMessage().accountKeys.map(k=>k.toBase58());
 const vault=keys.indexOf(f.vault),sponsor=keys.indexOf(f.terms.sponsor),before=x.meta.preBalances[vault]!;
 x.meta.preBalances[vault]!+=9;x.meta.postBalances[sponsor]!+=9;const result=await x.confirm();assert.equal(result.state,"confirmed");assert.equal(result.settlement?.rentReturnedRaw,String(before+9));
});

test("settlement retains the existing plain system fee-payer account requirement",async t=>{
 for(const fault of ["owner","executable","data","missing"]){
  const f=settlementFixture(t),wallet=f.wallet.publicKey.toBase58(),a=f.accounts.get(wallet);
  if(fault==="owner")a.owner=TOKEN_PROGRAM_ID;
  if(fault==="executable")a.executable=true;
  if(fault==="data")a.data=[Buffer.from([1]).toString("base64"),"base64"];
  if(fault==="missing")f.accounts.set(wallet,null);
  const review=await f.reviewer.review(f.input,wallet);assert.equal(review.state,"blocked");assert.equal(review.messageBase64,null);assert(!f.calls.some(method=>method.startsWith("send")));
 }
});

function approvalConfiguration(action:any){return parseApproval({version:"proofwork-controlled-devnet-v1",programId:PROGRAM_ID,mint:DEMO_MINT,genesis:SETTLEMENT_DEVNET_GENESIS,artifactSha256:"1711e2dbbd2f0129f34be5d70e3e48867c42a849b2beea7d36cfbddaf2ed64e1",upgradeAuthority:null,actions:[action]});}
function fixtureArtifactApproval(actions:ControlledActions,sha256:string){const configuration=actions.configuration.bind(actions);actions.configuration=async()=>({...await configuration(),artifactSha256:sha256});return actions;}
async function controlledWallet(t:TestContext,transport:"ok"|"timeout"|"wrong"="ok"){
 const f=fixture(t),preview=await f.reviewer.review(f.input,f.wallet.publicKey.toBase58());
 const action={id:"synthetic-action",operationKey:preview.operationKey!,scopeDigest:preview.scopeDigest!,wallet:preview.wallet,additionalSigner:null,expiresAt:new Date(Date.now()+60000).toISOString(),maxFeeLamports:5000,maxRentLamports:1000000};
 let configuration=approvalConfiguration(action),sends=0;const actions=new ControlledActions(f.store,async()=>configuration,async(url,init)=>{assert.equal(url,"https://api.devnet.solana.com");const body=JSON.parse(String(init?.body));assert.equal(body.method,"sendTransaction");assert.deepEqual(body.params[1],{encoding:"base64",skipPreflight:false,preflightCommitment:"confirmed",maxRetries:0});sends++;if(transport==="timeout")throw Error("uncertain transport");return Response.json({jsonrpc:"2.0",id:body.id,result:transport==="wrong"?"wrong":(await import("../src/devnet-execution.js")).transactionId(Transaction.from(Buffer.from(body.params[0],"base64")).signatures[0]!.signature!)});});
 fixtureArtifactApproval(actions,f.artifact.sha256);const reviewer=new WalletExecutionReviewer(f.rpc,async()=>f.artifact,()=>Date.now(),actions),review=await reviewer.review(f.input,preview.wallet);
 const tx=Transaction.populate(Message.from(Buffer.from(review.messageBase64!,"base64")));tx.sign(f.wallet);const wire=tx.serialize().toString("base64");
 return {...f,reviewer,review,wire,actions,action,setApproval:(next:unknown)=>{configuration=approvalConfiguration(next);},revoke:()=>{configuration={...configuration,actions:[]};},sends:()=>sends};
}
test("approved wallet path reserves before Phantom and submits once without broad RPC capability",async t=>{
 const f=await controlledWallet(t);assert.equal(f.review.liveExecution,true);assert.equal(f.sends(),0);await f.reviewer.authorize(f.review.reviewId!,f.review.wallet);
 await assert.rejects(f.reviewer.authorize(f.review.reviewId!,f.review.wallet));assert.equal(f.sends(),0);
 const result=await f.reviewer.submission(f.review.reviewId!,f.review.wallet,f.wire);assert.equal(result.state,"submitted");assert.equal(f.sends(),1);
 await assert.rejects(f.reviewer.submission(f.review.reviewId!,f.review.wallet,f.wire));assert.equal(f.sends(),1);
 assert.equal((await f.reviewer.review(f.input,f.review.wallet)).liveExecution,false);
});
for(const transport of ["timeout","wrong"] as const)test("uncertain "+transport+" persists one-send fence across new controller",async t=>{
 const f=await controlledWallet(t,transport);await f.reviewer.authorize(f.review.reviewId!,f.review.wallet);const result=await f.reviewer.submission(f.review.reviewId!,f.review.wallet,f.wire);assert.equal(result.state,"unknown");
 const row=f.store.applicationTransactions.get(f.review.reviewId!)!;assert.equal(row.state,"unknown");assert.equal(row.sendReserved,true);await assert.rejects(f.reviewer.submission(f.review.reviewId!,f.review.wallet,f.wire));assert.equal(f.sends(),1);
});
test("approval revocation and revoked HTTP session cannot send",async t=>{
 const f=await controlledWallet(t);await f.reviewer.authorize(f.review.reviewId!,f.review.wallet);await assert.rejects(f.reviewer.submission(f.review.reviewId!,f.review.wallet,f.wire,()=>{throw Error("session revoked");}));assert.equal(f.sends(),0);
 f.revoke();await assert.rejects(f.reviewer.submission(f.review.reviewId!,f.review.wallet,f.wire));assert.equal(f.sends(),0);
});
for(const field of ["wallet","scopeDigest","maxFeeLamports","maxRentLamports","expiresAt"] as const)test("action binding mismatch blocks "+field,async t=>{
 const f=fixture(t),preview=await f.reviewer.review(f.input,f.wallet.publicKey.toBase58());const a:any={id:"synthetic-action",operationKey:preview.operationKey,scopeDigest:preview.scopeDigest,wallet:preview.wallet,additionalSigner:null,expiresAt:new Date(Date.now()+60000).toISOString(),maxFeeLamports:5000,maxRentLamports:1000000};
 a[field]=field==="wallet"?f.student.publicKey.toBase58():field==="scopeDigest"?"00".repeat(32):field==="expiresAt"?new Date(0).toISOString():0;
 const actions=new ControlledActions(f.store,async()=>approvalConfiguration(a),async()=>{throw Error("must not send");}),reviewer=new WalletExecutionReviewer(f.rpc,async()=>f.artifact,()=>Date.now(),fixtureArtifactApproval(actions,f.artifact.sha256)),review=await reviewer.review(f.input,preview.wallet);assert.equal(review.liveExecution,false);await assert.rejects(reviewer.authorize(review.reviewId!,preview.wallet));
 const tx=Transaction.populate(Message.from(Buffer.from(review.messageBase64!,"base64")));
 tx.partialSign(f.wallet);
 const wire=tx.serialize().toString("base64");
 assert.equal(await reviewer.acceptSignature(review.reviewId!,preview.wallet,wire),reviewer.validateSigned(review.reviewId!,preview.wallet,wire).signature);
 assert.equal(f.store.applicationTransactions.getForOperation(review.operationKey!),undefined);

});
async function controlledAttestation(t:TestContext,fail=false){
 const f=fixture(t,"submit_milestone"),payer=Keypair.generate(),payerKey=payer.publicKey.toBase58(),student=f.student.publicKey.toBase58(),verifier=f.terms.verifier;
 const plan=prepareWorkflow(f.workflow,student);f.m[272]=3;new PublicKey(f.b.submission).toBuffer().copy(f.m,168);f.accounts.set(f.b.milestone,f.wrap(PROGRAM_ID,f.m));Buffer.from(plan.evidenceHash!,"hex").copy(f.sub,72);f.sub.writeBigInt64LE(BigInt(f.responses.getBlockTime),104);f.accounts.set(f.b.submission,f.wrap(PROGRAM_ID,f.sub));f.accounts.set(payerKey,f.wrap(SystemProgram.programId.toBase58(),Buffer.alloc(0)));
 const chain=new DevnetAttestationReader("https://api.devnet.solana.com",verifier,async(_url,init)=>{const body=JSON.parse(String(init?.body));return Response.json({result:await f.rpc.call(body.method,body.params)});});
 const initial=await chain.read(f.b.milestone),action={id:"synthetic-attestation",operationKey:"attest_milestone:"+f.b.milestone,scopeDigest:attestationScope(initial,payerKey),wallet:payerKey,additionalSigner:verifier,expiresAt:new Date(Date.now()+60000).toISOString(),maxFeeLamports:5000,maxRentLamports:0};
 const store=new LifecycleStore(join(f.dir,"controlled.sqlite"));t.after(()=>store.close());
 let sends=0,time=0,runs=0,runnerGate:(()=>Promise<void>)|undefined,lastWire:string|undefined,configuration=approvalConfiguration(action);const actions=new ControlledActions(store,async()=>configuration,async(_url,init)=>{sends++;const body=JSON.parse(String(init?.body)),tx=Transaction.from(Buffer.from(body.params[0],"base64"));assert(tx.verifySignatures());lastWire=body.params[0];return Response.json({jsonrpc:"2.0",id:body.id,result:(await import("../src/devnet-execution.js")).transactionId(tx.signatures[0]!.signature!)});});
 fixtureArtifactApproval(actions,f.artifact.sha256);const service=()=>new VerifierService(new GitHub(githubFetch()),chain,{run:async()=>{runs++;if(runnerGate)await runnerGate();return CASES.map(c=>({id:c.id,passed:!fail}));}});
 const reader=new WorkflowStateReader(f.rpc,"offline_fixture"),makeCoordinator=(admit:()=>Promise<string>=async()=>TOKEN)=>new ControlledAttestation(reader,store,service(),chain,actions,admit,f.rpc,{read:async()=>({rpc:"https://api.devnet.solana.com",genesisHash:SETTLEMENT_DEVNET_GENESIS,blockhash:f.responses.getLatestBlockhash.value.blockhash,lastValidBlockHeight:500,currentBlockHeight:100,observedAtMs:time,valid:true})},async()=>f.artifact,()=>time);
 const input={...envelope,sponsor:f.terms.sponsor,internshipId:f.terms.internshipId,milestoneId:f.terms.milestoneId,evidence:{manifestBase64:Buffer.from(f.terms.manifest).toString("base64"),milestone:f.b.milestone,student,repositoryId:"1001",owner:f.terms.owner,repository:f.terms.repository,...f.workflow.evidence}};
 return {...f,store,actions,payer,student,verifier,coordinator:makeCoordinator(),makeCoordinator,action,setApproval:(next:unknown)=>{configuration=approvalConfiguration(next);},runs:()=>runs,holdRunner:(hook:()=>Promise<void>)=>{runnerGate=hook;},lastWire:()=>lastWire,input,sends:()=>sends,expire:()=>{time=30000;}};
}
test("trusted verifier failure never exposes a Phantom attestation message",async t=>{const f=await controlledAttestation(t,true),job=await f.coordinator.dispatch(f.input,f.student,()=>{});await f.coordinator.drain();await assert.rejects(f.coordinator.review(job.jobId,f.verifier));assert.equal(f.sends(),0);assert.equal(f.store.jobs.getJob(job.jobId)!.verificationOutcome,"rejected");});
test("attestation allows only both explicit roles, requires their signatures and rejects expiry",async t=>{
 const f=await controlledAttestation(t),job=await f.coordinator.dispatch(f.input,f.student,()=>{});await f.coordinator.drain();assert.equal(f.store.jobs.getJob(job.jobId)!.verificationOutcome,"passed");
 await assert.rejects(f.coordinator.review(job.jobId,f.student));const review=await f.coordinator.review(job.jobId,f.verifier);assert.equal(review.signatureCount,0);assert.equal(review.liveExecution,true);
 await f.coordinator.authorize(job.jobId,f.verifier,()=>{});await assert.rejects(f.coordinator.authorize(job.jobId,f.verifier,()=>{}));
 await assert.rejects(f.coordinator.broadcast(job.jobId,f.payer.publicKey.toBase58(),()=>{}));assert.equal(f.sends(),0);
 f.expire();await assert.rejects(f.coordinator.review(job.jobId,f.verifier));await assert.rejects(f.coordinator.broadcast(job.jobId,f.payer.publicKey.toBase58(),()=>{}));assert.equal(f.sends(),0);
});
test("canonical public scope hashing is stable without admitting field substitution",()=>{assert.equal(scopeDigest({a:1,b:{d:2,c:3}}),scopeDigest({b:{c:3,d:2},a:1}));assert.notEqual(scopeDigest({a:1}),scopeDigest({a:2}));});

test("two independently partial-signed messages merge, verify and submit exactly once",async t=>{
 const f=await controlledAttestation(t),job=await f.coordinator.dispatch(f.input,f.student,()=>{});await f.coordinator.drain();const payer=f.payer.publicKey.toBase58();
 const review=await f.coordinator.review(job.jobId,f.verifier);
 // Retrieve the exact message through the same base58 representation supplied to Phantom.
 const alphabet="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";let number=0n;for(const c of review.messageBase58)number=number*58n+BigInt(alphabet.indexOf(c));let h=number.toString(16);if(h.length%2)h="0"+h;const leading=review.messageBase58.length-review.messageBase58.replace(/^1+/,"").length;const bytes=Buffer.concat([Buffer.alloc(leading),Buffer.from(h,"hex")]);

 const payerReview=await f.coordinator.review(job.jobId,payer);
 assert.equal(payerReview.reviewId,review.reviewId);
 for(const signer of [f.verifierKeypair,f.payer]){
   const wallet=signer.publicKey.toBase58();
   await f.coordinator.authorize(job.jobId,wallet,()=>{});
   const tx=Transaction.populate(Message.from(bytes));
   tx.partialSign(signer);
   const wire=tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString("base64");
   if(wallet===payer){
     const injected=t.mock.method(f.actions,"signed",async()=>{throw Error("synthetic recording failure");});
     await assert.rejects(f.coordinator.validate(job.jobId,wallet,wire),/synthetic recording failure/);
     assert.equal((await f.coordinator.review(job.jobId,payer)).signatureCount,1);
     await assert.rejects(f.coordinator.broadcast(job.jobId,payer,()=>{}));
     assert.equal(f.sends(),0);
     injected.mock.restore();
   }
   const out=await f.coordinator.validate(job.jobId,wallet,wire);
   assert.equal(out.signatureCount,wallet===payer?2:1);
 }
 assert.equal((await f.coordinator.review(job.jobId,payer)).signatureCount,2);assert.equal((await f.coordinator.broadcast(job.jobId,payer,()=>{})).state,"submitted");assert.equal(f.sends(),1);await assert.rejects(f.coordinator.broadcast(job.jobId,payer,()=>{}));assert.equal(f.sends(),1);
 const wire=f.lastWire()!;
 f.responses.getSignatureStatuses={context:{slot:200},value:[{slot:200,confirmationStatus:"confirmed",err:false}]};
 f.responses.getTransaction={slot:200,transaction:[wire,"base64"],meta:{err:false}};
 assert.equal((await f.coordinator.confirm(job.jobId,payer)).state,"unknown");
 const error={InstructionError:[0,{Custom:6000}]};
 f.responses.getSignatureStatuses.value[0].err=error;
 f.responses.getTransaction.meta.err=error;
 assert.equal((await f.coordinator.confirm(job.jobId,payer)).state,"failed");
});

test("job-generation revocation during final approval IO prevents human signing authorization",async t=>{
 const f=await controlledAttestation(t),job=await f.coordinator.dispatch(f.input,f.student,()=>{});await f.coordinator.drain();
 const original=f.actions.configuration.bind(f.actions);let count=0;f.actions.configuration=async()=>{const result=await original();if(++count===3){const j=f.store.jobs.getJob(job.jobId)!;f.store.jobRecovery.interruptJob(j.jobId,j.identity,j.revision,"operator_fixture");}return result;};
 await assert.rejects(f.coordinator.authorize(job.jobId,f.verifier,()=>{}));assert.equal(f.sends(),0);
});

test("approved artifact digest cannot name different local/deployed bytes",async t=>{
 const f=fixture(t),preview=await f.reviewer.review(f.input,f.wallet.publicKey.toBase58()),action={id:"artifact-mismatch",operationKey:preview.operationKey!,scopeDigest:preview.scopeDigest!,wallet:preview.wallet,additionalSigner:null,expiresAt:new Date(Date.now()+60000).toISOString(),maxFeeLamports:5000,maxRentLamports:1000000},actions=new ControlledActions(f.store,async()=>approvalConfiguration(action),async()=>{throw Error("no send");});
 const reviewer=new WalletExecutionReviewer(f.rpc,async()=>f.artifact,()=>Date.now(),actions),review=await reviewer.review(f.input,preview.wallet);assert.equal(review.liveExecution,false);assert(review.blockers.includes("approval_artifact_mismatch"));
});
test("settlement reward cannot change behind an unchanged instruction under its original scope digest",async t=>{
 const f=settlementFixture(t,7n),review=await f.reviewer.review(f.input,f.wallet.publicKey.toBase58());f.m.writeBigUInt64LE(12n,240);f.accounts.set(f.b.milestone,f.wrap(PROGRAM_ID,f.m));await assert.rejects(f.reviewer.revalidate(review.reviewId!,review.wallet),{code:"transaction_changed"});
});
test("read-only recovery after a lost response reuses the original exact wire without another send",async t=>{
 const f=await controlledWallet(t);await f.reviewer.authorize(f.review.reviewId!,f.review.wallet);await f.reviewer.submission(f.review.reviewId!,f.review.wallet,f.wire);f.accounts.set(f.b.internship,f.originalParent);f.responses.getSignatureStatuses={context:{slot:200},value:[{slot:200,confirmationStatus:"confirmed",err:null}]};f.responses.getTransaction={slot:200,meta:{err:null},transaction:[f.wire,"base64"]};
 const recovered=await f.reviewer.recover(f.input,f.review.wallet);assert.equal(recovered.confirmation?.state,"confirmed");assert.equal(f.sends(),1);await assert.rejects(f.reviewer.recover(f.input,f.student.publicKey.toBase58()));f.responses.getSignatureStatuses=new Error("outage");assert.equal((await f.reviewer.confirm(f.review.reviewId!,f.review.wallet,f.wire)).state,"confirmed");
});
test("revoked signer session during partial validation cannot leave a usable signature",async t=>{
 const f=await controlledAttestation(t),job=await f.coordinator.dispatch(f.input,f.student,()=>{});await f.coordinator.drain();const review=await f.coordinator.review(job.jobId,f.verifier);await f.coordinator.authorize(job.jobId,f.verifier,()=>{});
 const alphabet="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";let n=0n;for(const c of review.messageBase58)n=n*58n+BigInt(alphabet.indexOf(c));let h=n.toString(16);if(h.length%2)h="0"+h;const bytes=Buffer.from(h,"hex"),tx=Transaction.populate(Message.from(bytes));tx.partialSign(f.verifierKeypair);
 await assert.rejects(f.coordinator.validate(job.jobId,f.verifier,tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString("base64"),()=>{throw Error("session revoked");}));assert.equal((await f.coordinator.review(job.jobId,f.verifier)).signatureCount,0);assert.equal(f.sends(),0);
});

function expirePreviousLease(f:ReturnType<typeof fixture>){
 const original=f.rpc.call.bind(f.rpc);
 f.rpc.call=async(method,params=[],signal)=>{
  if((params[0] as any)?.commitment==="finalized" && method==="getBlockHeight")return 501;
  if((params[1] as any)?.commitment==="finalized" && method==="isBlockhashValid")return {context:{slot:300},value:false};
  return original(method,params,signal);
 };
 f.responses.getLatestBlockhash.value.blockhash=new PublicKey(Buffer.alloc(32,8)).toBase58();
 f.responses.getLatestBlockhash.value.lastValidBlockHeight=800;
}
for(const stopped of ["wallet rejection","approval expiry","browser interruption","signed and not submitted"] as const)test("operator reopens a proven app-unsent operation after "+stopped,async t=>{
 const f=await controlledWallet(t),id=f.review.reviewId!,wallet=f.review.wallet;
 await f.reviewer.authorize(id,wallet);
 if(stopped==="signed and not submitted")await f.reviewer.acceptSignature(id,wallet,f.wire);
 assert.equal(f.store.applicationTransactions.get(id)?.state,stopped==="signed and not submitted"?"signed":"signing_reserved");
 if(stopped==="approval expiry")f.setApproval({...f.action,expiresAt:new Date(0).toISOString()});
 const reopened=new LifecycleStore(join(f.dir,"ledger.sqlite"));t.after(()=>reopened.close());
 assert.equal(reopened.applicationTransactions.get(id)?.sendReserved,false);
 const restart=new WalletExecutionReviewer(f.rpc,async()=>f.artifact,()=>Date.now(),f.actions);
 assert.equal((await restart.review(f.input,wallet)).liveExecution,false);
 f.setApproval({...f.action,id:"replacement",reopensAttempt:id});
 const stillLive=await restart.review(f.input,wallet);
 await assert.rejects(restart.authorize(stillLive.reviewId!,wallet),{code:"previous_message_still_live"});
 expirePreviousLease(f);
 const fresh=await restart.review(f.input,wallet);assert.equal(fresh.liveExecution,true);
 await restart.authorize(fresh.reviewId!,wallet);
 assert.equal(reopened.applicationTransactions.getForOperation(f.action.operationKey)?.id,fresh.reviewId);
 assert.equal(reopened.applicationTransactions.get(id)?.sendReserved,false);
 await assert.rejects(f.reviewer.submission(id,wallet,f.wire));assert.equal(f.sends(),0);
 const tx=Transaction.populate(Message.from(Buffer.from(fresh.messageBase64!,"base64")));tx.sign(f.wallet);
 const wire=tx.serialize().toString("base64");
 assert.equal((await restart.submission(fresh.reviewId!,wallet,wire)).state,"submitted");
 await assert.rejects(restart.submission(fresh.reviewId!,wallet,wire));assert.equal(f.sends(),1);
});
test("reopening an uncertain send is refused even when finalized expiry is proven",async t=>{
 const f=await controlledWallet(t,"timeout"),id=f.review.reviewId!,wallet=f.review.wallet;
 await f.reviewer.authorize(id,wallet);assert.equal((await f.reviewer.submission(id,wallet,f.wire)).state,"unknown");
 expirePreviousLease(f);f.setApproval({...f.action,id:"replacement",reopensAttempt:id});
 const fresh=await f.reviewer.review(f.input,wallet);
 assert.equal(fresh.liveExecution,false);await assert.rejects(f.reviewer.authorize(fresh.reviewId!,wallet),{code:"application_attempt_not_reopenable"});
 assert.equal(f.store.applicationTransactions.getForOperation(f.action.operationKey)?.id,id);assert.equal(f.sends(),1);
});
test("ordinary authorization rejects approval replacement during async account checks",async t=>{
 const f=await controlledWallet(t);const original=f.rpc.call.bind(f.rpc);
 let changed=false;f.rpc.call=async(method,params=[],signal)=>{
  if(!changed&&method==="getFeeForMessage"){changed=true;f.setApproval({...f.action,id:"replacement"});}
  return original(method,params,signal);
 };
 await assert.rejects(f.reviewer.authorize(f.review.reviewId!,f.review.wallet),{code:"approval_replaced"});
 assert.equal(f.store.applicationTransactions.get(f.review.reviewId!),undefined);assert.equal(f.sends(),0);
});
test("expired operator approval after admission never runs the trusted verifier",async t=>{
 const f=await controlledAttestation(t);
 const coordinator=f.makeCoordinator(async()=>{f.setApproval({...f.action,expiresAt:new Date(0).toISOString()});return TOKEN;});
 await assert.rejects(coordinator.dispatch(f.input,f.student,()=>{}));await coordinator.drain();assert.equal(f.runs(),0);assert.equal(f.sends(),0);
});
test("credential admission deadline refuses a hung loader and permits a later healthy request",async()=>{
 const binding={milestone:"fixture",student:"fixture",repositoryId:"1",contributorId:"2",commit:"fixture"};
 await assert.rejects(admitContributorWithDeadline(()=>new Promise(()=>{}),binding,10),{code:"verification_admission_unavailable"});
 assert.equal(await admitContributorWithDeadline(async()=>TOKEN,binding,10),TOKEN);
});
test("attestation restart after verification requires explicit new approval and reruns trusted verification",async t=>{
 const f=await controlledAttestation(t),initial=await f.coordinator.dispatch(f.input,f.student,()=>{});
 await f.coordinator.drain();assert.equal(f.runs(),1);f.expire();
 const restart=f.makeCoordinator();
 await assert.rejects(restart.review(initial.jobId,f.verifier));
 assert.equal((await restart.dispatch(f.input,f.student,()=>{})).generation,initial.generation);assert.equal(f.runs(),1);
 f.setApproval({...f.action,id:"renewed-attestation",reopensJob:initial.jobId+":"+initial.generation});
 const fresh=await restart.dispatch(f.input,f.student,()=>{});await restart.drain();
 assert.equal(fresh.jobId,initial.jobId);assert.equal(fresh.generation,initial.generation!+1);assert.equal(f.runs(),2);
 assert.equal((await restart.review(fresh.jobId,f.verifier)).signatureCount,0);
 await assert.rejects(f.coordinator.authorize(initial.jobId,f.verifier,()=>{}));assert.equal(f.sends(),0);
 assert.deepEqual(f.store.jobs.getJobHistory(initial.jobId).filter(e=>e.event[0]==="controlled_claimed").map(e=>e.event[2]),[f.action.id,"renewed-attestation"]);
});
test("only valid Solana error evidence can classify an RPC response as failed",()=>{
 for(const value of [false,true,0,[],{},undefined,"arbitrary",{InstructionError:[-1,"Custom"]},{InstructionError:[0,false]}])
  assert.equal(validTransactionError(value),false);
 for(const value of [null,"BlockhashNotFound",{InstructionError:[0,{Custom:6000}]}])
  assert.equal(validTransactionError(value),true);
});

test("an interrupted attestation preparation is fenced by a new durable generation",async t=>{
 const f=await controlledAttestation(t);let entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(r=>entered=r),pending=new Promise<void>(r=>release=r);
 f.holdRunner(async()=>{if(f.runs()===1){entered();await pending;}});
 const initial=await f.coordinator.dispatch(f.input,f.student,()=>{});await started;
 assert.equal(f.store.jobs.getJob(initial.jobId)?.state,"verification_running");
 const restart=f.makeCoordinator();
 f.setApproval({...f.action,id:"recover-preparation",reopensJob:initial.jobId+":"+initial.generation});
 try{
  const successor=await restart.dispatch(f.input,f.student,()=>{});await restart.drain();
  assert.equal(successor.generation,initial.generation!+1);
 }finally{release();await f.coordinator.drain();}
 assert.equal(f.runs(),2);await assert.rejects(f.coordinator.review(initial.jobId,f.verifier));
 assert.equal((await restart.review(initial.jobId,f.verifier)).signatureCount,0);assert.equal(f.sends(),0);
});
