import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {PublicKey} from "@solana/web3.js";
import {OfflineReadOnlyObservationAdapter,validateOfflineReadPlan,reconcileOfflineReadEvidence,compareOfflineAccounts} from "../src/read-only-observation.js";
import {validateObservation,protocolDataDigest} from "../src/operational-protocol.js";
import {observationFixture,adapter,mockSource,mutateBytes,settled} from "./read-only-helpers.js";
function nonAuthorizing(r:any){
 assert.equal(r.mode,"offline_mock");assert.equal(r.rpcAuthenticated,false);assert.equal(r.onChainStateVerified,false);
 for(const k of ["operationalStateMutationAuthorized","submissionAuthorized","retryAuthorized","reservationReleaseAuthorized",
  "settlementPermission","operationalUncertaintyClearAuthorized"])assert.equal(r[k],false,k);
 assert.equal(r.signingAuthorization,"not_granted");assert.equal(r.reconciliationRequired,true);assert(Object.isFrozen(r));
}
test("complete public signed wire and raw finalized fixture match without granting live truth or authority",async()=>{
 const x=observationFixture(),calls:string[]=[];
 const r=await adapter(x,mockSource(x.bundle,calls)).observe(x.plan);
 assert.equal(r.classification,"matching_finalized_candidate");nonAuthorizing(r);assert.deepEqual(calls,["status","transaction","accounts"]);
 assert.equal(r.observations[0]!.transactionEvidenceConsistent,true);assert.equal(r.observations[0]!.rawFixtureAccountsMatch,true);
 assert.equal(r.observations[0]!.protocol!.accounts.kind,"matching_candidate");
});
for(const finality of ["processed","confirmed","finalized"] as const)test("preserves corroborated "+finality+" commitment",()=>{
 const x=observationFixture();(x.bundle.status as any).evidence.finality=finality;(x.bundle.transaction as any).commitment=finality;
 const r=x.reconcile();nonAuthorizing(r);assert.equal(r.classification,finality==="processed"?"provisional_observation":finality==="confirmed"?"confirmed_observation":"matching_finalized_candidate");
});
test("finalized execution failure remains failure and never reads accounts",async()=>{
 const x=observationFixture();Object.assign((x.bundle.status as any).evidence,{outcome:"failure",errorCode:"InstructionError"});
 Object.assign(x.bundle.transaction!,{outcome:"failure",errorCode:"InstructionError"});
 const calls:string[]=[];const r=await adapter(x,mockSource(x.bundle,calls)).observe(x.plan);
 assert.equal(r.classification,"finalized_failure");assert.deepEqual(calls,["status","transaction"]);nonAuthorizing(r);
});
for(const reason of ["rpc_timeout","null_lookup","history_missing"])test(reason+" is missing evidence, never observed failure",()=>{
 const x=observationFixture();(x.bundle.status as any).evidence={kind:"missing",reason};
 const r=x.reconcile();assert.equal(r.classification,"missing_evidence");assert.equal(r.observations[0]!.reasons[0],reason);nonAuthorizing(r);
});
for(const reason of ["null_lookup","history_missing"])test("missing transaction detail "+reason+" preserves known status without success",()=>{
 const x=observationFixture();(x.bundle as any).transaction={kind:"transaction_missing",provenance:(x.bundle.transaction as any).provenance,reason};
 const r=x.reconcile();assert.equal(r.classification,"reconciliation_required");assert.equal(r.observations[0]!.classification,"incomplete_evidence");
 assert.equal(r.observations[0]!.reasons[0],reason);nonAuthorizing(r);
});
const txMutations:[string,(x:ReturnType<typeof observationFixture>)=>void][]=[
 ["wrong signature",x=>{(x.bundle.transaction as any).transactionId="1".repeat(64);}],
 ["changed wire signature",x=>{const d=Buffer.from((x.bundle.transaction as any).wireBase64,"base64");d[5]=d[5]!^1;(x.bundle.transaction as any).wireBase64=d.toString("base64");}],
 ["wire digest",x=>{(x.bundle.transaction as any).wireDigest="af".repeat(32);}],
 ["message digest",x=>{(x.bundle.status as any).evidence.messageDigest="af".repeat(32);}],
 ["genesis context",x=>{(x.bundle.status as any).provenance.genesisHash=PublicKey.default.toBase58();}],
 ["source identity",x=>{(x.bundle.status as any).provenance.sourceId="other";}],
 ["event identity",x=>{(x.bundle.status as any).provenance.eventId="other";}],
 ["request identity",x=>{(x.bundle.transaction as any).provenance.requestId="other";}],
 ["forged authentication",x=>{(x.bundle.status as any).authenticated=true;}],
 ["partial response",x=>{delete (x.bundle.transaction as any).wireDigest;}],
 ["status context mismatch",x=>{(x.bundle.status as any).evidence.contextSlot="999";}],
 ["stale account slot",x=>{(x.bundle.accounts as any).provenance.contextSlot="119";}],
 ["stale height",x=>{(x.bundle.status as any).currentBlockHeight="90";}],
 ["noncanonical height",x=>{(x.bundle.status as any).currentBlockHeight="0150";}],
];
for(const [name,mutate] of txMutations)test("rejects "+name+" in observed evidence",()=>{
 const x=observationFixture();mutate(x);const r=x.reconcile();assert.notEqual(r.classification,"matching_finalized_candidate");nonAuthorizing(r);
});
for(const [name,field] of [["program","programId"],["milestone","milestone"],["submission","submission"],["student","student"],["verifier","verifier"]] as const)
 test("canonical protocol rejects plan changed "+name+" binding",()=>{
 const x=observationFixture();(x.plan.anchor.bindings as any)[field]=PublicKey.default.toBase58();
 assert.throws(()=>validateOfflineReadPlan(x.plan));
});
for(const field of ["messageDigest","feePayer","jobIdentity","intentIdentity"] as const)test("rejects changed expected "+field,()=>{
 const x=observationFixture();(x.plan.anchor as any)[field]=field==="feePayer"?PublicKey.default.toBase58():"aa".repeat(32);
 assert.throws(()=>validateOfflineReadPlan(x.plan));
});
const byteMutations:[string,"internship"|"milestone"|"submission",number][]=[
 ["internship sponsor","internship",8],["internship id","internship",40],["internship bump","internship",48],
 ["milestone parent","milestone",8],["sponsor","milestone",40],["student","milestone",72],["verifier","milestone",104],
 ["mint","milestone",136],["submission PDA","milestone",168],["requirements","milestone",200],["milestone id","milestone",232],
 ["milestone bump","milestone",273],["vault bump","milestone",274],["vault authority bump","milestone",275],
 ["submission parent","submission",8],["submission student","submission",40],["evidence","submission",72],["submission bump","submission",112]];
