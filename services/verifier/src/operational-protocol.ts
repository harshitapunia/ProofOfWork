/** Pure, offline data validation. These APIs cannot authenticate or authorize an external effect. */
import { createHash, createPublicKey, verify } from "node:crypto";
import { PublicKey, Transaction } from "@solana/web3.js";
import { assertOwnDataFields, validateJobBindings, type JobBindings } from "@proofwork/lifecycle";
import { buildAttestMilestoneInstruction } from "./attestation.js";
import { key } from "./commitments.js";
import { PROTOCOL_VERSION, PROTOCOL_POLICY, type ProtocolAnchor, type ProtocolSnapshot,
  type AdmissionRequest, type CustodyRoleRequest, type SigningOutcome, type SubmissionRequest,
  type SubmissionOutcome, type ObservationContract, type StatusClaim, type AccountEvidence,
  type SourceProvenance, type TransactionEvidence, type ValidatedProtocolData } from "./operational-protocol-types.js";
export * from "./operational-protocol-types.js";

export class ProtocolDataError extends Error { constructor() { super("invalid_offline_protocol_data"); } }
function requireData(ok: unknown): asserts ok { if (!ok) throw new ProtocolDataError(); }
const hash = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
const MAX = 0xffffffffffffffffn;
function fields(value: unknown, keys: readonly string[]): Record<string, any> {
  try {
    requireData(value!==null && typeof value==="object" && [Object.prototype,null].includes(Object.getPrototypeOf(value)));
    assertOwnDataFields(value,keys);
    // Read only proven own DATA properties, never invoke accessors or caller toJSON.
    return Object.fromEntries(keys.map(k=>[k,Object.getOwnPropertyDescriptor(value,k)!.value]));
  } catch { throw new ProtocolDataError(); }
}
function tag(value: unknown,k: string): unknown {
  try { const d=Object.getOwnPropertyDescriptor(value,k);requireData(d && Object.hasOwn(d,"value"));return d.value; }
  catch { throw new ProtocolDataError(); }
}
function numberText(v: unknown): asserts v is string {
  requireData(typeof v==="string" && /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v)<=MAX);
}
function digest(v: unknown): asserts v is string { requireData(typeof v==="string" && /^[0-9a-f]{64}$/.test(v) && /[1-9a-f]/.test(v)); }
function reference(v: unknown): asserts v is string { requireData(typeof v==="string" && /^[A-Za-z0-9_-]{1,80}$/.test(v)); }
function uuid(v: unknown): asserts v is string {
  requireData(typeof v==="string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v) && /[1-9a-f]/.test(v));
}
function publicKey(v: unknown,curve=false): asserts v is string {
  try { requireData(typeof v==="string" && v.length>=32 && v.length<=44); const p=key(v);requireData(!p.equals(PublicKey.default) && (!curve || PublicKey.isOnCurve(p.toBytes()))); }
  catch { throw new ProtocolDataError(); }
}
function base64(v: unknown,size?: number): Buffer {
  requireData(typeof v==="string" && v.length>0 && v.length<=1644);
  const b=Buffer.from(v,"base64");requireData(b.toString("base64")===v && (size===undefined || b.length===size));return b;
}
function bindings(v: unknown): JobBindings {
  try {
    requireData(v!==null && typeof v==="object");
    requireData(Object.values(Object.getOwnPropertyDescriptors(v)).every(d=>Object.hasOwn(d,"value") && typeof d.value==="string"));
    return validateJobBindings(v as JobBindings);
  } catch { throw new ProtocolDataError(); }
}
function freeze<T>(v:T):T {
  if(v!==null && typeof v==="object"){for(const x of Object.values(v))freeze(x);Object.freeze(v);}
  return v;
}
function result<T>(data:T):ValidatedProtocolData<T> {
  return freeze({kind:"validated_offline_contract_data",data,operationalAuthorization:false,authenticated:false,
    retryAuthorized:false,reservationReleaseAuthorized:false});
}
function arrayData(v:unknown,max:number):unknown[] {
  requireData(Array.isArray(v) && v.length<=max && Reflect.ownKeys(v).length===v.length+1);
  const d=Object.getOwnPropertyDescriptors(v),copy:unknown[]=[];
  for(let n=0;n<v.length;n++){const e=d[String(n)];requireData(e && e.enumerable && Object.hasOwn(e,"value"));copy.push(e.value);}
  return copy;
}
function canonical(v:unknown,n=0):unknown {
  requireData(n<12);
  if(v===null || typeof v==="boolean")return v;
  if(typeof v==="string"){requireData(v.length<=8192);return v;}
  if(typeof v==="number"){requireData(Number.isSafeInteger(v));return v;}
  requireData(typeof v==="object");
  if(Array.isArray(v)){
    return arrayData(v,32).map(x=>canonical(x,n+1));
  }
  const keys=Reflect.ownKeys(v);requireData(keys.length<=128 && keys.every(k=>typeof k==="string"));
  const o=fields(v,keys as string[]);
  return Object.fromEntries(Object.keys(o).sort().map(k=>[k,canonical(o[k],n+1)]));
}
/** Canonical digest for DATA integrity/cross-references only. Anyone can compute it; it proves no approval. */
export function protocolDataDigest(value:unknown):string {
  try {return hash(JSON.stringify(["proofwork:offline-protocol-data:v1",canonical(value)]));}
  catch {throw new ProtocolDataError();}
}
const ANCHOR=["bindings","jobId","jobIdentity","intentId","intentIdentity","feePayer","messageDigest","snapshotDigest",
  "blockhash","lastValidBlockHeight","preparedAtBlockHeight","issuedAtUnixMs","deadlineUnixMs","epoch","policyVersion",
  "operatorApprovalRef","verifierApprovalRef","payerApprovalRef","submissionApprovalRef"];
const ADMISSION=["version","kind","admissionId","operationKey","jobId","jobIdentity","intentId","intentIdentity","bindings",
  "feePayer","messageDigest","messageBase64","snapshotDigest","policyVersion","issuedAtUnixMs","deadlineUnixMs","blockhash",
  "lastValidBlockHeight","preparedAtBlockHeight","operatorApprovalRef","epoch"];
const ROLE=["version","kind","requestId","admissionId","admissionDigest","operationKey","role","publicKey","messageDigest",
  "messageBase64","deadlineUnixMs","epoch","roleApprovalRef"];
const SIGNING=["version","kind","state","requestId","requestDigest","admissionId","operationKey","role","publicKey","messageDigest"];
const SUBMISSION=["version","kind","senderAdmissionId","admissionId","admissionDigest","operationKey","messageDigest",
  "wireBase64","wireDigest","transactionId","submissionApprovalRef","deadlineUnixMs","epoch"];
function context(input:unknown, clock:unknown) {
  const a=fields(input,ANCHOR),c=fields(clock,["nowUnixMs","blockHeight","currentEpoch","minRemainingBlockHeights","sourceIds"]);
  a.bindings=bindings(a.bindings);
  for(const k of ["jobId","intentId"])uuid(a[k]);
  for(const k of ["jobIdentity","intentIdentity","messageDigest","snapshotDigest"])digest(a[k]);
  publicKey(a.feePayer,true);publicKey(a.blockhash);
  requireData(![a.bindings.verifier,a.bindings.programId,a.bindings.internship,a.bindings.milestone,a.bindings.submission].includes(a.feePayer));
  for(const k of ["lastValidBlockHeight","preparedAtBlockHeight","issuedAtUnixMs","deadlineUnixMs","epoch"])numberText(a[k]);
  for(const k of ["nowUnixMs","blockHeight","currentEpoch","minRemainingBlockHeights"])numberText(c[k]);
  requireData(BigInt(c.minRemainingBlockHeights)>0n);
  requireData(BigInt(a.lastValidBlockHeight)>BigInt(a.preparedAtBlockHeight) && BigInt(a.issuedAtUnixMs)>0n
    && BigInt(a.deadlineUnixMs)>BigInt(a.issuedAtUnixMs) && BigInt(a.deadlineUnixMs)-BigInt(a.issuedAtUnixMs)<=30000n);
  requireData(a.policyVersion===PROTOCOL_POLICY);
  for(const k of ["operatorApprovalRef","verifierApprovalRef","payerApprovalRef","submissionApprovalRef"])reference(a[k]);
  requireData(Array.isArray(c.sourceIds) && c.sourceIds.length>0 && c.sourceIds.length<=16);
  // Array entries must be dense own data properties; copy before any use.
  const descriptors=Object.getOwnPropertyDescriptors(c.sourceIds);
  requireData(Reflect.ownKeys(c.sourceIds).length===c.sourceIds.length+1);
  const sources:string[]=[];
  for(let n=0;n<c.sourceIds.length;n++){const d=descriptors[String(n)];requireData(d && Object.hasOwn(d,"value"));reference(d.value);sources.push(d.value);}
  requireData(new Set(sources).size===sources.length);c.sourceIds=Object.freeze(sources);
  return {anchor:freeze(a as unknown as ProtocolAnchor),clock:freeze(c as unknown as ProtocolSnapshot)};
}
function admission(input:unknown,a:ProtocolAnchor,c:ProtocolSnapshot,fresh:boolean):AdmissionRequest {
  const v=fields(input,ADMISSION);
  requireData(v.version===PROTOCOL_VERSION && v.kind==="offline_admission_data");uuid(v.admissionId);
  v.bindings=bindings(v.bindings);requireData(protocolDataDigest(v.bindings)===protocolDataDigest(a.bindings));
  for(const k of ANCHOR.filter(k=>!["bindings","verifierApprovalRef","payerApprovalRef","submissionApprovalRef"].includes(k)))
    requireData(v[k]===a[k as keyof ProtocolAnchor]);
  const b=a.bindings;
  requireData(v.operationKey==="devnet:"+b.programId+":"+b.milestone);
  const message=base64(v.messageBase64);requireData(message.length<=1232 && hash(message)===a.messageDigest);
  const expected=new Transaction({feePayer:new PublicKey(a.feePayer),recentBlockhash:a.blockhash})
    .add(buildAttestMilestoneInstruction({...b,snapshot:a.snapshotDigest},b.verifier)).serializeMessage();
  requireData(expected.equals(message));
  if(fresh)requireData(BigInt(c.nowUnixMs)>=BigInt(a.issuedAtUnixMs) && BigInt(c.nowUnixMs)<BigInt(a.deadlineUnixMs)
    && BigInt(c.blockHeight)>=BigInt(a.preparedAtBlockHeight) && BigInt(a.lastValidBlockHeight)-BigInt(c.blockHeight)>=BigInt(c.minRemainingBlockHeights)
    && c.currentEpoch===a.epoch);
  else requireData(BigInt(c.currentEpoch)>=BigInt(a.epoch)); // Historical evidence is not a fresh action.
  return freeze(v as unknown as AdmissionRequest);
}
function role(input:unknown,d:AdmissionRequest,a:ProtocolAnchor):CustodyRoleRequest {
  const v=fields(input,ROLE);requireData(v.version===PROTOCOL_VERSION);uuid(v.requestId);
  requireData(v.role==="verifier" || v.role==="fee_payer");
  requireData(v.kind===(v.role==="verifier"?"offline_verifier_request":"offline_fee_payer_request")
    && v.publicKey===(v.role==="verifier"?a.bindings.verifier:a.feePayer)
    && v.roleApprovalRef===(v.role==="verifier"?a.verifierApprovalRef:a.payerApprovalRef));
  requireData(v.admissionId===d.admissionId && v.admissionDigest===protocolDataDigest(d) && v.operationKey===d.operationKey
    && v.messageDigest===d.messageDigest && v.messageBase64===d.messageBase64 && v.deadlineUnixMs===d.deadlineUnixMs && v.epoch===d.epoch);
  return freeze(v as unknown as CustodyRoleRequest);
}
function signing(input:unknown,r:CustodyRoleRequest):SigningOutcome {
  const state=tag(input,"state");
  const extra=state==="signature_observed"?["receiptRef","signatureBase64"]:state==="admission_accepted"?["receiptRef"]:
    state==="signing_uncertain"?["reason","receiptRef"]:state==="not_admitted"||state==="signing_rejected"?["reason"]:null;
  requireData(extra);const v=fields(input,[...SIGNING,...extra]);
  requireData(v.version===PROTOCOL_VERSION && v.kind==="offline_signing_outcome" && v.requestId===r.requestId
    && v.requestDigest===protocolDataDigest(r) && v.admissionId===r.admissionId && v.operationKey===r.operationKey
    && v.role===r.role && v.publicKey===r.publicKey && v.messageDigest===r.messageDigest);
  if("reason" in v)reference(v.reason);
  if("receiptRef" in v && !(state==="signing_uncertain" && v.receiptRef===null))reference(v.receiptRef);
  if(state==="signature_observed"){
    const pub=createPublicKey({format:"der",type:"spki",key:Buffer.concat([Buffer.from("302a300506032b6570032100","hex"),new PublicKey(r.publicKey).toBuffer()])});
    requireData(verify(null,base64(r.messageBase64),pub,base64(v.signatureBase64,64)));
  }
  return freeze(v as unknown as SigningOutcome);
}
/** No transport/signer interface is exported. Only validation of public offline data. */
export function validateAdmission(input:unknown,anchor:unknown,snapshot:unknown):ValidatedProtocolData<AdmissionRequest> {
  try {const x=context(anchor,snapshot);return result(admission(input,x.anchor,x.clock,true));}catch{throw new ProtocolDataError();}
}
export function validateRoleRequest(input:unknown,admissionData:unknown,anchor:unknown,snapshot:unknown):ValidatedProtocolData<CustodyRoleRequest> {
  try {const x=context(anchor,snapshot),d=admission(admissionData,x.anchor,x.clock,true);return result(role(input,d,x.anchor));}catch{throw new ProtocolDataError();}
}
export function validateSigningOutcome(input:unknown,roleData:unknown,admissionData:unknown,anchor:unknown,snapshot:unknown):ValidatedProtocolData<SigningOutcome> {
  try {const x=context(anchor,snapshot),d=admission(admissionData,x.anchor,x.clock,false);return result(signing(input,role(roleData,d,x.anchor)));}catch{throw new ProtocolDataError();}
}
function transactionId(tx:Transaction):string {
  requireData(tx.signature);let n=BigInt("0x"+tx.signature.toString("hex")),s="";
  const alphabet="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  while(n){s=alphabet[Number(n%58n)]!+s;n/=58n;}
  for(const b of tx.signature){if(b!==0)break;s="1"+s;}return s;
}
function submission(input:unknown,d:AdmissionRequest,a:ProtocolAnchor):SubmissionRequest {
  const v=fields(input,SUBMISSION);requireData(v.version===PROTOCOL_VERSION && v.kind==="offline_first_submission_data");uuid(v.senderAdmissionId);
  requireData(v.admissionId===d.admissionId && v.admissionDigest===protocolDataDigest(d) && v.operationKey===d.operationKey
    && v.messageDigest===d.messageDigest && v.submissionApprovalRef===a.submissionApprovalRef
    && v.deadlineUnixMs===d.deadlineUnixMs && v.epoch===d.epoch);
  digest(v.wireDigest);const wire=base64(v.wireBase64);requireData(wire.length<=1232 && hash(wire)===v.wireDigest);
  const tx=Transaction.from(wire);requireData(tx.serialize({requireAllSignatures:true,verifySignatures:true}).equals(wire)
    && tx.signatures.length===2 && tx.signatures[0]!.publicKey.toBase58()===a.feePayer
    && tx.signatures[1]!.publicKey.toBase58()===a.bindings.verifier && tx.verifySignatures(true)
    && tx.serializeMessage().equals(base64(d.messageBase64)) && transactionId(tx)===v.transactionId);
  return freeze(v as unknown as SubmissionRequest);
}
export function validateSubmission(input:unknown,admissionData:unknown,roleRequests:readonly unknown[],outcomes:readonly unknown[],
  anchor:unknown,snapshot:unknown):ValidatedProtocolData<SubmissionRequest> {
  try {
    const x=context(anchor,snapshot),d=admission(admissionData,x.anchor,x.clock,true);
    requireData(Array.isArray(roleRequests) && roleRequests.length===2 && Array.isArray(outcomes) && outcomes.length===2);
    const roles=arrayData(roleRequests,2).map(r=>role(r,d,x.anchor));requireData(roles[0]!.role==="verifier" && roles[1]!.role==="fee_payer" && roles[0]!.requestId!==roles[1]!.requestId);
    const states=arrayData(outcomes,2).map((s,n)=>signing(s,roles[n]!));requireData(states.every(s=>s.state==="signature_observed"));
    const v=submission(input,d,x.anchor),tx=Transaction.from(base64(v.wireBase64));
    for(const [n,s] of states.entries())requireData(s.state==="signature_observed" && tx.signatures[n===0?1:0]!.signature!.equals(base64(s.signatureBase64,64)));
    return result(v);
  }catch{throw new ProtocolDataError();}
}
export function validateSubmissionOutcome(input:unknown,submissionData:unknown,admissionData:unknown,anchor:unknown,snapshot:unknown):ValidatedProtocolData<SubmissionOutcome> {
  try {
    const x=context(anchor,snapshot),d=admission(admissionData,x.anchor,x.clock,false),s=submission(submissionData,d,x.anchor);
    const v=fields(input,["version","kind","state","senderAdmissionId","submissionDigest","transactionId","acknowledgmentTransactionId","reason"]);
    requireData(v.version===PROTOCOL_VERSION && v.kind==="offline_submission_outcome" && v.senderAdmissionId===s.senderAdmissionId
      && v.submissionDigest===protocolDataDigest(s) && v.transactionId===s.transactionId
      && ["not_admitted","intent_recorded","invocation_potentially_occurred","acknowledgment_received","submission_uncertain"].includes(v.state));
    requireData(v.state==="acknowledgment_received"?v.acknowledgmentTransactionId===s.transactionId && v.reason===null:
      v.acknowledgmentTransactionId===null);
    if(v.reason!==null)reference(v.reason);
    if(v.state==="not_admitted"||v.state==="submission_uncertain")requireData(v.reason!==null);
    return result(v as unknown as SubmissionOutcome);
  }catch{throw new ProtocolDataError();}
}

const STATUS=["kind","transactionId","messageDigest","wireDigest","finality","outcome","errorCode","transactionSlot","contextSlot","observedBlockHeight"];
function status(input:unknown,s:SubmissionRequest):StatusClaim {
  const v=fields(input,STATUS);
  requireData(v.kind==="status_claim" && v.transactionId===s.transactionId && v.messageDigest===s.messageDigest && v.wireDigest===s.wireDigest
    && ["processed","confirmed","finalized"].includes(v.finality) && ["success","failure"].includes(v.outcome));
  requireData(v.outcome==="success"?v.errorCode===null:v.errorCode!==null);if(v.errorCode!==null)reference(v.errorCode);
  for(const k of ["transactionSlot","contextSlot","observedBlockHeight"])numberText(v[k]);
  requireData(BigInt(v.contextSlot)>=BigInt(v.transactionSlot));
  return freeze(v as unknown as StatusClaim);
}
function account(input:unknown,a:ProtocolAnchor):AccountEvidence {
  if(tag(input,"kind")!=="matching_candidate"){
    const v=fields(input,["kind","reason"]);requireData(["not_supplied","incomplete","mismatched"].includes(v.kind));reference(v.reason);
    return freeze(v as unknown as AccountEvidence);
  }
  const v=fields(input,["kind","programId","milestone","submission","student","verifier","requirementsHash","evidenceHash",
    "milestoneStatus","submittedAt","verifiedAt","contextSlot","accountSetDigest","completionDigest"]);
  for(const k of ["programId","milestone","submission","student","verifier","requirementsHash","evidenceHash"] as const)
    requireData(v[k]===a.bindings[k]);
  requireData(v.milestoneStatus==="Verified" || v.milestoneStatus==="Settled");
  for(const k of ["submittedAt","verifiedAt","contextSlot"])numberText(v[k]);
  requireData(BigInt(v.submittedAt)>0n && BigInt(v.verifiedAt)>=BigInt(v.submittedAt) && BigInt(v.verifiedAt)<=0x7fffffffffffffffn);
  digest(v.accountSetDigest);
  if(v.milestoneStatus==="Settled")digest(v.completionDigest);else requireData(v.completionDigest===null);
  // Metadata shape/consistency only: no RPC, raw account decoding or authentication occurs here.
  return freeze(v as unknown as AccountEvidence);
}
export function validateObservation(input:unknown,submissionData:unknown,admissionData:unknown,anchor:unknown,snapshot:unknown):ValidatedProtocolData<ObservationContract> {
  try {
    const x=context(anchor,snapshot),d=admission(admissionData,x.anchor,x.clock,false),s=submission(submissionData,d,x.anchor);
    const v=fields(input,["version","kind","senderAdmissionId","submissionDigest","operationKey","provenance","transaction","accounts"]);
    requireData(v.version===PROTOCOL_VERSION && v.kind==="offline_observation_data" && v.senderAdmissionId===s.senderAdmissionId
      && v.submissionDigest===protocolDataDigest(s) && v.operationKey===s.operationKey);
    const p=fields(v.provenance,["kind","sourceId","cluster","genesisHash","requestId","eventId","contextSlot"]);
    requireData(p.kind==="offline_fixture" || p.kind==="unverified_reference");reference(p.sourceId);reference(p.requestId);reference(p.eventId);
    requireData(x.clock.sourceIds.includes(p.sourceId) && p.cluster==="devnet" && p.genesisHash===x.anchor.bindings.genesisHash);
    numberText(p.contextSlot);v.provenance=freeze(p as unknown as SourceProvenance);
    const type=tag(v.transaction,"kind");let statuses:StatusClaim[]=[];
    if(type==="status_claim"){v.transaction=status(v.transaction,s);statuses=[v.transaction];}
    else if(type==="missing"){
      const e=fields(v.transaction,["kind","reason"]);requireData(["null_lookup","history_missing","rpc_timeout"].includes(e.reason));v.transaction=freeze(e);
    }else{
      const e=fields(v.transaction,["kind","left","right"]);requireData(e.kind==="conflict");
      e.left=status(e.left,s);e.right=status(e.right,s);
      requireData(protocolDataDigest(e.left)!==protocolDataDigest(e.right));
      // At least one factual outcome/error/slot difference; normal finality strengthening is not a conflict.
      requireData(e.left.outcome!==e.right.outcome || e.left.errorCode!==e.right.errorCode || e.left.transactionSlot!==e.right.transactionSlot);
      statuses=[e.left,e.right];v.transaction=freeze(e as unknown as TransactionEvidence);
    }
    v.accounts=account(v.accounts,x.anchor);
    for(const e of statuses){
      requireData(BigInt(p.contextSlot)>=BigInt(e.contextSlot));
      if(v.accounts.kind==="matching_candidate")requireData(BigInt(v.accounts.contextSlot)>=BigInt(e.transactionSlot));
    }
    if(v.accounts.kind==="matching_candidate")requireData(BigInt(p.contextSlot)>=BigInt(v.accounts.contextSlot));
    return result(v as unknown as ObservationContract);
  }catch{throw new ProtocolDataError();}
}
export type ObservationClassification = "missing_evidence" | "conflicting_evidence" | "provisional_claim"
  | "finalized_failure_claim" | "awaiting_account_evidence" | "matching_finalized_claim";
/** A label for a revalidated data contract, never authenticated success or permission to clear uncertainty. */
export function classifyObservation(input:unknown,submissionData:unknown,admissionData:unknown,anchor:unknown,snapshot:unknown):
  Readonly<{classification:ObservationClassification;operationalAuthorization:false;authenticated:false;uncertaintyClearAuthorized:false}> {
  const v=validateObservation(input,submissionData,admissionData,anchor,snapshot).data;
  const t=v.transaction;
  const classification:ObservationClassification=t.kind==="missing"?"missing_evidence":t.kind==="conflict"?"conflicting_evidence":
    t.finality!=="finalized"?"provisional_claim":t.outcome==="failure"?"finalized_failure_claim":
    v.accounts.kind!=="matching_candidate"?"awaiting_account_evidence":"matching_finalized_claim";
  return Object.freeze({classification,operationalAuthorization:false,authenticated:false,uncertaintyClearAuthorized:false});
}
