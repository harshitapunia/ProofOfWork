import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PublicKey, SystemProgram, SystemInstruction, type AccountInfo } from "@solana/web3.js";
import { PROGRAM_ID, DEMO_MINT, TOKEN_PROGRAM_ID, FinanceClientError, SETTLEMENT_DEVNET_RPC,
  SETTLEMENT_DEVNET_GENESIS, deriveInternship, deriveMilestone, deriveVault, deriveVaultAuthority,
  deriveSubmission, deriveCompletion, deriveStudentAta, deriveSponsorAta, deriveSponsorFallbackDestination,
  settleMilestoneInstruction, prepareSettlementTransaction, type PrepareSettlementInput, type SettlementReadRpc } from "../src/index.js";
function pub(tag:number): PublicKey {
  for(let n=tag;n<256;n++){const k=new PublicKey(new Uint8Array(32).fill(n));if(PublicKey.isOnCurve(k.toBytes()))return k;}
  throw new Error("no public fixture");
}
const owner=pub(1),student=pub(70),caller=pub(210),verifier=pub(140);
const ai=(data:Buffer,program:PublicKey):AccountInfo<Buffer>=>({data,owner:program,executable:false,lamports:1_000_000_000,rentEpoch:0});
function token(authority:PublicKey):AccountInfo<Buffer>{
 const d=Buffer.alloc(165);new PublicKey(DEMO_MINT).toBuffer().copy(d);authority.toBuffer().copy(d,32);d[108]=1;return ai(d,new PublicKey(TOKEN_PROGRAM_ID));
}
function data(name:string,size:number){const d=Buffer.alloc(size);createHash("sha256").update("account:"+name).digest().copy(d,0,0,8);return d;}
function fixture(){
 const input:PrepareSettlementInput={sponsor:owner,student,caller,internshipId:1n,milestoneId:2n,fallbackSeed:"settlement_1"};
 const [i]=deriveInternship(owner,1n),[m]=deriveMilestone(i,2n),[s]=deriveSubmission(m),[c]=deriveCompletion(m),[v]=deriveVault(m);
 const canonical=deriveSponsorAta(owner),sa=deriveStudentAta(student),values=new Map<string,AccountInfo<Buffer>|null>();
 const put=(k:PublicKey,a:AccountInfo<Buffer>|null)=>values.set(k.toBase58(),a);
 const id=data("Internship",49);owner.toBuffer().copy(id,8);id.writeBigUInt64LE(1n,40);id[48]=deriveInternship(owner,1n)[1];put(i,ai(id,new PublicKey(PROGRAM_ID)));
 const md=data("Milestone",276);
 for(const [offset,k] of [[8,i],[40,owner],[72,student],[104,verifier],[136,new PublicKey(DEMO_MINT)],[168,s]] as const)k.toBuffer().copy(md,offset);
 md.fill(5,200,232);md.writeBigUInt64LE(2n,232);md.writeBigUInt64LE(100n,240);md.writeBigInt64LE(200n,248);md.writeBigInt64LE(300n,256);md.writeBigInt64LE(400n,264);
 md[272]=4;md[273]=deriveMilestone(i,2n)[1];md[274]=deriveVault(m)[1];md[275]=deriveVaultAuthority(m)[1];put(m,ai(md,new PublicKey(PROGRAM_ID)));
 const sd=data("Submission",113);m.toBuffer().copy(sd,8);student.toBuffer().copy(sd,40);sd.fill(9,72,104);sd.writeBigInt64LE(299n,104);sd[112]=deriveSubmission(m)[1];put(s,ai(sd,new PublicKey(PROGRAM_ID)));
 const mint=Buffer.alloc(82);mint[44]=6;mint[45]=1;put(new PublicKey(DEMO_MINT),ai(mint,new PublicKey(TOKEN_PROGRAM_ID)));
 const vault=token(deriveVaultAuthority(m)[0]);vault.data.writeBigUInt64LE(100n,64);put(v,vault);put(sa,token(student));put(canonical,token(owner));put(caller,ai(Buffer.alloc(0),SystemProgram.programId));
 const calls:string[]=[];
 const rpc:SettlementReadRpc={rpcEndpoint:SETTLEMENT_DEVNET_RPC,
  async getGenesisHash(){calls.push("genesis");return SETTLEMENT_DEVNET_GENESIS;},
  async getMultipleAccountsInfo(keys){calls.push("accounts");return keys.map(k=>{const a=values.get(k.toBase58());return a?{...a,data:Buffer.from(a.data)}:null;});},
  async getMinimumBalanceForRentExemption(size){assert.equal(size,165);calls.push("rent");return 2_039_280;}};
 return {input,rpc,values,put,calls,i,m,s,c,v,canonical,sa};
}
const reason=(code:string)=>(e:unknown)=>e instanceof FinanceClientError&&e.code===code;
function unsigned(plan:Awaited<ReturnType<typeof prepareSettlementTransaction>>){
 assert.equal(plan.transaction.recentBlockhash,undefined);
 // Synthetic test-only blockhash; never supplied by the production builder.
 plan.transaction.recentBlockhash=PublicKey.default.toBase58();
 const msg=plan.transaction.compileMessage();assert.equal(msg.header.numRequiredSignatures,1);assert.equal(msg.accountKeys[0]!.toBase58(),caller.toBase58());
 assert.ok(plan.transaction.signatures.every(s=>s.signature===null));
 assert.ok(plan.transaction.serialize({requireAllSignatures:false,verifySignatures:false}).length<=1232);
}
test("canonical preference and unsigned caller-only transaction",async()=>{
 const f=fixture();const plan=await prepareSettlementTransaction(f.input,f.rpc);
 assert.equal(plan.destinationKind,"canonical");assert.equal(plan.sponsorDestination.toBase58(),f.canonical.toBase58());assert.equal(plan.transaction.instructions.length,1);unsigned(plan);
});
test("noncanonical sponsor-owned destination with unavailable canonical ATA",async()=>{
 const f=fixture(),dest=pub(230);f.put(f.canonical,null);f.put(dest,token(owner));
 const plan=await prepareSettlementTransaction({...f.input,sponsorDestination:dest},f.rpc);assert.equal(plan.destinationKind,"existing");assert.equal(plan.sponsorDestination.toBase58(),dest.toBase58());unsigned(plan);
});
test("healthy canonical takes preference over an explicit alternative",async()=>{
 const f=fixture(),dest=pub(230);f.put(dest,token(owner));const plan=await prepareSettlementTransaction({...f.input,sponsorDestination:dest},f.rpc);assert.equal(plan.sponsorDestination.toBase58(),f.canonical.toBase58());
});
for(const kind of ["missing","authority","mint","program","frozen","native","uninitialized","malformed","executable","bad-option"]){
 test("atomic fallback for invalid canonical: "+kind,async()=>{
  const f=fixture(),bad=token(owner);
  switch(kind){
   case "authority":caller.toBuffer().copy(bad.data,32);break;case "mint":caller.toBuffer().copy(bad.data);break;
   case "program":bad.owner=SystemProgram.programId;break;case "frozen":bad.data[108]=2;break;
   case "native":bad.data.writeUInt32LE(1,109);break;case "uninitialized":bad.data[108]=0;break;
   case "malformed":bad.data=Buffer.alloc(2);break;case "executable":bad.executable=true;break;case "bad-option":bad.data.writeUInt32LE(2,72);break;
  }
  f.put(f.canonical,kind==="missing"?null:bad);
  const plan=await prepareSettlementTransaction(f.input,f.rpc),ixs=plan.transaction.instructions;
  assert.equal(plan.destinationKind,"created");assert.equal(ixs.length,3);
  const create=SystemInstruction.decodeCreateWithSeed(ixs[0]!);assert.equal(create.fromPubkey.toBase58(),caller.toBase58());assert.equal(create.basePubkey.toBase58(),caller.toBase58());assert.equal(create.programId.toBase58(),TOKEN_PROGRAM_ID);assert.equal(create.space,165);
  assert.equal(create.newAccountPubkey.toBase58(),plan.sponsorDestination.toBase58());
  assert.equal(ixs[1]!.programId.toBase58(),TOKEN_PROGRAM_ID);assert.deepEqual(ixs[1]!.data,Buffer.concat([Buffer.from([18]),owner.toBuffer()]));assert.ok(ixs[1]!.keys.every(k=>!k.isSigner));
  assert.equal(ixs[2]!.keys[9]!.pubkey.toBase58(),plan.sponsorDestination.toBase58());unsigned(plan);
 });
}
for(const lamports of [1,2_039_280,3_000_000])test("prefunded fallback allocation: "+lamports,async()=>{
 const f=fixture();f.put(f.canonical,null);const dest=await deriveSponsorFallbackDestination(caller,f.input.fallbackSeed!);f.put(dest,{...ai(Buffer.alloc(0),SystemProgram.programId),lamports});
 const plan=await prepareSettlementTransaction(f.input,f.rpc),ixs=plan.transaction.instructions,top=Math.max(0,2_039_280-lamports);
 assert.equal(plan.destinationKind,"prefunded");assert.equal(ixs.length,top>0?4:3);
 if(top>0)assert.equal(SystemInstruction.decodeTransfer(ixs[0]!).lamports,BigInt(top));
 const a=SystemInstruction.decodeAllocateWithSeed(ixs[top>0?1:0]!);assert.equal(a.accountPubkey.toBase58(),dest.toBase58());assert.equal(a.basePubkey.toBase58(),caller.toBase58());assert.equal(a.programId.toBase58(),TOKEN_PROGRAM_ID);assert.equal(a.space,165);unsigned(plan);
});
for(const kind of ["initialized","foreign","allocated","executable"])test("occupied fallback never overwritten: "+kind,async()=>{
 const f=fixture();f.put(f.canonical,null);const dest=await deriveSponsorFallbackDestination(caller,f.input.fallbackSeed!);
 const bad=kind==="initialized"?token(owner):ai(Buffer.alloc(0),SystemProgram.programId);
 if(kind==="foreign")bad.owner=new PublicKey(PROGRAM_ID);if(kind==="allocated")bad.data=Buffer.alloc(1);if(kind==="executable")bad.executable=true;f.put(dest,bad);
 await assert.rejects(prepareSettlementTransaction(f.input,f.rpc),reason("fallback_address_in_use"));
});
test("deterministic selection and initialized duplicate rejection",async()=>{
 const f=fixture();f.put(f.canonical,null);const a=await prepareSettlementTransaction(f.input,f.rpc),b=await prepareSettlementTransaction(f.input,f.rpc);assert.equal(a.sponsorDestination.toBase58(),b.sponsorDestination.toBase58());
 f.put(a.sponsorDestination,token(owner));await assert.rejects(prepareSettlementTransaction(f.input,f.rpc),reason("fallback_address_in_use"));
});
test("invalid explicit destination authority rejected",async()=>{
 const f=fixture(),dest=pub(230);f.put(f.canonical,null);f.put(dest,token(caller));await assert.rejects(prepareSettlementTransaction({...f.input,sponsorDestination:dest},f.rpc),reason("invalid_destination"));
});
for(const seed of ["","x".repeat(33),"with space"])test("reject invalid seed "+seed,async()=>assert.rejects(deriveSponsorFallbackDestination(caller,seed),reason("invalid_fallback_seed")));
test("missing fallback seed and invalid caller or aliases fail closed",async()=>{
 const f=fixture();delete f.input.fallbackSeed;await prepareSettlementTransaction(f.input,f.rpc);f.put(f.canonical,null);await assert.rejects(prepareSettlementTransaction(f.input,f.rpc),reason("fallback_seed_required"));
 for(const bad of [PublicKey.default,deriveVaultAuthority(f.m)[0]])assert.throws(()=>settleMilestoneInstruction({...f.input,caller:bad}),reason("invalid_settlement_role"));
 for(const dest of [f.v,f.sa])assert.throws(()=>settleMilestoneInstruction({...f.input,sponsorDestination:dest}),reason("invalid_destination"));
 assert.throws(()=>settleMilestoneInstruction({...f.input,tokenProgram:SystemProgram.programId}),reason("incorrect_token_program"));
});
test("RPC cluster restricted and input copied before awaits",async()=>{
 const f=fixture();await assert.rejects(prepareSettlementTransaction(f.input,{...f.rpc,rpcEndpoint:"https://example.invalid"}),reason("invalid_rpc"));
 await assert.rejects(prepareSettlementTransaction(f.input,{...f.rpc,async getGenesisHash(){return "wrong";}}),reason("wrong_cluster"));
 const plan=await prepareSettlementTransaction(f.input,{...f.rpc,async getGenesisHash(){f.input.student=caller;return SETTLEMENT_DEVNET_GENESIS;}});
 assert.equal(plan.transaction.instructions[0]!.keys[8]!.pubkey.toBase58(),f.sa.toBase58());
});
for(const kind of ["parent","student","bump","status","submission","mint-freeze","mint-authority-option","vault-authority","vault-delegate","student-ata","completion"]){
 test("reject authoritative binding or state mismatch: "+kind,async()=>{
  const f=fixture(),m=f.values.get(f.m.toBase58())!;
  switch(kind){
   case "parent":caller.toBuffer().copy(m.data,8);break;case "student":caller.toBuffer().copy(m.data,72);break;case "bump":m.data[273]=(m.data[273]!+1)%256;break;case "status":m.data[272]=3;break;case "submission":caller.toBuffer().copy(m.data,168);break;
   case "mint-freeze":f.values.get(DEMO_MINT)!.data.writeUInt32LE(1,46);break;case "mint-authority-option":f.values.get(DEMO_MINT)!.data.writeUInt32LE(2,0);break;case "vault-authority":caller.toBuffer().copy(f.values.get(f.v.toBase58())!.data,32);break;case "vault-delegate":f.values.get(f.v.toBase58())!.data.writeUInt32LE(1,72);break;case "student-ata":f.put(f.sa,token(caller));break;case "completion":f.put(f.c,ai(Buffer.alloc(249),new PublicKey(PROGRAM_ID)));break;
  }await assert.rejects(prepareSettlementTransaction(f.input,f.rpc));
 });
}
interface V {caller:string;sponsor:string;student:string;internshipId:string;milestoneId:string;destination:string;submission:string;completion:string;settlement:{dataHex:string;accounts:{pubkey:string;isSigner:boolean;isWritable:boolean}[]}}
const abi=JSON.parse(readFileSync(new URL("../../test/settlement-rust-abi.json",import.meta.url),"utf8")) as {vectors:V[]};
for(const [n,v] of abi.vectors.entries())test("compiled settlement ABI vector "+n,()=>{
 const ix=settleMilestoneInstruction({caller:v.caller,sponsor:v.sponsor,student:v.student,internshipId:BigInt(v.internshipId),milestoneId:BigInt(v.milestoneId),sponsorDestination:v.destination});
 assert.equal(ix.data.toString("hex"),v.settlement.dataHex);assert.deepEqual(ix.data,createHash("sha256").update("global:settle_milestone").digest().subarray(0,8));assert.deepEqual(ix.keys.map(k=>({pubkey:k.pubkey.toBase58(),isSigner:k.isSigner,isWritable:k.isWritable})),v.settlement.accounts);
 assert.equal(ix.keys.length,13);assert.equal(ix.keys.filter(k=>k.isSigner).length,1);assert.equal(ix.keys[3]!.pubkey.toBase58(),v.submission);assert.equal(ix.keys[4]!.pubkey.toBase58(),v.completion);
});

test("RPC response cardinality fails closed",async()=>{
 const f=fixture();await assert.rejects(prepareSettlementTransaction(f.input,{...f.rpc,async getMultipleAccountsInfo(){return [];}}),reason("invalid_rpc_response"));
});
test("invalid rent observations and caller storage fail closed",async()=>{
 const f=fixture();f.put(f.canonical,null);
 await assert.rejects(prepareSettlementTransaction(f.input,{...f.rpc,async getMinimumBalanceForRentExemption(){return NaN;}}),reason("invalid_rent"));
 f.put(caller,ai(Buffer.alloc(1),SystemProgram.programId));
 await assert.rejects(prepareSettlementTransaction(f.input,f.rpc),reason("invalid_caller_account"));
});
