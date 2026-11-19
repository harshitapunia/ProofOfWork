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
import {ReadOnlyWalletRpc,WalletExecutionReviewer,observeDeployment,UPGRADEABLE_LOADER,type WalletOperation} from "../src/devnet-wallet-review.js";
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
 return {reviewer,rpc,accounts,originalParent,terms,workflow,wallet,sponsor,student,b,m,sub,wrap,token,vault,ata,pd,artifact,calls,responses,op,input:{workflow,operation:op},advance:(n:number)=>{now+=n;}};
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
 f.responses.getSignatureStatuses={context:{slot:200},value:[{slot:200,confirmationStatus:"confirmed",err:{InstructionError:[0,"Custom"]}}]};assert.equal((await f.reviewer.confirm(r.reviewId!,r.wallet,wire)).state,"failed");
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
 if(op==="fund_milestone"){f.m[272]=1;f.accounts.set(f.b.milestone,f.wrap(PROGRAM_ID,f.m));f.accounts.set(f.vault,f.token(deriveVaultAuthority(f.b.milestone)[0].toBase58(),10n));f.accounts.set(f.ata,f.token(f.terms.sponsor,990n));}
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
