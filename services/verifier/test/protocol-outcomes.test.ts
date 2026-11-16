import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {protocolFixture,fixture} from "./protocol-helpers.js";
import {PROTOCOL_VERSION as V,protocolDataDigest as digest,validateSigningOutcome,validateSubmission,validateSubmissionOutcome,
 validateObservation,type SubmissionState} from "../src/operational-protocol.js";
for(const state of ["not_admitted","admission_accepted","signing_rejected","signing_uncertain","signature_observed"] as const)
 test("signing data distinguishes "+state,()=>{
  const x=protocolFixture(),s={...x.outcomes[0]} as any;delete s.signatureBase64;delete s.receiptRef;s.state=state;
  if(state==="admission_accepted")s.receiptRef="fixture_receipt";
  else if(state==="signature_observed"){s.receiptRef="fixture_receipt";s.signatureBase64=fixture.verifierSignatureBase64;}
  else{s.reason="fixture_reason";if(state==="signing_uncertain")s.receiptRef=null;}
  const out=validateSigningOutcome(s,x.roles[0],x.admission,x.anchor,x.snapshot);assert.equal(out.data.state,state);assert.equal(out.authenticated,false);
  if(state!=="signature_observed")assert.throws(()=>validateSubmission(x.submission,x.admission,x.roles,[s,x.outcomes[1]],x.anchor,x.snapshot));
 });
test("missing receipt, partial/malformed/wrong-key signature never establishes signature-observed data",()=>{
 const x=protocolFixture(),s={...x.outcomes[0]} as any;delete s.receiptRef;
 assert.throws(()=>validateSigningOutcome(s,x.roles[0],x.admission,x.anchor,x.snapshot));
 for(const signatureBase64 of ["bad",Buffer.alloc(64).toString("base64"),fixture.payerSignatureBase64])
 assert.throws(()=>validateSigningOutcome({...x.outcomes[0],signatureBase64},x.roles[0],x.admission,x.anchor,x.snapshot));
 assert.throws(()=>validateSubmission(x.submission,x.admission,x.roles,[x.outcomes[0]],x.anchor,x.snapshot));
});
for(const patch of [{version:"v0"},{messageDigest:"aa".repeat(32)},{wireDigest:"aa".repeat(32)},{transactionId:"bad"},
 {senderAdmissionId:"bad"},{submissionApprovalRef:"forged"},{deadlineUnixMs:"2001"},{epoch:"0"},{retry:true}])
 test("submission rejects "+JSON.stringify(patch),()=>{
 const x=protocolFixture();assert.throws(()=>validateSubmission({...x.submission,...patch},x.admission,x.roles,x.outcomes,x.anchor,x.snapshot));
 });
test("partial wire and changed bytes fail even with matching caller-supplied wire digest",()=>{
 const x=protocolFixture();
 for(const partial of [false,true]){
 const b=Buffer.from(x.submission.wireBase64,"base64");if(partial)b.fill(0,1,65);else b[b.length-1]=b[b.length-1]!^1;
 const wireDigest=createHash("sha256").update(b).digest("hex");
 assert.throws(()=>validateSubmission({...x.submission,wireBase64:b.toString("base64"),wireDigest},x.admission,x.roles,x.outcomes,x.anchor,x.snapshot));
 }
});
for(const state of ["not_admitted","intent_recorded","invocation_potentially_occurred","acknowledgment_received","submission_uncertain"] as SubmissionState[])
 test("submission data distinguishes "+state,()=>{
 const x=protocolFixture(),s={version:V,kind:"offline_submission_outcome",state,senderAdmissionId:x.submission.senderAdmissionId,
 submissionDigest:digest(x.submission),transactionId:x.submission.transactionId,
 acknowledgmentTransactionId:state==="acknowledgment_received"?x.submission.transactionId:null,
 reason:["not_admitted","submission_uncertain"].includes(state)?"fixture_timeout":null};
 const out=validateSubmissionOutcome(s,x.submission,x.admission,x.anchor,x.snapshot);assert.equal(out.authenticated,false);
 assert.throws(()=>validateSubmissionOutcome({...s,acknowledgmentTransactionId:"wrong"},x.submission,x.admission,x.anchor,x.snapshot));
});
test("duplicate data validation does not prevent replay; stale effect context cannot renew an admission",()=>{
 const x=protocolFixture(),validate=()=>validateSubmission(x.submission,x.admission,x.roles,x.outcomes,x.anchor,x.snapshot);
 assert.deepEqual(validate(),validate());assert.equal(validate().retryAuthorized,false);
 const later={...x.snapshot,nowUnixMs:"5000",blockHeight:"300",currentEpoch:"2"};
 assert.throws(()=>validateSubmission(x.submission,x.admission,x.roles,x.outcomes,x.anchor,later));
 assert.equal(validateSigningOutcome(x.outcomes[0],x.roles[0],x.admission,x.anchor,later).authenticated,false);
 assert.equal(validateObservation(x.observation,x.submission,x.admission,x.anchor,later).operationalAuthorization,false);
});
test("mutating caller input after validation cannot alter the frozen output",()=>{
 const x=protocolFixture(),v=validateSubmission(x.submission,x.admission,x.roles,x.outcomes,x.anchor,x.snapshot);
 (x.submission as any).transactionId="changed";assert.notEqual(v.data.transactionId,"changed");assert.ok(Object.isFrozen(v.data));
});
