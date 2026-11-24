import {test} from "node:test";
import assert from "node:assert/strict";
import {PublicKey} from "@solana/web3.js";
import {deriveVault,deriveVaultAuthority,deriveCompletion,DEMO_MINT,TOKEN_PROGRAM_ID,SETTLEMENT_DEVNET_GENESIS} from "@proofwork/finance-client";
import {WorkflowStateReader} from "../src/workflow-state.js";
import {ReadOnlyWalletRpc} from "../src/devnet-wallet-review.js";
import {fixture} from "./helpers.js";
import {sha256} from "../src/commitments.js";
const version={apiVersion:"proofwork-application-api-v1",cluster:"devnet"};
function setup(status=3){
 const f=fixture(),sponsor=new PublicKey(f.i.subarray(8,40)).toBase58();
 const target={...version,sponsor,internshipId:"1",milestoneId:"1"};
 const a=(data:Buffer,owner:string="J2FkqDuuuHT14gxjVMhSryrX3Bs4Knct45NMLA79dGdZ")=>({owner,executable:false,data:[data.toString("base64"),"base64"]});
 const accounts=new Map<string,any>();for(const [key,b] of f.accounts)accounts.set(key,a(b));
 new PublicKey(DEMO_MINT).toBuffer().copy(f.m,136);f.m[274]=deriveVault(f.milestone)[1];f.m[275]=deriveVaultAuthority(f.milestone)[1];f.m[272]=status;
 if(status<2)f.m.fill(0,72,104);
 if(status<3||status===6){f.m.fill(0,168,200);accounts.delete(f.submission.toBase58());}
 if(status===4||status===5)f.m.writeBigInt64LE(170n,264);
 const vault=Buffer.alloc(165);new PublicKey(DEMO_MINT).toBuffer().copy(vault);deriveVaultAuthority(f.milestone)[0].toBuffer().copy(vault,32);vault.writeBigUInt64LE(10n,64);vault[108]=1;
 if(status>0&&status<5)accounts.set(deriveVault(f.milestone)[0].toBase58(),a(vault,TOKEN_PROGRAM_ID));
 if(status===5){const completion=Buffer.alloc(249);sha256(Buffer.from("account:CompletionRecord")).copy(completion,0,0,8);
  for(const [offset,key] of [[8,f.milestone],[40,new PublicKey(f.request.student)],[72,new PublicKey(sponsor)],[104,f.verifier],[136,f.submission]] as const)key.toBuffer().copy(completion,offset);
  f.requirements.copy(completion,168);f.evidence.copy(completion,200);completion.writeBigInt64LE(170n,232);completion.writeBigInt64LE(180n,240);completion[248]=deriveCompletion(f.milestone)[1];accounts.set(deriveCompletion(f.milestone)[0].toBase58(),a(completion));}
 accounts.set(f.milestone.toBase58(),a(f.m));
 const calls:string[]=[];const reader=new WorkflowStateReader(new ReadOnlyWalletRpc(async(_url,init)=>{const q=JSON.parse(String(init?.body));calls.push(q.method);assert(["getGenesisHash","getMultipleAccounts"].includes(q.method));
  return Response.json({jsonrpc:"2.0",id:q.id,result:q.method==="getGenesisHash"?SETTLEMENT_DEVNET_GENESIS:{context:{slot:200},value:q.params[0].map((k:string)=>accounts.get(k)??null)}});
 }),"offline_fixture");return {...f,target,sponsor,reader,accounts,calls,vault};
}
for(const [index,status] of ["Created","Funded","Assigned","Submitted","Verified","Settled","Refunded"].entries())test("actual decoded workflow observation: "+status,async()=>{
 const f=setup(index),before=JSON.stringify([...f.accounts]);const v=await f.reader.read(f.target,f.sponsor);
 assert.equal(v.status,status);assert.equal(v.provenance,"offline_fixture");assert.equal(v.persisted,false);assert.equal(v.rewardPayment,"not_established");assert.equal(v.vaultClosed,index===5||index===6?true:index===0?null:false);
 assert.equal(v.verification,index===4||index===5?"attestation_observed":"not_observed");assert.equal(JSON.stringify([...f.accounts]),before);
});
test("only recorded sponsor/student can observe an existing milestone; proposal role does not authorize",async()=>{
 const f=setup();assert.equal((await f.reader.read(f.target,f.request.student)).status,"Submitted");
 await assert.rejects(f.reader.read(f.target,f.verifier.toBase58()),/resource_not_found/);
 await assert.rejects(f.reader.read({...f.target,student:f.verifier.toBase58()},f.request.student),/invalid_request/);
});
test("explicit collision check reports absence without reserving IDs or inventing success",async()=>{
 const f=setup();f.accounts.clear();const v=await f.reader.read(f.target,f.sponsor);assert.equal(v.status,null);assert.equal(v.internshipExists,false);assert.equal(v.milestoneExists,false);
 await assert.rejects(f.reader.read(f.target,f.request.student),/resource_not_found/);
});
test("private verifier handoff reuses exact request and commitments, including after deadline",async()=>{
 const f=setup();const v=await f.reader.handoff({...f.target,evidence:f.request},f.request.student);
 assert.deepEqual(v.request,f.request);assert.equal(v.dispatch,"unavailable");assert.equal(v.authorization,"not_granted");assert.equal(v.persisted,false);
 for(const evidence of [{...f.request,nonce:"aa".repeat(32)},{...f.request,repositoryId:"9"},{...f.request,owner:"https://untrusted.invalid"},{...f.request,githubToken:"must-not-be-accepted"}])await assert.rejects(f.reader.handoff({...f.target,evidence},f.request.student));
 await assert.rejects(f.reader.handoff({...f.target,evidence:f.request},f.sponsor),/verification_not_available/);
});
for(const kind of ["vault","submission","parent","completion"])test("corrupt chain "+kind+" never becomes workflow success",async()=>{
 const f=setup();if(kind==="vault")f.accounts.delete(deriveVault(f.milestone)[0].toBase58());if(kind==="submission"){f.s[72]=f.s[72]!^1;f.accounts.set(f.submission.toBase58(),{owner:"J2FkqDuuuHT14gxjVMhSryrX3Bs4Knct45NMLA79dGdZ",executable:false,data:[f.s.toString("base64"),"base64"]});}
 if(kind==="parent")f.accounts.delete(f.internship.toBase58());if(kind==="completion")f.accounts.set(deriveCompletion(f.milestone)[0].toBase58(),{});
 // Submission commitment mutation is a valid new observation but rejects the old private preimage.
 if(kind==="submission")await assert.rejects(f.reader.handoff({...f.target,evidence:f.request},f.request.student));else await assert.rejects(f.reader.read(f.target,f.sponsor));
});

