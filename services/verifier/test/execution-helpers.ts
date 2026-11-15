/** Independent ephemeral fixture authority and transaction signers. No private key export/persistence. */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { LifecycleStore, INTENT_FORMAT, offlineTestStatement, type JobBindings, type ExecutionAttempt,
  type ExecutionEvidence, type OfflineTestEnvelope } from "@proofwork/lifecycle";
import { signingFixture } from "./signing-helpers.js";
import { offlineExecutionObserver } from "../src/offline-execution.js";

const hash = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
export const executionRef = (a: ExecutionAttempt) => ({attemptId:a.attemptId,identity:a.identity,revision:a.revision});
export function controlFence(s: LifecycleStore,a: ExecutionAttempt) {
  const j=s.jobs.getJob(a.intent.jobId)!;
  return {jobId:j.jobId,identity:j.identity,revision:j.revision,generation:j.generation,workerId:j.workerId,operatorId:"operator"};
}
export async function executionFixture(path: string, createAttempt=true) {
  const f=await signingFixture(), authority=generateKeyPairSync("ed25519");
  const authorityKey=new PublicKey(authority.publicKey.export({format:"der",type:"spki"}).subarray(-32)).toBase58();
  const s=new LifecycleStore(path), st=f.state;
  const b:JobBindings={cluster:"devnet",genesisHash:f.observation.genesisHash,programId:f.transaction().instructions[0]!.programId.toBase58(),
    sponsor:st.sponsor,internshipId:st.internshipId,internship:st.internship,milestoneId:st.milestoneId,milestone:st.milestone,
    submission:st.submission,student:st.student,verifier:st.verifier,requirementsHash:st.requirementsHash,evidenceHash:st.evidenceHash,
    repositoryId:f.request.repositoryId,contributorId:f.request.contributorId,commit:f.request.commit,verificationSpecHash:st.requirementsHash};
  const first=s.jobs.createOrGetJob("job",b), claimed=s.jobs.claimJob(first.jobId,first.identity,0,"worker");
  let job=claimed.job;
  for (const phase of ["verification_running","verification_completed","authorization_pending"] as const)
    job=s.jobs.transitionJob(claimed.claim,job.revision,phase);
  const claim=claimed.claim;
  const initial=s.transactionIntents.createIntent(claim,job.revision,"intent",f.payer.publicKey).intent;
  const intent=s.transactionIntents.recordPreparation(claim,job.revision,initial.intentId,initial.identity,0,
    {format:INTENT_FORMAT,messageDigest:hash(f.expected),blockhash:f.observation.blockhash,lastValidBlockHeight:"200",observedBlockHeight:"100"});
  const tx=f.transaction(); tx.addSignature(new PublicKey(f.payer.publicKey),f.payer.signForTest(f.expected));
  tx.addSignature(new PublicKey(f.verifier.publicKey),f.verifier.signForTest(f.expected));
  const wire=tx.serialize();
  let n=BigInt("0x"+tx.signature!.toString("hex")),id="";
  const alphabet="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  while(n>0n){id=alphabet[Number(n%58n)]!+id;n/=58n;}
  for(const v of tx.signature!){if(v!==0)break;id="1"+id;}
  const attempt=createAttempt ? s.executionAttempts.create(claim,job.revision,"attempt",intent.intentId,intent.identity,authorityKey).attempt : undefined!;
  function envelope(a: ExecutionAttempt, patch: Partial<ExecutionEvidence>={}, wireInput=wire): OfflineTestEnvelope {
    const evidence:ExecutionEvidence={eventId:"event_"+a.revision,attemptId:a.attemptId,identity:a.identity,revision:a.revision,
      intentIdentity:a.intent.identity,preparationIdentity:a.intent.preparation!.identity,
      bindingDigest:hash(JSON.stringify(Object.values(a.intent.bindings))),
      kind:"signed_identity",wireDigest:hash(wireInput),testTransactionId:id,finality:0,outcome:"none",error:null,
      transactionSlot:null,contextSlot:null,observedBlockHeight:"100",...patch};
    const wireBase64=wireInput.toString("base64");
    return {evidence,wireBase64,authoritySignatureBase64:sign(null,offlineTestStatement(evidence,wireBase64),authority.privateKey).toString("base64")};
  }
  const fixture={mode:"offline-attestation-fixture" as const,read:async()=>structuredClone(st)};
  const observer=(patch:Partial<ExecutionEvidence>={},wireInput=wire) => offlineExecutionObserver(
    {mode:"offline-test-observation-source",read:async a=>envelope(a,patch,wireInput)},fixture);
  const record=async(a:ExecutionAttempt,patch:Partial<ExecutionEvidence>)=>s.executionRecovery.applyObservation(
    controlFence(s,a),executionRef(a),await observer(patch).observe(a));
  const signed=async(a=attempt)=>s.executionAttempts.recordSubmissionIntent(claim,job.revision,executionRef(a),await observer().observe(a));
  return {f,s,job,claim,intent,attempt,authorityKey,wire,envelope,fixture,observer,record,signed};
}