for(const [name,key,offset] of byteMutations)test("raw decoder rejects incorrect "+name,()=>{
 const x=observationFixture();mutateBytes(x.accounts,key,d=>{d[offset]=d[offset]!^1;});
 assert.equal(x.reconcile().classification,"account_state_mismatch");
});
for(const key of ["internship","milestone","submission"] as const){
 for(const kind of ["owner","executable","discriminator","length","address"] as const)test("rejects raw "+key+" "+kind,()=>{
  const x=observationFixture(),a=x.accounts[key];
  if(kind==="owner")(a.account as any).owner=PublicKey.default.toBase58();
  if(kind==="executable")(a.account as any).executable=true;
  if(kind==="discriminator")mutateBytes(x.accounts,key,d=>{d[0]=d[0]!^1;});
  if(kind==="length")(a.account!.data as any)[0]=Buffer.alloc(5).toString("base64");
  if(kind==="address")(a as any).address=PublicKey.default.toBase58();
  assert.equal(x.reconcile().classification,"account_state_mismatch");
 });
 test("missing raw "+key+" remains insufficient",()=>{
  const x=observationFixture();(x.accounts[key] as any).account=null;
  assert.equal(x.reconcile().classification,"finalized_success_candidate");assert.equal(x.reconcile().observations[0]!.rawFixtureAccountsMatch,false);
 });
}
for(const status of [0,1,2,3,6,255])test("status "+status+" cannot satisfy attestation postcondition",()=>{
 const x=observationFixture();mutateBytes(x.accounts,"milestone",d=>{d[272]=status;});assert.equal(x.reconcile().classification,"account_state_mismatch");
});
for(const [key,offset,value] of [["milestone",264,0n],["milestone",264,149n],["submission",104,0n],["submission",104,200n]] as const)
 test("rejects invalid "+key+" timestamp "+value,()=>{
 const x=observationFixture();mutateBytes(x.accounts,key,d=>d.writeBigInt64LE(value,offset));assert.equal(x.reconcile().classification,"account_state_mismatch");
});
test("later Settled fixture requires complete linked Rust-layout completion and claims no payout",()=>{
 const x=observationFixture();settled(x);const r=x.reconcile();assert.equal(r.classification,"matching_finalized_candidate");
 assert.equal((r.observations[0]!.protocol!.accounts as any).milestoneStatus,"Settled");nonAuthorizing(r);
 (x.accounts.completion as any).account=null;assert.equal(x.reconcile().classification,"finalized_success_candidate");
});
for(const offset of [0,8,40,72,104,136,168,200,232,240,248])test("completion relationship/layout corruption at "+offset+" is rejected",()=>{
 const x=observationFixture();settled(x);
 mutateBytes(x.accounts,"completion",d=>{if(offset===240)d.writeBigInt64LE(159n,offset);else d[offset]=d[offset]!^1;});
 assert.equal(x.reconcile().classification,"account_state_mismatch");
});
test("prefunded empty system completion is allowed only before settlement",()=>{
 const x=observationFixture();(x.accounts.completion as any).account={owner:PublicKey.default.toBase58(),executable:false,data:["","base64"]};
 assert.equal(x.reconcile().classification,"matching_finalized_candidate");
 (x.accounts.completion.account!.data as any)[0]="AA==";assert.equal(x.reconcile().classification,"account_state_mismatch");
});
test("missing account read never upgrades signed execution to verified state",()=>{
 const x=observationFixture();(x.bundle as any).accounts=null;const r=x.reconcile();
 assert.equal(r.classification,"finalized_success_candidate");nonAuthorizing(r);
});
test("confirmed account read cannot satisfy finalized state",()=>{
 const x=observationFixture();(x.bundle.accounts as any).commitment="confirmed";assert.equal(x.reconcile().classification,"finalized_success_candidate");
});
test("contradictory terminal detail is retained as conflict",()=>{
 const x=observationFixture();Object.assign(x.bundle.transaction!,{outcome:"failure",errorCode:"InstructionError"});
 assert.equal(x.reconcile().classification,"conflicting_evidence");
});
test("detail commitment regression requires reconciliation",()=>{
 const x=observationFixture();(x.bundle.transaction as any).commitment="confirmed";assert.equal(x.reconcile().classification,"reconciliation_required");
});
function multi(){
 const x=observationFixture();(x.plan.snapshot.sourceIds as string[]).push("provider_two");
 (x.plan.events as any).push({sourceId:"provider_two",eventId:"event_two"});
 const second=structuredClone(x.bundle);Object.assign(second,{sourceId:"provider_two",eventId:"event_two"});
 for(const key of ["status","transaction","accounts"] as const)Object.assign((second[key] as any).provenance,{sourceId:"provider_two",eventId:"event_two"});
 return {...x,second};
}
test("two matching unauthenticated sources with different context slots remain fixture candidates",()=>{
 const x=multi();for(const key of ["status","transaction","accounts"] as const)(x.second[key] as any).provenance.contextSlot="130";
 (x.second.status as any).evidence.contextSlot="130";
 const r=x.reconcile([x.bundle,x.second]);assert.equal(r.classification,"matching_finalized_candidate");nonAuthorizing(r);
});
for(const kind of ["failure","transaction_slot","account_content","unavailable","finality"] as const)test("multiple sources "+kind+" are reconciled conservatively",()=>{
 const x=multi();
 if(kind==="failure"){Object.assign((x.second.status as any).evidence,{outcome:"failure",errorCode:"InstructionError"});Object.assign(x.second.transaction!,{outcome:"failure",errorCode:"InstructionError"});}
 if(kind==="transaction_slot"){(x.second.status as any).evidence.transactionSlot="119";(x.second.transaction as any).transactionSlot="119";}
 if(kind==="account_content")mutateBytes((x.second.accounts as any).accounts,"milestone",d=>d.writeBigUInt64LE(11n,240));
 if(kind==="unavailable"){(x.second as any).status=null;(x.second as any).interruption="status_timeout";}
 if(kind==="finality"){(x.second.status as any).evidence.finality="confirmed";(x.second.transaction as any).commitment="confirmed";}
 const r=x.reconcile([x.bundle,x.second]);assert.equal(r.classification,kind==="unavailable"?"reconciliation_required":kind==="finality"?"confirmed_observation":"conflicting_evidence");nonAuthorizing(r);
});
test("configured missing source is never silently ignored",()=>{const x=multi();assert.equal(x.reconcile().classification,"reconciliation_required");});
test("duplicate bundle event cannot be counted twice",()=>{
 const x=observationFixture();assert.equal(x.reconcile([x.bundle,x.bundle]).classification,"conflicting_evidence");
});
test("historical duplicate and stale source context remain unresolved",()=>{
 const x=observationFixture();(x.plan.priorEvents as any).push({...x.plan.events[0],contextSlot:"120"});
 assert.equal(x.reconcile().classification,"conflicting_evidence");
 (x.plan.priorEvents[0] as any).eventId="older";(x.plan.priorEvents[0] as any).contextSlot="130";
 assert.equal(x.reconcile().classification,"reconciliation_required");
});
for(const stage of ["readStatus","readTransaction","readAccounts"] as const)for(const timeout of [false,true])
 test(stage+" "+(timeout?"timeout":"exception")+" preserves ambiguity and never retries",async()=>{
 const x=observationFixture(),calls:string[]=[],source=mockSource(x.bundle,calls);
 source[stage]=async()=>{calls.push(stage);if(timeout)return new Promise(()=>{});throw Error("transport_secret_should_not_escape");};
 const r=await new OfflineReadOnlyObservationAdapter([source],{get:()=>x.view},{readTimeoutMs:5}).observe(x.plan);
 assert.notEqual(r.classification,"matching_finalized_candidate");nonAuthorizing(r);
 assert.equal(calls.filter(c=>c===stage).length,1);assert(!JSON.stringify(r).includes("transport_secret"));
});
test("immutable attempt correlation rejects changed identity and revokes result on mid-read context change",async()=>{
 const x=observationFixture();let reads=0;
 const r=await adapter(x,mockSource(x.bundle),()=>({...x.view,revision:reads++?1:0})).observe(x.plan);
 assert.equal(r.classification,"reconciliation_required");assert(r.reasons.includes("execution_context_changed"));nonAuthorizing(r);
 await assert.rejects(adapter(x,mockSource(x.bundle),()=>({...x.view,identity:"aa".repeat(32)})).observe(x.plan));
});
for(const field of ["intentId","identity","jobId","jobIdentity","operationKey","feePayer","preparation"] as const)
 test("execution view cannot substitute "+field,()=>{
 const x=observationFixture(),v=structuredClone(x.view);(v.intent as any)[field]=field==="preparation"?{...v.intent.preparation,messageDigest:"aa".repeat(32)}:"mismatch";
 assert.throws(()=>reconcileOfflineReadEvidence(x.plan,[x.bundle],v,v));
});
test("strict boundary rejects authority flags, writers, network/send methods and getters",()=>{
 const x=observationFixture(),source=mockSource(x.bundle);
 for(const extra of ["authenticated","sendTransaction","sign","endpoint"])assert.throws(()=>new OfflineReadOnlyObservationAdapter([{...source,[extra]:true} as any],{get:()=>x.view},{readTimeoutMs:10}));
 assert.throws(()=>new OfflineReadOnlyObservationAdapter([source],{get:()=>x.view,write:()=>{throw Error("writer");}} as any,{readTimeoutMs:10}));
 let reads=0;const p={...x.plan};Object.defineProperty(p,"snapshot",{enumerable:true,get(){reads++;return x.plan.snapshot;}});
 assert.throws(()=>validateOfflineReadPlan(p));assert.equal(reads,0);
});
test("existing protocol DTO remains compatible and new result is not old trusted observation capability",()=>{
 const x=observationFixture(),r=x.reconcile(),dto=r.observations[0]!.protocol!;
 assert.equal(validateObservation(dto,x.plan.submission,x.plan.admission,x.plan.anchor,x.plan.snapshot).data.kind,"offline_observation_data");
 assert.equal(protocolDataDigest(dto),protocolDataDigest(structuredClone(dto)));nonAuthorizing(r);
 assert(!Object.hasOwn(r,"trusted"));assert(!Object.hasOwn(r,"capability"));
});
test("raw comparator rejects caller-decoded metadata and noncanonical base64",()=>{
 const x=observationFixture();
 assert.equal(compareOfflineAccounts(x.f.observation.accounts,x.plan.anchor,"123").kind,"mismatched_fixture");
 (x.accounts.milestone.account!.data as any)[0]+="\n";assert.equal(x.reconcile().classification,"account_state_mismatch");
});

