import {PublicKey} from "@solana/web3.js";
import {open} from "node:fs/promises";
import {constants} from "node:fs";
import {isAbsolute} from "node:path";
/** Thin application admission into the existing verifier and v5 job ledger. No signing or submission. */
import { createHash } from "node:crypto";
import { LifecycleStore, type VerificationJob } from "@proofwork/lifecycle";
import { PROGRAM_ID, SETTLEMENT_DEVNET_GENESIS, deriveSubmission } from "@proofwork/finance-client";
import { WorkflowStateReader } from "./workflow-state.js";
import type { Request } from "./service.js";
import {DurableOfflineCoordinator,type OfflineMockReceipt} from "./durable-offline-coordinator.js";
import { parseManifest } from "./manifest.js";
import { evidenceHash } from "./commitments.js";
import { WalletAuthError } from "./wallet-sessions.js";

/** Trusted server-local contributor admission; never accept a credential or adapter from HTTP JSON.
 * The returned credential must belong to the independently authenticated GitHub contributor.
 * VerifierService still verifies that identity against contributorId; wallet login is insufficient.
 */
export const LIVE_VERIFIER_DISPATCH=false;
export type ContributorAdmission = (binding: Readonly<Pick<Request,"milestone"|"student"|"repositoryId"|"contributorId"|"commit">>) => Promise<string | null>;
export interface WorkflowVerificationJob {
 kind:"workflow_verification_job";jobId:string;milestone:string;state:string;verificationOutcome:"none"|"passed"|"rejected";
 mode:"offline-test-only";persisted:true;attestation:"not_authorized";rewardPayment:"not_established";retryAuthorized:false;
}
export class WorkflowVerification {
 readonly #tasks=new Map<string,Promise<void>>();
 constructor(private readonly reader:WorkflowStateReader,private readonly store:LifecycleStore,
  private readonly coordinator:DurableOfflineCoordinator,private readonly admit:ContributorAdmission,private readonly prepared?:(receipt:OfflineMockReceipt)=>void) {
  if(!(reader instanceof WorkflowStateReader) || !(store instanceof LifecycleStore) || !(coordinator instanceof DurableOfflineCoordinator) || reader.provenance!=="offline_fixture" || (prepared!==undefined&&typeof prepared!=="function") || typeof admit!=="function")throw new WalletAuthError("invalid_verification_configuration",503);
 }
 private view(job:VerificationJob):WorkflowVerificationJob{return {kind:"workflow_verification_job",jobId:job.jobId,milestone:job.bindings.milestone,
  state:job.state,verificationOutcome:job.verificationOutcome,mode:"offline-test-only",persisted:true,attestation:"not_authorized",rewardPayment:"not_established",retryAuthorized:false};}
 async dispatch(input:unknown,wallet:string,assertSession:()=>void):Promise<WorkflowVerificationJob>{
  assertSession();const copy=structuredClone(input),handoff=await this.reader.handoff(copy,wallet);assertSession();
  if(this.#tasks.size>=4)throw new WalletAuthError("verification_capacity",503);
  const request=handoff.request;
  const admission=Object.freeze({milestone:request.milestone,student:request.student,repositoryId:request.repositoryId,contributorId:request.contributorId,commit:request.commit});
  let timer:ReturnType<typeof setTimeout>|undefined,token:string|null;
  try{token=await Promise.race([this.admit(admission),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new WalletAuthError("verification_admission_unavailable",503)),5000);})]);}
  catch{throw new WalletAuthError("verification_admission_unavailable",503);}
  finally{clearTimeout(timer);}
  assertSession();
  if(typeof token!=="string" || !token || token.length>1024 || /[\r\n]/.test(token))throw new WalletAuthError("github_contributor_admission_required",403);
  // Reobserve after credential admission; request/proposal contents alone never create a job.
  await this.reader.handoff(copy,wallet);assertSession();
  const q=copy as {sponsor:string;internshipId:string;milestoneId:string};
  const state=await this.reader.read({apiVersion:"proofwork-application-api-v1",cluster:"devnet",sponsor:q.sponsor,internshipId:q.internshipId,milestoneId:q.milestoneId},wallet);assertSession();
  if(state.status!=="Submitted" || state.student!==wallet || !state.verifier || !state.requirementsHash || !state.evidenceHash)throw new WalletAuthError("verification_not_available",409);
  if(parseManifest(Buffer.from(request.manifestBase64,"base64")).hash.toString("hex")!==state.requirementsHash || evidenceHash({...request,requirementsHash:state.requirementsHash}).toString("hex")!==state.evidenceHash)throw new WalletAuthError("evidence_mismatch",400);
  if(this.#tasks.size>=4)throw new WalletAuthError("verification_capacity",503);
  const job=this.store.jobs.createOrGetJob("browser_"+createHash("sha256").update(request.milestone).digest("hex"),{
   cluster:"devnet",genesisHash:SETTLEMENT_DEVNET_GENESIS,programId:PROGRAM_ID,sponsor:q.sponsor,internshipId:q.internshipId,internship:state.internship,
   milestoneId:q.milestoneId,milestone:state.milestone,submission:deriveSubmission(state.milestone)[0].toBase58(),student:wallet,verifier:state.verifier,
   requirementsHash:state.requirementsHash,evidenceHash:state.evidenceHash,repositoryId:request.repositoryId,contributorId:request.contributorId,commit:request.commit,verificationSpecHash:state.requirementsHash});
  // A durable completed/in-progress/uncertain job is read, never automatically reclaimed or rerun.
  if(job.state!=="created")return this.view(job);
  if(this.#tasks.has(job.jobId))return this.view(this.store.jobs.getJob(job.jobId)!);
  // Reuse the existing coordinator's claims, verifier, failure classification,
  // single-use authorizer, exact-message policy and mock receipts.
  const task=(async()=>{
   try{const receipt=await this.coordinator.coordinate(job.creationId,request,token!);this.prepared?.(receipt);}
   catch{/* The existing coordinator owns fenced rejection/recovery; never override its history. */}
   finally{token=null;this.#tasks.delete(job.jobId);}
  })();this.#tasks.set(job.jobId,task);
  return this.view(this.store.jobs.getJob(job.jobId)!);
 }
 /** Server shutdown/tests may await work; no retry, signer, token or authorization is returned. */
 async drain():Promise<void>{await Promise.all(this.#tasks.values());}
}

/** Explicit operator admission for ONE submitted commitment, not a browser-provided token or global identity.
 * No environment values or files are created by this function. Configure only after operator approval.
 */
export function admittedContributor(env:NodeJS.ProcessEnv):ContributorAdmission|undefined{
 const names=["APP_GITHUB_USER_TOKEN_FILE","APP_VERIFICATION_MILESTONE","APP_VERIFICATION_REPOSITORY_ID","APP_VERIFICATION_CONTRIBUTOR_ID","APP_VERIFICATION_COMMIT"] as const;
 if(names.every(k=>env[k]===undefined))return undefined;
 if(!names.every(k=>typeof env[k]==="string"&&env[k]!.length>0))throw new WalletAuthError("verification_admission_configuration_required",503);
 const [file,milestone,repositoryId,contributorId,commit]=names.map(k=>env[k]!);
 try{
  if(!isAbsolute(file!)||![repositoryId,contributorId].every(v=>/^[1-9][0-9]{0,19}$/.test(v!)&&BigInt(v!)<=0xffffffffffffffffn)||! /^[0-9a-f]{40}$/.test(commit!)||!/[1-9a-f]/.test(commit!)||new PublicKey(milestone!).toBase58()!==milestone||milestone===PublicKey.default.toBase58())throw Error();
 }catch{throw new WalletAuthError("invalid_verification_admission",503);}
 return async binding=>{
  if(binding.milestone!==milestone||binding.repositoryId!==repositoryId||binding.contributorId!==contributorId||binding.commit!==commit)return null;
  let handle;
  try{
   handle=await open(file!,constants.O_RDONLY|constants.O_NOFOLLOW);const stat=await handle.stat();
   if(!stat.isFile()||(stat.mode&0o077)!==0||stat.size<1||stat.size>1025||(process.getuid&&stat.uid!==process.getuid()))throw Error();
   const bytes=await handle.readFile();if(bytes.length>1025)throw Error();const token=bytes.toString("utf8").replace(/\n$/,"");
   if(!/^[A-Za-z0-9_]{1,1024}$/.test(token))throw Error();return token;
  }catch{throw new WalletAuthError("verification_admission_unavailable",503);}finally{await handle?.close();}
 };
}
