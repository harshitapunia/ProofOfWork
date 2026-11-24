/** Session-authorized, transient chain observations. Never writes lifecycle storage or dispatches verification. */
import { PublicKey } from "@solana/web3.js";
import { decodeInternship, decodeMilestone, decodeSubmission, decodeCompletionRecord } from "@proofwork/lifecycle";
import { deriveInternship, deriveMilestone, deriveSubmission, deriveCompletion, deriveVault, deriveVaultAuthority,
 DEMO_MINT, TOKEN_PROGRAM_ID, SETTLEMENT_DEVNET_GENESIS } from "@proofwork/finance-client";
import { ReadOnlyWalletRpc } from "./devnet-wallet-review.js";
import { WalletAuthError } from "./wallet-sessions.js";
import { APPLICATION_API_VERSION } from "./application-api-contracts.js";
import { parseRequest, type Request } from "./service.js";
import { parseManifest } from "./manifest.js";
import { evidenceHash } from "./commitments.js";
function check(value: unknown, code="invalid_request", status=400): asserts value { if(!value)throw new WalletAuthError(code,status); }
function fields(input:unknown,names:string[]):Record<string,any>{
 check(input && typeof input==="object" && !Array.isArray(input));
 check(JSON.stringify(Object.keys(input).sort())===JSON.stringify(names.sort()));return input as Record<string,any>;
}
// Same empty-system-account interpretation as the existing lifecycle reader: prefunding is not initialization.
function empty(v:any):boolean{return v===null || (v?.owner===PublicKey.default.toBase58()&&v.executable===false&&JSON.stringify(v.data)==='["","base64"]');}
function id(v:unknown):bigint{check(typeof v==="string"&&/^(0|[1-9][0-9]{0,19})$/.test(v));const n=BigInt(v);check(n<=0xffffffffffffffffn);return n;}
export interface WorkflowState {
 kind:"workflow_state"; internship:string; milestone:string; internshipExists:boolean; milestoneExists:boolean;
 slot:number; commitment:"confirmed"; provenance:"offline_fixture"|"unverified_devnet_rpc"; persisted:false;
 status:string|null; student:string|null; verifier:string|null; requirementsHash:string|null;
 rewardAmountRaw:string|null; assignBy:string|null; submitBy:string|null; evidenceHash:string|null;
 verifiedAt:string|null; completion:string|null; settledAt:string|null; vaultAmountRaw:string|null; vaultClosed:boolean|null;
 verification:"not_observed"|"attestation_observed"; rewardPayment:"not_established";
}
export interface VerificationHandoff {kind:"verification_handoff";request:Request;dispatch:"unavailable";authorization:"not_granted";persisted:false;rewardPayment:"not_established"}
export class WorkflowStateReader {
 constructor(private readonly rpc=new ReadOnlyWalletRpc(),readonly provenance:"offline_fixture"|"unverified_devnet_rpc"="unverified_devnet_rpc"){check(rpc instanceof ReadOnlyWalletRpc && ["offline_fixture","unverified_devnet_rpc"].includes(provenance),"invalid_chain_configuration",503);}
 async read(input:unknown,wallet:string):Promise<WorkflowState>{
  const q=fields(input,["apiVersion","cluster","sponsor","internshipId","milestoneId"]);
  check(q.apiVersion===APPLICATION_API_VERSION&&q.cluster==="devnet");
  let sponsor:PublicKey;try{sponsor=new PublicKey(q.sponsor);check(sponsor.toBase58()===q.sponsor&&PublicKey.isOnCurve(sponsor.toBytes())&&!sponsor.equals(PublicKey.default));}catch{throw new WalletAuthError("invalid_request",400);}
  const internship=deriveInternship(sponsor,id(q.internshipId))[0].toBase58(),milestone=deriveMilestone(internship,id(q.milestoneId))[0].toBase58();
  const submission=deriveSubmission(milestone)[0].toBase58(),completion=deriveCompletion(milestone)[0].toBase58(),vault=deriveVault(milestone)[0].toBase58();
  const signal=AbortSignal.timeout(10000);
  check(await this.rpc.call("getGenesisHash",[],signal)===SETTLEMENT_DEVNET_GENESIS,"wrong_cluster",503);
  const batch=await this.rpc.accounts([internship,milestone,submission,completion,vault],0,signal);
  const [i,m,s,c,v]=batch.values;
  const out:WorkflowState={kind:"workflow_state",internship,milestone,internshipExists:!empty(i),milestoneExists:!empty(m),
   slot:batch.slot,commitment:"confirmed",provenance:this.provenance,persisted:false,status:null,student:null,verifier:null,requirementsHash:null,
   rewardAmountRaw:null,assignBy:null,submitBy:null,evidenceHash:null,verifiedAt:null,completion:null,settledAt:null,vaultAmountRaw:null,vaultClosed:null,
   verification:"not_observed",rewardPayment:"not_established"};
  try{
   if(empty(m)){check(wallet===q.sponsor,"resource_not_found",404);check(empty(s)&&empty(c)&&empty(v),"chain_state_invalid",503);
    if(!empty(i))decodeInternship(internship,i);return out;}
   const parent=decodeInternship(internship,i),state=decodeMilestone(milestone,m,parent);
   check(wallet===state.sponsor||wallet===state.student,"resource_not_found",404);
   const needs=["Submitted","Verified","Settled"].includes(state.status);
   const submitted=needs?decodeSubmission(submission,s,state):undefined;
   check(needs||empty(s),"chain_state_invalid",503);
   const record=state.status==="Settled"?decodeCompletionRecord(completion,c,state,submitted!):undefined;
   check(state.status==="Settled"||empty(c),"chain_state_invalid",503);
   const terminal=["Settled","Refunded"].includes(state.status);
   if(state.status==="Created"||terminal){check(empty(v),"chain_state_invalid",503);out.vaultClosed=terminal?true:null;}
   else{
    check(v?.owner===TOKEN_PROGRAM_ID&&v.executable===false&&Array.isArray(v.data)&&v.data[1]==="base64","chain_state_invalid",503);
    const b=Buffer.from(v.data[0],"base64");check(b.length===165&&b.toString("base64")===v.data[0]&&b[108]===1
     &&new PublicKey(b.subarray(0,32)).toBase58()===DEMO_MINT&&new PublicKey(b.subarray(32,64)).equals(deriveVaultAuthority(milestone)[0])
     &&b.readUInt32LE(72)===0&&b.readUInt32LE(109)===0&&b.readUInt32LE(129)===0&&b.readBigUInt64LE(64)>=state.rewardAmount,"chain_state_invalid",503);
    out.vaultAmountRaw=b.readBigUInt64LE(64).toString();out.vaultClosed=false;
   }
   return {...out,status:state.status,student:state.student===PublicKey.default.toBase58()?null:state.student,verifier:state.verifier,
    requirementsHash:state.requirementsHash,rewardAmountRaw:state.rewardAmount.toString(),assignBy:state.assignBy.toString(),submitBy:state.submitBy.toString(),
    evidenceHash:submitted?.evidenceHash??null,verifiedAt:state.verifiedAt>0n?state.verifiedAt.toString():null,
    completion:record?.address??null,settledAt:record?.settledAt.toString()??null,verification:state.verifiedAt>0n?"attestation_observed":"not_observed"};
  }catch(e){if(e instanceof WalletAuthError)throw e;throw new WalletAuthError("chain_state_invalid",503);}
 }
 async handoff(input:unknown,wallet:string):Promise<VerificationHandoff>{
  const q=fields(input,["apiVersion","cluster","sponsor","internshipId","milestoneId","evidence"]);
  const {evidence,...target}=q;const state=await this.read(target,wallet);
  check(state.status==="Submitted"&&state.student===wallet,"verification_not_available",409);
  try{
   const request=parseRequest(evidence);check(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(request.owner)&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(request.repository),"invalid_verification_evidence");const {manifest,hash}=parseManifest(Buffer.from(request.manifestBase64,"base64"));
   check(Buffer.from(request.manifestBase64,"base64").toString("base64")===request.manifestBase64);
   check(request.milestone===state.milestone&&request.student===state.student&&manifest.repositoryId===request.repositoryId
    &&hash.toString("hex")===state.requirementsHash&&evidenceHash({...request,requirementsHash:state.requirementsHash!}).toString("hex")===state.evidenceHash,"evidence_mismatch");
   return {kind:"verification_handoff",request,dispatch:"unavailable",authorization:"not_granted",persisted:false,rewardPayment:"not_established"};
  }catch(e){if(e instanceof WalletAuthError)throw e;throw new WalletAuthError("invalid_verification_evidence",400);}
 }
}
