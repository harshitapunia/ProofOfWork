/** Real builders and existing manifest/evidence commitments. Synthetic public fixtures only. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInternshipInstruction, createMilestoneInstruction, fundMilestoneInstruction, assignStudentInstruction, submitMilestoneInstruction } from "@proofwork/finance-client";
import { prepareWorkflow } from "../src/workflow-preparation.js";
import { evidenceHash } from "../src/commitments.js";
import { manifest, fixture } from "./helpers.js";
import { APPLICATION_API_VERSION } from "../src/application-api-contracts.js";
const f = fixture();
const sponsor = (await import("@solana/web3.js")).PublicKey;
const owner = new sponsor(f.i.subarray(8,40)).toBase58();
const input = () => ({ apiVersion: APPLICATION_API_VERSION, cluster: "devnet", action: "organization", terms: {
 title:"Synthetic internship", note:"Local uncommitted note", sponsor:owner, student:f.request.student, verifier:f.verifier.toBase58(),
 internshipId:"1", milestoneId:"1", rewardAmountRaw:"1000000", assignBy:"200", submitBy:"300", owner:"proofwork-demo", repository:"assignment", manifest:JSON.stringify(manifest()) } });
const evidence = { contributorId:"2002", commit:"cd".repeat(20), nonce:"ef".repeat(32), pullRequest:7 };
function wire(ix: ReturnType<typeof createInternshipInstruction>) { return { programId:ix.programId.toBase58(), keys:ix.keys.map(k=>({pubkey:k.pubkey.toBase58(),isSigner:k.isSigner,isWritable:k.isWritable})),dataBase64:ix.data.toString("base64") }; }
test("organization plan uses exact five reviewed builder interfaces, flags and immutable commitments",()=>{
 const v=input(),out=prepareWorkflow(v,owner,100n),common={sponsor:owner,internshipId:1n,milestoneId:1n};
 const expected=[createInternshipInstruction(common),createMilestoneInstruction({...common,rewardAmount:1000000n,requirementsHash:f.requirements,assignBy:200n,submitBy:300n,verifier:f.verifier,nowUnixSeconds:100n}),fundMilestoneInstruction(common),assignStudentInstruction({...common,student:f.request.student})];
 assert.deepEqual(out.steps.map(s=>s.instructions),expected.map(i=>[wire(i)])); assert.equal(out.requirementsHash,f.requirements.toString("hex"));
 assert.equal(out.internship,f.internship.toBase58()); assert.equal(out.milestone,f.milestone.toBase58());
 assert.equal(out.accountState,"not_observed");assert.equal(out.idsReserved,false);assert.equal(out.signed,false);assert.equal(out.broadcast,false);assert.equal(out.verification,"not_run");assert.equal(out.rewardPayment,"not_established");
});
test("student submission uses existing domain-separated evidence hash and exact submit builder",()=>{
 const v={...input(),action:"submission",evidence};const out=prepareWorkflow(v,f.request.student,100n);
 const hash=evidenceHash({...f.request,requirementsHash:out.requirementsHash});assert.equal(out.evidenceHash,hash.toString("hex"));
 assert.deepEqual(out.steps[0]!.instructions,[wire(submitMilestoneInstruction({sponsor:owner,internshipId:1n,milestoneId:1n,student:f.request.student,evidenceHash:hash}))]);
 assert(!JSON.stringify(out).includes(evidence.nonce));assert(!JSON.stringify(out).includes("signature"));
 assert.equal(out.proposalAuthority,"not_proven");
});
for(const [field,value,code] of [
 ["student","invalid-wallet","invalid_wallet"],["student",owner,"invalid_assignment"],["student",f.verifier.toBase58(),"invalid_assignment"],
 ["verifier",owner,"invalid_assignment"],["rewardAmountRaw","0","invalid_integer"],["rewardAmountRaw","1.5","invalid_integer"],
 ["rewardAmountRaw","18446744073709551616","invalid_integer"],["internshipId","01","invalid_integer"],["milestoneId","-1","invalid_integer"],
 ["assignBy","100","invalid_deadlines"],["assignBy","300","invalid_deadlines"],["submitBy","199","invalid_deadlines"],
 ["submitBy","9223372036854775808","invalid_integer"],["manifest","{}","invalid_manifest"],["owner","https://github.com/name","invalid_github_evidence"],
 ["repository","../repository","invalid_github_evidence"],["title"," ","invalid_description"],
] as const)test("organization rejects "+field+" = "+value,()=>{const v=input();(v.terms as any)[field]=value;assert.throws(()=>prepareWorkflow(v,owner,100n),{code});});
test("unknown role/authority/account overrides and extra request fields are rejected",()=>{
 for(const v of [{...input(),role:"sponsor"},{...input(),terms:{...input().terms,programId:"untrusted"}},{...input(),cluster:"mainnet"},{...input(),action:"attest"}]) assert.throws(()=>prepareWorkflow(v,owner,100n));
 assert.throws(()=>prepareWorkflow(input(),f.request.student,100n),{code:"workflow_forbidden"});
 assert.throws(()=>prepareWorkflow({...input(),action:"submission",evidence},owner,100n),{code:"workflow_forbidden"});
});
for(const [field,value] of [["commit","x".repeat(40)],["nonce","00".repeat(32)],["contributorId","0"],["pullRequest",0],["pullRequest",1.5]] as const)
 test("invalid GitHub evidence rejects "+field,()=>{assert.throws(()=>prepareWorkflow({...input(),action:"submission",evidence:{...evidence,[field]:value}},f.request.student,100n),{code:"invalid_github_evidence"});});
test("exclusive submission deadline and duplicate preparations never imply a second submission",()=>{
 const v={...input(),action:"submission",evidence};assert.throws(()=>prepareWorkflow(v,f.request.student,300n),{code:"invalid_deadlines"});
 assert.deepEqual(prepareWorkflow(v,f.request.student,100n),prepareWorkflow(v,f.request.student,100n));
});
