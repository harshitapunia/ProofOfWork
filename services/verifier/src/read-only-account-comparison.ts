import { validateJobBindings,decodeInternship,decodeMilestone,decodeSubmission,decodeCompletionRecord } from "@proofwork/lifecycle";
import { deriveCompletion } from "@proofwork/finance-client";
import { PublicKey } from "@solana/web3.js";
import { protocolDataDigest,type ProtocolAnchor,type AccountEvidence } from "./operational-protocol.js";
import {record,list,check,freeze} from "./read-only-observation-data.js";
import type {RawAccountSet,RawAccountEntry} from "./read-only-observation-types.js";
export interface OfflineAccountComparison {
 readonly kind:"matching_fixture"|"insufficient_fixture"|"mismatched_fixture";readonly reason:string;
 readonly evidence:AccountEvidence;readonly raw:RawAccountSet|null;readonly onChainStateVerified:false;
}
function entry(input:unknown,expected:string):RawAccountEntry {
 const v=record(input,["address","account"]);check(v.address===expected,"account_address_mismatch");
 if(v.account!==null){
  const a=record(v.account,["owner","executable","data"]),d=list(a.data,2);
  check(d.length===2 && typeof d[0]==="string" && d[0].length<=368 && d[1]==="base64"
   && typeof a.owner==="string" && typeof a.executable==="boolean","invalid_raw_account");
  const bytes=Buffer.from(d[0],"base64");check(bytes.toString("base64")===d[0],"invalid_raw_account");
  v.account={...a,data:d};
 }
 return freeze(v as RawAccountEntry);
}
/** Existing approved raw decoders do the layout/owner/PDA checks. No live state/provenance is asserted. */
export function compareOfflineAccounts(input:unknown,anchor:ProtocolAnchor,contextSlot:string):OfflineAccountComparison{
 try{
  protocolDataDigest(anchor);
  const b=validateJobBindings(anchor.bindings),v=record(input,["internship","milestone","submission","completion"]);
  const raw:RawAccountSet=freeze({internship:entry(v.internship,b.internship),milestone:entry(v.milestone,b.milestone),
   submission:entry(v.submission,b.submission),completion:entry(v.completion,deriveCompletion(b.milestone)[0].toBase58())});
  if(!raw.internship.account||!raw.milestone.account||!raw.submission.account)
   return freeze({kind:"insufficient_fixture",reason:"missing_required_account",evidence:{kind:"incomplete",reason:"missing_required_account"},raw,onChainStateVerified:false});
  const i=decodeInternship(raw.internship.address,raw.internship.account),m=decodeMilestone(raw.milestone.address,raw.milestone.account,i);
  const s=decodeSubmission(raw.submission.address,raw.submission.account,m);
  check(i.sponsor===b.sponsor&&i.internshipId.toString()===b.internshipId&&m.milestoneId.toString()===b.milestoneId
   &&m.student===b.student&&m.verifier===b.verifier&&m.requirementsHash===b.requirementsHash&&s.evidenceHash===b.evidenceHash
   &&m.submission===b.submission&&["Verified","Settled"].includes(m.status),"attestation_postcondition_mismatch");
  let completionDigest:string|null=null;
  if(m.status==="Settled"){
   if(!raw.completion.account)return freeze({kind:"insufficient_fixture",reason:"missing_completion",evidence:{kind:"incomplete",reason:"missing_completion"},raw,onChainStateVerified:false});
   decodeCompletionRecord(raw.completion.address,raw.completion.account,m,s);completionDigest=protocolDataDigest(raw.completion);
  }else if(raw.completion.account){
   // Match the existing lifecycle reader's optional prefunded empty System account policy.
   check(raw.completion.account.owner===PublicKey.default.toBase58()&&raw.completion.account.executable===false
    &&JSON.stringify(raw.completion.account.data)==='["","base64"]',"unexpected_completion");
  }
  const evidence:AccountEvidence={kind:"matching_candidate",programId:b.programId,milestone:m.address,submission:s.address,
   student:m.student,verifier:m.verifier,requirementsHash:m.requirementsHash,evidenceHash:s.evidenceHash,
   milestoneStatus:m.status as "Verified"|"Settled",submittedAt:s.submittedAt.toString(),verifiedAt:m.verifiedAt.toString(),
   contextSlot,accountSetDigest:protocolDataDigest(raw),completionDigest};
  return freeze({kind:"matching_fixture",reason:m.status==="Settled"?"later_settled_fixture":"attestation_verified_fixture",evidence,raw,onChainStateVerified:false});
 }catch{
  return freeze({kind:"mismatched_fixture",reason:"raw_account_validation_failed",evidence:{kind:"mismatched",reason:"raw_account_validation_failed"},raw:null,onChainStateVerified:false});
 }
}