test("unverified source provenance is preserved and cannot become authenticated",()=>{
 const x=observationFixture();
 for(const key of ["status","transaction","accounts"] as const)(x.bundle[key] as any).provenance.kind="unverified_reference";
 const r=x.reconcile();assert.equal(r.classification,"matching_finalized_candidate");
 assert.equal(r.observations[0]!.protocol!.provenance.kind,"unverified_reference");nonAuthorizing(r);
});

test("self-consistent wire digest cannot hide an invalid signature in the expected submission",()=>{
 const x=observationFixture(),wire=Buffer.from(x.plan.submission.wireBase64,"base64");wire[5]=wire[5]!^1;
 Object.assign(x.plan.submission,{wireBase64:wire.toString("base64"),wireDigest:createHash("sha256").update(wire).digest("hex")});
 assert.throws(()=>validateOfflineReadPlan(x.plan));
});
test("offline adapter performs no fetch and query preserves every expected execution/account reference",async()=>{
 const x=observationFixture(),source=mockSource(x.bundle),read=source.readStatus,original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;throw Error("network_forbidden");};
 source.readStatus=async q=>{
  assert.equal(q.attemptId,x.plan.attempt.attemptId);assert.equal(q.attemptIdentity,x.plan.attempt.identity);
  assert.equal(q.operationKey,x.plan.admission.operationKey);assert.equal(q.requestId,x.plan.requestId);
  assert.equal(q.addresses.milestone,x.plan.anchor.bindings.milestone);assert.equal(q.addresses.submission,x.plan.anchor.bindings.submission);
  assert.equal(q.addresses.internship,x.plan.anchor.bindings.internship);assert(Object.isFrozen(q.addresses));return read(q);
 };
 try{assert.equal((await adapter(x,source).observe(x.plan)).classification,"matching_finalized_candidate");assert.equal(calls,0);}
 finally{globalThis.fetch=original;}
});

