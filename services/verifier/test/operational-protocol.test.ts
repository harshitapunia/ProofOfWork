import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { protocolFixture,fixture } from "./protocol-helpers.js";
import { validateAdmission,validateRoleRequest,validateSigningOutcome,validateSubmission,validateObservation,
 classifyObservation,protocolDataDigest } from "../src/operational-protocol.js";
const hash=(v:Uint8Array)=>createHash("sha256").update(v).digest("hex");
const admission=(x=protocolFixture(),v:unknown=x.admission)=>validateAdmission(v,x.anchor,x.snapshot);
const submit=(x=protocolFixture(),v:unknown=x.submission)=>validateSubmission(v,x.admission,x.roles,x.outcomes,x.anchor,x.snapshot);
test("deterministic contracts are frozen DATA ONLY, not authenticated capabilities",()=>{
 const x=protocolFixture(),values=[admission(x),validateRoleRequest(x.roles[0],x.admission,x.anchor,x.snapshot),
 validateSigningOutcome(x.outcomes[0],x.roles[0],x.admission,x.anchor,x.snapshot),submit(x),
 validateObservation(x.observation,x.submission,x.admission,x.anchor,x.snapshot)];
 for(const v of values){assert.equal(v.kind,"validated_offline_contract_data");assert.equal(v.operationalAuthorization,false);
 assert.equal(v.authenticated,false);assert.equal(v.retryAuthorized,false);assert.equal(v.reservationReleaseAuthorized,false);
 assert.ok(Object.isFrozen(v)&&Object.isFrozen(v.data));}
 assert.equal(classifyObservation(x.observation,x.submission,x.admission,x.anchor,x.snapshot).uncertaintyClearAuthorized,false);
});
for(const patch of [
 {version:"v2"},{kind:"authorization"},{operationKey:"other"},{jobIdentity:"aa".repeat(32)},{intentIdentity:"aa".repeat(32)},
 {jobId:"bad"},{intentId:0},{admissionId:"00000000-0000-0000-0000-000000000000"},{messageDigest:"00".repeat(32)},
 {messageDigest:"AB".repeat(32)},{messageDigest:123},{policyVersion:"other"},{feePayer:fixture.bindings.verifier},
 {operatorApprovalRef:"forged"},{deadlineUnixMs:"2001"},{epoch:"2"},{blockhash:"bad"},{lastValidBlockHeight:"201"},
 {preparedAtBlockHeight:"101"},{snapshotDigest:"aa".repeat(32)},{approved:true},{authenticated:true},{verified:true},{mode:"live"},
])test("admission rejects "+JSON.stringify(patch),()=>{const x=protocolFixture();assert.throws(()=>admission(x,{...x.admission,...patch}));});
for(const field of ["programId","genesisHash","cluster","milestone","student","verifier","requirementsHash","evidenceHash","commit"] as const)
 test("binding rejects "+field,()=>{const x=protocolFixture();assert.throws(()=>admission(x,{...x.admission,bindings:{...x.admission.bindings,[field]:"bad"}}));});
for(const patch of [{nowUnixMs:"2000"},{nowUnixMs:"999"},{nowUnixMs:1500},{nowUnixMs:"01500"},{nowUnixMs:"18446744073709551616"},
 {blockHeight:"201"},{blockHeight:"99"},{currentEpoch:"2"},{currentEpoch:1},{nowUnixMs:"1e3"}])
 test("freshness rejects "+JSON.stringify(patch),()=>{const x=protocolFixture();assert.throws(()=>validateAdmission(x.admission,x.anchor,{...x.snapshot,...patch}));});
