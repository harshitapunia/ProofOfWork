import {test} from "node:test";
import assert from "node:assert/strict";
import {protocolFixture} from "./protocol-helpers.js";
import {validateAdmission,validateSubmission,validateObservation} from "../src/operational-protocol.js";
import {AttestationAuthorizer} from "../src/attestation.js";
import {AttestationTransactionPolicy,takeOfflinePolicyMessage} from "../src/transaction-policy.js";
import {createOfflineTestExecutionObserver,type ExecutionAttempt} from "@proofwork/lifecycle";
test("validated protocol data cannot restore consumed authorization or offline observation brands",async()=>{
 const x=protocolFixture(),chain={read:async()=>{throw Error("unexpected_chain_read");}};
 const authorizer=new AttestationAuthorizer({verify:async()=>{throw Error("unexpected_verification");}},chain,x.anchor.bindings.verifier);
 const policy=new AttestationTransactionPolicy(authorizer,chain,{read:async()=>{throw Error("unexpected_blockhash_read");}},
 {verifier:x.anchor.bindings.verifier,feePayer:x.anchor.feePayer,maxAgeMs:5000,minRemainingBlockHeights:10});
 const data=[validateAdmission(x.admission,x.anchor,x.snapshot),
 validateSubmission(x.submission,x.admission,x.roles,x.outcomes,x.anchor,x.snapshot),
 validateObservation(x.observation,x.submission,x.admission,x.anchor,x.snapshot)];
 let sourceCalls=0,validatorCalls=0;
 const observer=createOfflineTestExecutionObserver({mode:"offline-test-observation-source",read:async()=>{sourceCalls++;throw Error("unexpected_source");}},
 {mode:"offline-fixture-message-validator",validate:async()=>{validatorCalls++;throw Error("unexpected_validator");}});
 for(const v of data){
  for(const a of [v,v.data,JSON.parse(JSON.stringify(v))]){
   await assert.rejects(authorizer.takeInstruction(a),{code:"invalid_authorization"});
   await assert.rejects(policy.consume(a),{code:"invalid_transaction_authorization"});
   await assert.rejects(observer.observe(a as ExecutionAttempt),{code:"untrusted_execution_snapshot"});
  }
 }
 assert.equal(sourceCalls,0);assert.equal(validatorCalls,0);
 assert.throws(()=>takeOfflinePolicyMessage(Buffer.from(x.admission.messageBase64,"base64")));
});
test("contract identifiers are immutable bindings, not self-authenticating request IDs",()=>{
 const x=protocolFixture(),a=validateAdmission(x.admission,x.anchor,x.snapshot);
 const freshLabel={...x.admission,admissionId:x.anchor.intentId};
 assert.equal(validateAdmission(freshLabel,x.anchor,x.snapshot).operationalAuthorization,false);
 // A relabeled request still targets the same protected operation. External permanent uniqueness is required.
 assert.equal(validateAdmission(freshLabel,x.anchor,x.snapshot).data.operationKey,a.data.operationKey);
 assert.throws(()=>validateSubmission(x.submission,freshLabel,x.roles,x.outcomes,x.anchor,x.snapshot));
});