test("existing v5 signed wire identity must match the expected submission when present",()=>{
 const x=observationFixture(),view={...x.view,wireDigest:x.plan.submission.wireDigest,testTransactionId:x.plan.submission.transactionId};
 assert.equal(reconcileOfflineReadEvidence(x.plan,[x.bundle],view,view).classification,"matching_finalized_candidate");
 assert.equal(reconcileOfflineReadEvidence(x.plan,[x.bundle],x.view,view).classification,"reconciliation_required");
 for(const patch of [{wireDigest:"aa".repeat(32)},{testTransactionId:"1".repeat(64)},{testTransactionId:null}]){
  const changed={...view,...patch};assert.throws(()=>reconcileOfflineReadEvidence(x.plan,[x.bundle],changed,changed));
 }
});

test("standalone raw comparison reuses canonical binding validation for program and genesis",()=>{
 const x=observationFixture();
 for(const field of ["programId","genesisHash"] as const){
  const anchor=structuredClone(x.plan.anchor);Object.assign(anchor,{bindings:{...anchor.bindings,[field]:PublicKey.default.toBase58()}});
  assert.equal(compareOfflineAccounts(x.accounts,anchor,"123").kind,"mismatched_fixture");
 }
});

test("a complete bundle cannot conceal a claimed interrupted read",()=>{
 const x=observationFixture();(x.bundle as any).interruption="status_timeout";
 const r=x.reconcile();assert.equal(r.classification,"reconciliation_required");
 assert.equal(r.observations[0]!.reasons[0],"inconsistent_read_interruption");nonAuthorizing(r);
});
