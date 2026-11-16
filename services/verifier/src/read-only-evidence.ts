import {INTENT_FORMAT,type TransactionIntent,type Preparation} from "@proofwork/lifecycle";
import {deriveCompletion} from "@proofwork/finance-client";
import {validateObservation,protocolDataDigest,type ObservationContract,type SourceProvenance,type StatusClaim,type AccountEvidence,type Finality} from "./operational-protocol.js";
import {compareOfflineAccounts} from "./read-only-account-comparison.js";
import {check,record,list,tag,freeze,rank,OfflineReadError} from "./read-only-observation-data.js";
import type {OfflineReadPlan,ExecutionReadView,OfflineSourceObservation,OfflineReconciliation,ReconciliationClassification} from "./read-only-observation-types.js";

const EMPTY={kind:"not_supplied" as const,reason:"not_read"};
const eventKey=(s:string,e:string)=>JSON.stringify([s,e]);
function selected(value:unknown,keys:readonly string[]):Record<string,any>{
 check(value!==null&&typeof value==="object");
 return Object.fromEntries(keys.map(k=>{const d=Object.getOwnPropertyDescriptor(value,k);check(d&&Object.hasOwn(d,"value"));return [k,d.value];}));
}
function reference(v:unknown):asserts v is string{check(typeof v==="string"&&/^[A-Za-z0-9_-]{1,80}$/.test(v));}
function protocol(plan:OfflineReadPlan,p:unknown,t:unknown,accounts:unknown=EMPTY):ObservationContract {
 return validateObservation({version:plan.admission.version,kind:"offline_observation_data",senderAdmissionId:plan.submission.senderAdmissionId,
  submissionDigest:protocolDataDigest(plan.submission),operationKey:plan.admission.operationKey,provenance:p,transaction:t,accounts},
  plan.submission,plan.admission,plan.anchor,plan.snapshot).data;
}
/** Normalize caller expectations only. Validation never authenticates this plan or creates authority. */
export function validateOfflineReadPlan(input:unknown):OfflineReadPlan{
 try{
  protocolDataDigest(input); // Reject nested accessors/non-JSON data before reading nested values.
  const p=record(input,["kind","attempt","admission","submission","anchor","snapshot","requestId","minimumContextSlot","events","priorEvents"]);
  check(p.kind==="offline_read_plan");reference(p.requestId);
  const a=record(p.attempt,["attemptId","identity","revision"]);
  check(typeof a.attemptId==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(a.attemptId)
   &&typeof a.identity==="string"&&/^[0-9a-f]{64}$/.test(a.identity)&&Number.isSafeInteger(a.revision)&&a.revision>=0&&a.revision<=32);
  const events=list(p.events,8).map(v=>record(v,["sourceId","eventId"]));
  check(events.length>0);
  const prior=list(p.priorEvents,32).map(v=>record(v,["sourceId","eventId","contextSlot"]));
  const seen=new Set<string>();const sources=new Set<string>();
  for(const e of [...events,...prior]){
   reference(e.sourceId);reference(e.eventId);
   const probe={kind:"offline_fixture",sourceId:e.sourceId,cluster:"devnet",genesisHash:p.anchor?.bindings?.genesisHash,
    requestId:p.requestId,eventId:e.eventId,contextSlot:e.contextSlot??p.minimumContextSlot};
   protocol(p as OfflineReadPlan,probe,{kind:"missing",reason:"history_missing"});
  }
  for(const e of events){check(!sources.has(e.sourceId));sources.add(e.sourceId);}
  for(const e of prior){const k=eventKey(e.sourceId,e.eventId);check(!seen.has(k));seen.add(k);}
  // Validate every nested field through the canonical Phase 8C-2B validator before cloning.
  // A proxy/accessor cannot become stored data; structuredClone also rejects proxies.
  return freeze(structuredClone({...p,attempt:a,events,priorEvents:prior}) as unknown as OfflineReadPlan);
 }catch{throw new OfflineReadError("invalid_offline_read_plan");}
}
type CorrelationSnapshot=Omit<ExecutionReadView,"intent"> & {readonly intent:Pick<TransactionIntent,
 "intentId"|"identity"|"jobId"|"jobIdentity"|"operationKey"|"bindings"|"feePayer"|"state"|"workerId"|"generation"|"jobRevision"|"reconciliationRequired"> & {readonly preparation:Preparation}};
