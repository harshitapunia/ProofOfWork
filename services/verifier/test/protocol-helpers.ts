/** Deterministic PUBLIC test data only. No private keys or signing calls. */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Transaction } from "@solana/web3.js";
import { PROTOCOL_VERSION as V, PROTOCOL_POLICY, protocolDataDigest as digest,
 type ProtocolAnchor,type ProtocolSnapshot,type AdmissionRequest,type CustodyRoleRequest,type SigningOutcome,
 type SubmissionRequest,type ObservationContract,type StatusClaim } from "../src/operational-protocol.js";
export const fixture=JSON.parse(readFileSync(new URL("../../test/fixtures/operational-protocol-public.json",import.meta.url),"utf8"));
export function protocolFixture(){
 const f=structuredClone(fixture),b=f.bindings;
 const anchor:ProtocolAnchor={bindings:b,jobId:f.jobId,jobIdentity:f.jobIdentity,intentId:f.intentId,intentIdentity:f.intentIdentity,
 feePayer:f.payer,messageDigest:f.messageDigest,snapshotDigest:f.snapshotDigest,blockhash:f.blockhash,lastValidBlockHeight:"200",
 preparedAtBlockHeight:"100",issuedAtUnixMs:"1000",deadlineUnixMs:"2000",epoch:"1",policyVersion:PROTOCOL_POLICY,
 operatorApprovalRef:"fixture_operator_ref",verifierApprovalRef:"fixture_verifier_consent",payerApprovalRef:"fixture_payer_consent",
 submissionApprovalRef:"fixture_first_send"};
 const snapshot:ProtocolSnapshot={nowUnixMs:"1500",blockHeight:"110",currentEpoch:"1",minRemainingBlockHeights:"10",sourceIds:["fixture_provider"]};
 const admission:AdmissionRequest={version:V,kind:"offline_admission_data",admissionId:f.jobId,operationKey:"devnet:"+b.programId+":"+b.milestone,
 jobId:f.jobId,jobIdentity:f.jobIdentity,intentId:f.intentId,intentIdentity:f.intentIdentity,bindings:b,feePayer:f.payer,
 messageDigest:f.messageDigest,messageBase64:f.messageBase64,snapshotDigest:f.snapshotDigest,policyVersion:PROTOCOL_POLICY,
 issuedAtUnixMs:"1000",deadlineUnixMs:"2000",blockhash:f.blockhash,lastValidBlockHeight:"200",preparedAtBlockHeight:"100",
 operatorApprovalRef:anchor.operatorApprovalRef,epoch:"1"};
 const roles:CustodyRoleRequest[]=(["verifier","fee_payer"] as const).map((role,n)=>({version:V,
 kind:role==="verifier"?"offline_verifier_request":"offline_fee_payer_request",requestId:n===0?f.jobId:f.intentId,
 admissionId:admission.admissionId,admissionDigest:digest(admission),operationKey:admission.operationKey,role,
 publicKey:n===0?b.verifier:f.payer,messageDigest:f.messageDigest,messageBase64:f.messageBase64,deadlineUnixMs:"2000",epoch:"1",
 roleApprovalRef:n===0?anchor.verifierApprovalRef:anchor.payerApprovalRef}));
 const outcomes:SigningOutcome[]=roles.map((q,n)=>({version:V,kind:"offline_signing_outcome",state:"signature_observed",
 requestId:q.requestId,requestDigest:digest(q),admissionId:q.admissionId,operationKey:q.operationKey,role:q.role,
 publicKey:q.publicKey,messageDigest:q.messageDigest,receiptRef:"fixture_receipt_"+n,
 signatureBase64:n===0?f.verifierSignatureBase64:f.payerSignatureBase64}));
 const tx=Transaction.from(Buffer.from(f.wireBase64,"base64"));
 let n=BigInt("0x"+tx.signature!.toString("hex")),transactionId="";const alphabet="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
 while(n){transactionId=alphabet[Number(n%58n)]!+transactionId;n/=58n;}
 for(const x of tx.signature!){if(x!==0)break;transactionId="1"+transactionId;}
 const submission:SubmissionRequest={version:V,kind:"offline_first_submission_data",senderAdmissionId:f.intentId,
 admissionId:admission.admissionId,admissionDigest:digest(admission),operationKey:admission.operationKey,messageDigest:f.messageDigest,
 wireBase64:f.wireBase64,wireDigest:createHash("sha256").update(Buffer.from(f.wireBase64,"base64")).digest("hex"),transactionId,
 submissionApprovalRef:anchor.submissionApprovalRef,deadlineUnixMs:"2000",epoch:"1"};
 const status:StatusClaim={kind:"status_claim",transactionId,messageDigest:f.messageDigest,wireDigest:submission.wireDigest,
 finality:"finalized",outcome:"success",errorCode:null,transactionSlot:"120",contextSlot:"121",observedBlockHeight:"150"};
 const observation:ObservationContract={version:V,kind:"offline_observation_data",senderAdmissionId:submission.senderAdmissionId,
 submissionDigest:digest(submission),operationKey:submission.operationKey,provenance:{kind:"offline_fixture",sourceId:"fixture_provider",
 cluster:"devnet",genesisHash:b.genesisHash,requestId:"fixture_query",eventId:"fixture_event",contextSlot:"122"},transaction:status,
 accounts:{kind:"matching_candidate",programId:b.programId,milestone:b.milestone,submission:b.submission,student:b.student,
 verifier:b.verifier,requirementsHash:b.requirementsHash,evidenceHash:b.evidenceHash,milestoneStatus:"Verified",submittedAt:"100",
 verifiedAt:"101",contextSlot:"121",accountSetDigest:f.snapshotDigest,completionDigest:null}};
 return {anchor,snapshot,admission,roles,outcomes,submission,observation,status};
}
