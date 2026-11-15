import {test} from "node:test";
import assert from "node:assert/strict";
import {protocolFixture} from "./protocol-helpers.js";
import {validateObservation,classifyObservation,type Finality,type AccountEvidence} from "../src/operational-protocol.js";
const validate=(x=protocolFixture(),v:unknown=x.observation)=>validateObservation(v,x.submission,x.admission,x.anchor,x.snapshot);
const classify=(x=protocolFixture())=>classifyObservation(x.observation,x.submission,x.admission,x.anchor,x.snapshot);
for(const finality of ["processed","confirmed","finalized"] as Finality[])
 test("finality stays explicit, account claims never become authenticated: "+finality,()=>{
 const x=protocolFixture();x.observation={...x.observation,transaction:{...x.status,finality}};
 assert.equal(classify(x).classification,finality==="finalized"?"matching_finalized_claim":"provisional_claim");
 assert.equal(validate(x).authenticated,false);assert.equal(classify(x).uncertaintyClearAuthorized,false);
});
for(const reason of ["null_lookup","history_missing","rpc_timeout"] as const)
 test("missing transaction evidence retains unknown classification: "+reason,()=>{
 const x=protocolFixture();x.observation={...x.observation,transaction:{kind:"missing",reason}};
 assert.equal(classify(x).classification,"missing_evidence");assert.equal(classify(x).operationalAuthorization,false);
});
for(const kind of ["not_supplied","incomplete","mismatched"] as const)
 test("successful finalized transaction does not imply account success: "+kind,()=>{
 const x=protocolFixture();x.observation={...x.observation,accounts:{kind,reason:"fixture_bad_or_missing_accounts"}};
 assert.equal(classify(x).classification,"awaiting_account_evidence");
});
test("finalized failure remains failure even with a matching account claim",()=>{
 const x=protocolFixture();x.observation={...x.observation,transaction:{...x.status,outcome:"failure",errorCode:"InstructionError"}};
 assert.equal(classify(x).classification,"finalized_failure_claim");
});
test("conflicting provisional evidence is represented and held, never resolved into success",()=>{
 const x=protocolFixture();x.observation={...x.observation,transaction:{kind:"conflict",left:{...x.status,finality:"confirmed"},
 right:{...x.status,finality:"processed",transactionSlot:"119",outcome:"failure",errorCode:"InstructionError"}}};
 assert.equal(classify(x).classification,"conflicting_evidence");assert.equal(classify(x).uncertaintyClearAuthorized,false);
});
test("same observation or normal finality strengthening is not fabricated conflict evidence",()=>{
 const x=protocolFixture();
 for(const right of [x.status,{...x.status,finality:"confirmed"}])assert.throws(()=>validate(x,{...x.observation,transaction:{kind:"conflict",left:x.status,right}}));
});
for(const patch of [{kind:"authenticated_rpc"},{sourceId:"unknown_source"},{cluster:"wrong_cluster"},{genesisHash:"bad"},
 {authenticated:true},{contextSlot:"119"},{contextSlot:122},{contextSlot:"0122"},{eventId:"bad event"}])
 test("provenance rejects "+JSON.stringify(patch),()=>{
 const x=protocolFixture();assert.throws(()=>validate(x,{...x.observation,provenance:{...x.observation.provenance,...patch}}));
});
for(const patch of [{transactionId:"wrong"},{messageDigest:"aa".repeat(32)},{wireDigest:"aa".repeat(32)},
 {finality:"rooted"},{outcome:"success",errorCode:"Error"},{outcome:"failure",errorCode:null},
 {contextSlot:"119"},{transactionSlot:"18446744073709551616"},{observedBlockHeight:150},{verified:true}])
 test("status rejects "+JSON.stringify(patch),()=>{
 const x=protocolFixture();assert.throws(()=>validate(x,{...x.observation,transaction:{...x.status,...patch}}));
});
for(const patch of [{milestoneStatus:"Refunded"},{programId:"bad"},{milestone:"bad"},{student:"bad"},{verifier:"bad"},
 {requirementsHash:"aa".repeat(32)},{evidenceHash:"aa".repeat(32)},{verifiedAt:"99"},{contextSlot:"119"},{accountSetDigest:"bad"},
 {completionDigest:"aa".repeat(32)},{verified:true}])
 test("account candidate rejects "+JSON.stringify(patch),()=>{
 const x=protocolFixture();assert.throws(()=>validate(x,{...x.observation,accounts:{...x.observation.accounts,...patch}}));
});
test("Settled candidate requires completion digest, and stays an unauthenticated metadata claim",()=>{
 const x=protocolFixture(),a=x.observation.accounts as Extract<AccountEvidence,{kind:"matching_candidate"}>;
 assert.throws(()=>validate(x,{...x.observation,accounts:{...a,milestoneStatus:"Settled"}}));
 x.observation={...x.observation,accounts:{...a,milestoneStatus:"Settled",completionDigest:x.anchor.snapshotDigest}};
 assert.equal(validate(x).authenticated,false);assert.equal(classify(x).uncertaintyClearAuthorized,false);
});
test("u64 slot/height strings are preserved above safe JS numbers",()=>{
 const x=protocolFixture();x.observation={...x.observation,
 provenance:{...x.observation.provenance,contextSlot:"18446744073709551615"},
 transaction:{...x.status,transactionSlot:"9007199254740993",contextSlot:"18446744073709551615",observedBlockHeight:"18446744073709551615"},
 accounts:{kind:"not_supplied",reason:"fixture_missing"}};
 assert.equal(validate(x).data.provenance.contextSlot,"18446744073709551615");
});
test("fixture provenance with copied matching values cannot prove RPC or account authenticity",()=>{
 const x=protocolFixture();
 const result=validate(x);assert.equal(result.authenticated,false);
 assert.throws(()=>validate(x,{...x.observation,approved:true}));
 assert.throws(()=>validate(x,result)); // Validated envelope is not a branded authorization ticket.
 x.observation={...x.observation,provenance:{...x.observation.provenance,kind:"unverified_reference"}};
 assert.equal(validate(x).authenticated,false);assert.equal(classify(x).uncertaintyClearAuthorized,false);
});