export function correlateExecution(plan:OfflineReadPlan,input:unknown):CorrelationSnapshot {
 try{
  const v=selected(input,["attemptId","identity","revision","intent","mode","wireDigest","testTransactionId"]);
  check(v.attemptId===plan.attempt.attemptId&&v.identity===plan.attempt.identity&&v.mode==="offline-test-model"
   &&Number.isSafeInteger(v.revision)&&v.revision>=0&&v.revision<=32,"execution_identity_mismatch");
  check((v.wireDigest===null&&v.testTransactionId===null)||(v.wireDigest===plan.submission.wireDigest&&v.testTransactionId===plan.submission.transactionId),"execution_identity_mismatch");
  const i=selected(v.intent,["intentId","identity","jobId","jobIdentity","operationKey","bindings","feePayer","preparation",
   "state","workerId","generation","jobRevision","reconciliationRequired"]);
  check(["created","preparation_recorded","preparation_rejected","preparation_uncertain","reconciliation_required"].includes(i.state)
   &&typeof i.workerId==="string"&&/^[A-Za-z0-9_-]{1,80}$/.test(i.workerId)&&Number.isSafeInteger(i.generation)&&i.generation>=0&&i.generation<=2147483647
   &&Number.isSafeInteger(i.jobRevision)&&i.jobRevision>=0&&i.jobRevision<=256&&typeof i.reconciliationRequired==="boolean");
  const a=plan.anchor,d=plan.admission;
  check(i.intentId===a.intentId&&i.identity===a.intentIdentity&&i.jobId===a.jobId&&i.jobIdentity===a.jobIdentity
   &&i.operationKey===d.operationKey&&i.feePayer===a.feePayer&&protocolDataDigest(i.bindings)===protocolDataDigest(a.bindings),
   "execution_identity_mismatch");
  const prep=selected(i.preparation,["identity","format","messageDigest","blockhash","lastValidBlockHeight","observedBlockHeight"]);
  check(typeof prep.identity==="string"&&/^[0-9a-f]{64}$/.test(prep.identity)&&prep.format===INTENT_FORMAT
   &&prep.messageDigest===a.messageDigest&&prep.blockhash===a.blockhash&&prep.lastValidBlockHeight===a.lastValidBlockHeight
   &&prep.observedBlockHeight===a.preparedAtBlockHeight,"execution_identity_mismatch");
  return freeze(structuredClone({...v,intent:{...i,preparation:prep}}) as CorrelationSnapshot);
 }catch{throw new OfflineReadError("execution_identity_mismatch");}
}
function provenance(plan:OfflineReadPlan,input:unknown,sourceId:string,eventId:string,min:string):SourceProvenance{
 const p=protocol(plan,input,{kind:"missing",reason:"history_missing"}).provenance;
 check(p.sourceId===sourceId&&p.eventId===eventId&&p.requestId===plan.requestId&&BigInt(p.contextSlot)>=BigInt(min),"source_context_mismatch");
 for(const old of plan.priorEvents)if(old.sourceId===sourceId)check(BigInt(p.contextSlot)>=BigInt(old.contextSlot),"stale_source_context");
 return p;
}
function sourceObservation(plan:OfflineReadPlan,input:unknown):OfflineSourceObservation {
 const b=record(input,["sourceId","eventId","status","transaction","accounts","interruption"]);
 reference(b.sourceId);reference(b.eventId);
 check(plan.events.some(e=>e.sourceId===b.sourceId&&e.eventId===b.eventId),"unexpected_source_event");
 check(b.interruption===null||["before_read","status_timeout","status_exception","transaction_timeout","transaction_exception","accounts_timeout","accounts_exception"].includes(b.interruption));
 let accepted:ObservationContract|null=null,consistent=false,matching=false,status:StatusClaim|null=null,accountCommitment:Finality|null=null;
 const finish=(classification:ReconciliationClassification,...reasons:string[]):OfflineSourceObservation=>freeze({
  sourceId:b.sourceId,eventId:b.eventId,classification,reasons,protocol:accepted,transactionEvidenceConsistent:consistent,
  rawFixtureAccountsMatch:matching,evidenceDigest:protocolDataDigest({sourceId:b.sourceId,eventId:b.eventId,classification,reasons,
   protocol:accepted,transactionEvidenceConsistent:consistent,rawFixtureAccountsMatch:matching,status,accountCommitment}),status,accountCommitment});
 if(plan.priorEvents.some(e=>e.sourceId===b.sourceId&&e.eventId===b.eventId))return finish("conflicting_evidence","duplicate_event_identity");
 try{
  if(b.interruption!==null){
   const stage=b.interruption.split("_")[0];
   check(stage==="before"||stage==="status"
    ? b.status===null&&b.transaction===null&&b.accounts===null
    : stage==="transaction"?b.status!==null&&b.transaction===null&&b.accounts===null
    : b.status!==null&&b.transaction!==null&&b.accounts===null,"inconsistent_read_interruption");
  }
  if(b.status===null)return finish("missing_evidence",b.interruption??"status_not_read");
  const first=record(b.status,["kind","provenance","currentBlockHeight","evidence"]);check(first.kind==="status_read");
  let p=provenance(plan,first.provenance,b.sourceId,b.eventId,plan.minimumContextSlot);
  // Reuse the canonical snapshot validator for lossless block-height validation.
  validateObservation({version:plan.admission.version,kind:"offline_observation_data",senderAdmissionId:plan.submission.senderAdmissionId,
   submissionDigest:protocolDataDigest(plan.submission),operationKey:plan.admission.operationKey,provenance:p,
   transaction:first.evidence,accounts:EMPTY},plan.submission,plan.admission,plan.anchor,{...plan.snapshot,blockHeight:first.currentBlockHeight});
  check(BigInt(first.currentBlockHeight)>=BigInt(plan.anchor.preparedAtBlockHeight),"stale_block_height");
  accepted=protocol(plan,p,first.evidence);
  if(accepted.transaction.kind==="conflict")return finish("conflicting_evidence","source_reported_conflict");
  if(accepted.transaction.kind==="missing")return finish("missing_evidence",accepted.transaction.reason);
  status=accepted.transaction;check(status.observedBlockHeight===first.currentBlockHeight,"height_context_mismatch");
  if(b.transaction===null)return finish("incomplete_evidence",b.interruption??"transaction_not_read");
  if(tag(b.transaction,"kind")==="transaction_missing"){
   const v=record(b.transaction,["kind","provenance","reason"]);provenance(plan,v.provenance,b.sourceId,b.eventId,p.contextSlot);
   check(v.reason==="null_lookup"||v.reason==="history_missing");
   return finish("incomplete_evidence",v.reason);
  }
  const tx=record(b.transaction,["kind","provenance","commitment","transactionId","wireBase64","wireDigest","transactionSlot","outcome","errorCode"]);
  check(tx.kind==="transaction_read"&&rank(tx.commitment)>0&&tx.transactionId===plan.submission.transactionId
   &&tx.wireBase64===plan.submission.wireBase64&&tx.wireDigest===plan.submission.wireDigest,"transaction_identity_mismatch");
  p=provenance(plan,tx.provenance,b.sourceId,b.eventId,p.contextSlot);
  // The canonical protocol validator verifies actual complete wire/signatures/message identity again.
  const detailStatus:StatusClaim={...status,finality:tx.commitment,outcome:tx.outcome,errorCode:tx.errorCode,
   transactionSlot:tx.transactionSlot,contextSlot:p.contextSlot};
  protocol(plan,p,detailStatus);consistent=true;
  if(status.outcome!==detailStatus.outcome||status.errorCode!==detailStatus.errorCode||status.transactionSlot!==detailStatus.transactionSlot){
   accepted=protocol(plan,p,{kind:"conflict",left:status,right:detailStatus});
   return finish("conflicting_evidence",status.finality==="finalized"&&detailStatus.finality==="finalized"?"contradictory_terminal_evidence":"transaction_detail_conflict");
  }
  if(rank(detailStatus.finality)<rank(status.finality))return finish("reconciliation_required","commitment_regression");
  // Preserve the weaker corroborated commitment; a later stronger read cannot rewrite the earlier read.
  accepted=protocol(plan,p,status);
  if(status.outcome==="failure")return finish(status.finality==="finalized"?"finalized_failure":status.finality==="confirmed"?"confirmed_observation":"provisional_observation","execution_failure_claim");
  if(b.accounts===null)return finish(status.finality==="finalized"?"finalized_success_candidate":status.finality==="confirmed"?"confirmed_observation":"provisional_observation",
   b.interruption??"accounts_not_read");
  if(tag(b.accounts,"kind")==="accounts_missing"){
   const v=record(b.accounts,["kind","provenance","reason"]);provenance(plan,v.provenance,b.sourceId,b.eventId,p.contextSlot);
   check(v.reason==="missing_accounts"||v.reason==="history_missing");
   return finish(status.finality==="finalized"?"finalized_success_candidate":"incomplete_evidence",v.reason);
  }
  const ar=record(b.accounts,["kind","provenance","commitment","accounts"]);check(ar.kind==="accounts_read"&&rank(ar.commitment)>0);
  p=provenance(plan,ar.provenance,b.sourceId,b.eventId,p.contextSlot);
  check(BigInt(p.contextSlot)>=BigInt(status.transactionSlot),"stale_account_context");
  accountCommitment=ar.commitment;
  const comparison=compareOfflineAccounts(ar.accounts,plan.anchor,p.contextSlot);
  accepted=protocol(plan,p,status,comparison.evidence);
  if(comparison.kind==="mismatched_fixture")return finish("account_state_mismatch",comparison.reason);
  if(comparison.kind==="insufficient_fixture")return finish(status.finality==="finalized"?"finalized_success_candidate":"incomplete_evidence",comparison.reason);
  matching=true;
  if(status.finality==="processed")return finish("provisional_observation","processed_only");
  if(status.finality==="confirmed")return finish("confirmed_observation","confirmed_only");
  if(ar.commitment!=="finalized")return finish("finalized_success_candidate","accounts_not_finalized");
  return finish("matching_finalized_candidate",comparison.reason);
 }catch(error){
  const code=error instanceof OfflineReadError?error.code:"invalid_source_result";
  return finish("incomplete_evidence",code);
 }
}
/** Pure revalidation of raw offline read bundles. No SQL writes, source trust tokens or operational success. */
export function reconcileOfflineReadEvidence(planInput:unknown,bundlesInput:unknown,beforeInput:unknown,afterInput:unknown):OfflineReconciliation{
 const plan=validateOfflineReadPlan(planInput),before=correlateExecution(plan,beforeInput),after=correlateExecution(plan,afterInput);
 const bundles=list(bundlesInput,8);
 const observations:OfflineSourceObservation[]=[],seen=new Set<string>();
 const reasons:string[]=[];
 for(const raw of bundles){
  const b=record(raw,["sourceId","eventId","status","transaction","accounts","interruption"]);
  const k=eventKey(b.sourceId,b.eventId);
  if(seen.has(k)){reasons.push("duplicate_event_identity");continue;}seen.add(k);
  observations.push(sourceObservation(plan,b));
 }
 const contextChanged=before.revision!==plan.attempt.revision||after.revision!==before.revision
  ||protocolDataDigest(before)!==protocolDataDigest(after);
 if(contextChanged)reasons.push("execution_context_changed");
 for(const e of plan.events)if(!observations.some(o=>o.sourceId===e.sourceId&&o.eventId===e.eventId))reasons.push("configured_source_missing");
 let classification:ReconciliationClassification="reconciliation_required";
 const facts=observations.flatMap(o=>o.status?[o.status]:[]);
 if(facts.some(s=>s.outcome==="failure"))reasons.push("execution_failure_claim");
 const factConflict=facts.some((a,n)=>facts.slice(n+1).some(b=>a.outcome!==b.outcome||a.errorCode!==b.errorCode||a.transactionSlot!==b.transactionSlot));
 if(reasons.includes("duplicate_event_identity")||factConflict||observations.some(o=>o.classification==="conflicting_evidence")){
  classification="conflicting_evidence";reasons.push(factConflict?"cross_source_transaction_conflict":"retained_source_conflict");
 }else if(contextChanged||reasons.includes("configured_source_missing"))classification="reconciliation_required";
 else if(observations.some(o=>o.classification==="account_state_mismatch"))classification="account_state_mismatch";
 else if(observations.length&&observations.every(o=>o.classification==="missing_evidence"))classification="missing_evidence";
 else if(observations.some(o=>["missing_evidence","incomplete_evidence","reconciliation_required"].includes(o.classification)))classification="reconciliation_required";
 else if(observations.length){
  const min=Math.min(...facts.map(s=>rank(s.finality)));
  if(min===1)classification="provisional_observation";
  else if(min===2)classification="confirmed_observation";
  else if(observations.every(o=>o.classification==="finalized_failure"))classification="finalized_failure";
  else if(observations.every(o=>o.classification==="matching_finalized_candidate")){
   // Context slots may advance across providers; compare raw account content digests instead.
   const accountSets=observations.map(o=>(o.protocol!.accounts as Extract<AccountEvidence,{kind:"matching_candidate"}>).accountSetDigest);
   classification=new Set(accountSets).size===1?"matching_finalized_candidate":"conflicting_evidence";
   if(new Set(accountSets).size!==1)reasons.push("cross_source_account_conflict");
  }else classification="finalized_success_candidate";
 }
 return freeze({mode:"offline_mock",attempt:plan.attempt,operationKey:plan.admission.operationKey,transactionId:plan.submission.transactionId,
  classification,reasons,observations,rpcAuthenticated:false,onChainStateVerified:false,operationalStateMutationAuthorized:false,
  signingAuthorization:"not_granted",submissionAuthorized:false,retryAuthorized:false,reservationReleaseAuthorized:false,
  settlementPermission:false,operationalUncertaintyClearAuthorized:false,reconciliationRequired:true});
}
export function expectedAddresses(plan:OfflineReadPlan){
 const b=plan.anchor.bindings;
 return freeze({internship:b.internship,milestone:b.milestone,submission:b.submission,completion:deriveCompletion(b.milestone)[0].toBase58()});
}