test("prefunded empty submission/completion PDAs do not fabricate submission or block valid observation",async()=>{
 const f=setup(2);const empty={owner:PublicKey.default.toBase58(),executable:false,data:["","base64"],lamports:1};
 f.accounts.set(f.submission.toBase58(),empty);f.accounts.set(deriveCompletion(f.milestone)[0].toBase58(),empty);
 const v=await f.reader.read(f.target,f.request.student);assert.equal(v.status,"Assigned");assert.equal(v.evidenceHash,null);assert.equal(v.completion,null);
});

test("prefunded empty internship and milestone PDAs are absent, not initialized",async()=>{
 const empty={owner:PublicKey.default.toBase58(),executable:false,data:["","base64"],lamports:1};
 for(const parentExists of [false,true]){
  const f=setup(),parent=f.accounts.get(f.internship.toBase58());f.accounts.clear();
  f.accounts.set(f.internship.toBase58(),parentExists?parent:empty);f.accounts.set(f.milestone.toBase58(),empty);
  const before=JSON.stringify([...f.accounts]),v=await f.reader.read(f.target,f.sponsor);
  assert.equal(v.internshipExists,parentExists);assert.equal(v.milestoneExists,false);assert.equal(v.status,null);assert.equal(v.persisted,false);
  assert.equal(JSON.stringify([...f.accounts]),before);
  await assert.rejects(f.reader.read(f.target,f.request.student),{message:"resource_not_found",status:404});
 }
});
test("absence checks still reject malformed initialized parents with a mapped chain error",async()=>{
 const f=setup();f.accounts.clear();f.accounts.set(f.internship.toBase58(),{owner:TOKEN_PROGRAM_ID,executable:false,data:["","base64"]});
 await assert.rejects(f.reader.read(f.target,f.sponsor),{message:"chain_state_invalid",status:503});
});
test("prefunded milestone does not hide initialized children or an invalid account owner",async()=>{
 const f=setup(),empty={owner:PublicKey.default.toBase58(),executable:false,data:["","base64"],lamports:1};
 f.accounts.set(f.milestone.toBase58(),empty);
 await assert.rejects(f.reader.read(f.target,f.sponsor),{message:"chain_state_invalid",status:503});
 f.accounts.clear();f.accounts.set(f.milestone.toBase58(),{...empty,owner:TOKEN_PROGRAM_ID});
 await assert.rejects(f.reader.read(f.target,f.sponsor),{message:"chain_state_invalid",status:503});
});