test("pure validation cannot prove actual approval authenticity, current time or replay exclusion",()=>{
 const x=protocolFixture();assert.deepEqual(admission(x),admission(x));
 x.admission={...x.admission,operatorApprovalRef:"caller_controls_both"};x.anchor={...x.anchor,operatorApprovalRef:"caller_controls_both"};
 assert.equal(admission(x).authenticated,false);
 const consumed=new Set<string>(); // Test expectation oracle only, NOT real replay protection.
 const admitFixture=()=>{assert.ok(!consumed.has(x.admission.admissionId));consumed.add(x.admission.admissionId);};
 admitFixture();assert.throws(admitFixture);
});
test("changed message fails even with its new digest supplied in both data and anchor",()=>{
 const x=protocolFixture(),bytes=Buffer.from(x.admission.messageBase64,"base64");bytes[bytes.length-1]=bytes[bytes.length-1]!^1;
 x.admission={...x.admission,messageBase64:bytes.toString("base64"),messageDigest:hash(bytes)};x.anchor={...x.anchor,messageDigest:hash(bytes)};
 assert.throws(()=>admission(x));
});
test("canonical digests and contracts are independent of object insertion order",()=>{
 const x=protocolFixture(),reordered=Object.fromEntries(Object.entries(x.admission).reverse());
 assert.equal(protocolDataDigest(reordered),protocolDataDigest(x.admission));assert.deepEqual(admission(x,reordered),admission(x));
});
test("accessors, symbols, sparse arrays, proxies and toJSON reject without getters",()=>{
 const x=protocolFixture();let reads=0;const v=Object.defineProperty({...x.admission},"messageDigest",{enumerable:true,get(){reads++;return "";}});
 for(const a of [v,{...x.admission,[Symbol()]:1},{...x.admission,toJSON(){return {};}},new Proxy(x.admission,{ownKeys(){throw Error();}})])
 assert.throws(()=>admission(x,a));assert.equal(reads,0);
 const sources=["fixture_provider"];Object.defineProperty(sources,"0",{get(){reads++;return "fixture_provider";}});
 assert.throws(()=>validateAdmission(x.admission,x.anchor,{...x.snapshot,sourceIds:sources}));assert.equal(reads,0);
 assert.throws(()=>protocolDataDigest(new Array(1)));assert.throws(()=>protocolDataDigest({x:NaN}));
});
for(const i of [0,1])for(const patch of [{role:"bad"},{publicKey:"bad"},{messageDigest:"aa".repeat(32)},{messageBase64:"AA=="},
 {epoch:"2"},{deadlineUnixMs:"2001"},{roleApprovalRef:"forged"},{admissionDigest:"aa".repeat(32)},{authenticated:true}])
 test("role "+i+" rejects "+JSON.stringify(patch),()=>{const x=protocolFixture();assert.throws(()=>validateRoleRequest({...x.roles[i],...patch},x.admission,x.anchor,x.snapshot));});
test("swapped roles, key identities and signing evidence fail",()=>{
 const x=protocolFixture();assert.throws(()=>validateRoleRequest({...x.roles[0],role:"fee_payer"},x.admission,x.anchor,x.snapshot));
 assert.throws(()=>validateRoleRequest({...x.roles[1],publicKey:x.anchor.bindings.verifier},x.admission,x.anchor,x.snapshot));
 assert.throws(()=>validateSigningOutcome(x.outcomes[1],x.roles[0],x.admission,x.anchor,x.snapshot));
 assert.throws(()=>validateSubmission(x.submission,x.admission,[x.roles[1],x.roles[0]],x.outcomes,x.anchor,x.snapshot));
});
test("fixture provenance pins original helper and protocol code has no transport/credential/signing calls",()=>{
 assert.equal(hash(readFileSync(new URL("../../test/execution-helpers.ts",import.meta.url))),fixture.provenance.helperSha256);
 const s=readFileSync(new URL("../../src/operational-protocol.ts",import.meta.url),"utf8");
 assert.doesNotMatch(s,/sendRawTransaction\s*\(|sendTransaction\s*\(|fetch\s*\(|process\.env|readFile|generateKeyPair|privateKey|\bsign\s*\(/);
});

test("explicit caller margin is lossless, positive and checked at the exact boundary",()=>{
 const x=protocolFixture();
 assert.equal(validateAdmission(x.admission,x.anchor,{...x.snapshot,blockHeight:"190"}).operationalAuthorization,false);
 for(const patch of [{blockHeight:"191"},{blockHeight:"200"},{minRemainingBlockHeights:"0"},{minRemainingBlockHeights:10}])
 assert.throws(()=>validateAdmission(x.admission,x.anchor,{...x.snapshot,...patch}));
});

for(const value of [new Date(0),Object.assign(Object.create({inherited:true}),{a:1}),{x:undefined},{x:()=>1}])
 test("canonical data serialization rejects non-JSON or inherited-prototype value "+Object.prototype.toString.call(value),()=>{
 assert.throws(()=>protocolDataDigest(value));
});

test("public-key parsing is bounded before decoding malformed large inputs",()=>{
 const x=protocolFixture();
 for(const value of ["1".repeat(10000),"short",0,null])
 assert.throws(()=>validateAdmission(x.admission,{...x.anchor,feePayer:value},x.snapshot));
});
