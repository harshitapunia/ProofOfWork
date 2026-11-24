/** Offline-only composition. GitHub HTTP and runner outcomes are explicit test doubles.
 * Program state is supplied by the running LiteSVM; no state or authorization is fabricated here.
 * Disposable signing keys remain in worker.mjs RAM; this module never loads operational credentials.
 */
import { createRequire } from "node:module";
const require = createRequire(new URL("../../../packages/finance-client/package.json", import.meta.url));
const {PublicKey, Transaction, TransactionInstruction} = require("@solana/web3.js");
const client = await import("../../../packages/finance-client/dist/src/index.js");
const {prepareWorkflow} = await import("../../../services/verifier/dist/src/workflow-preparation.js");
const {VerifierService} = await import("../../../services/verifier/dist/src/service.js");
const {GitHub} = await import("../../../services/verifier/dist/src/github.js");
const {DevnetAttestationReader} = await import("../../../services/verifier/dist/src/attestation-chain.js");
const {AttestationAuthorizer} = await import("../../../services/verifier/dist/src/attestation.js");
const {CASES} = await import("../../../services/verifier/dist/src/manifest.js");
const {manifest,githubFetch,TOKEN,COMMIT} = await import("../../../services/verifier/dist/test/helpers.js");
let retained;
export function retainPlans(organization,submission,evidence){retained={organization,submission,evidence};}
export function retainVerificationRequest(request){retained.verifierRequest=structuredClone(request);}
const envelope = {apiVersion:"proofwork-application-api-v1",cluster:"devnet"};
export function plan(pub) {
 const terms = {title:"Offline runtime internship",note:"Fictional fixture, never Devnet evidence",sponsor:pub.sponsor,student:pub.student,verifier:pub.verifier,
 internshipId:"8",milestoneId:"1",rewardAmountRaw:"1000000",assignBy:"1800000100",submitBy:"1800000200",
 owner:"proofwork-demo",repository:"assignment",manifest:JSON.stringify(manifest())};
 const evidence = {contributorId:"2002",commit:COMMIT,nonce:"ef".repeat(32),pullRequest:7};
 const organization = prepareWorkflow({...envelope,action:"organization",terms},pub.sponsor,1800000000n);
 const submission = prepareWorkflow({...envelope,action:"submission",terms,evidence},pub.student,1800000000n);
 retained = {organization,submission,evidence};
 return {ok:true,organization,submission,externalDependencies:"offline_github_and_runner_fixtures"};
}
export async function instruction(q,pub) {
 if (!retained) throw new Error("journey_plan_required");
 let ix,signer;
 if (q.action === "attest") {
  const rpc = async (url,init) => {
   if (url !== client.SETTLEMENT_DEVNET_RPC) throw new Error("unexpected_offline_endpoint");
   const request = JSON.parse(init.body);
   if (request.method !== "getMultipleAccounts") throw new Error("offline_write_forbidden");
   return Response.json({result:{value:request.params[0].map(address=>{
    const a=q.accounts[address];return a?{owner:a.owner,executable:a.executable,data:[Buffer.from(a.dataHex,"hex").toString("base64"),"base64"]}:null;
   })}});
  };
  const reader = new DevnetAttestationReader(client.SETTLEMENT_DEVNET_RPC,pub.verifier,rpc);
  const overrides=q.failure === "github"?{"/user":{id:9}}:{};
  const runner = {run:async()=>CASES.map(c=>({id:c.id,passed:q.failure !== "runner"}))};
  const service = new VerifierService(new GitHub(githubFetch(overrides)),reader,runner);
  const authorizer = new AttestationAuthorizer(service,reader,pub.verifier);
  const {organization,evidence} = retained;
  const request = {...(retained.verifierRequest??{manifestBase64:Buffer.from(organization.terms.manifest).toString("base64"),milestone:organization.milestone,
   student:pub.student,repositoryId:"1001",owner:organization.terms.owner,repository:organization.terms.repository,...evidence}),
   ...(q.failure === "evidence"?{nonce:"aa".repeat(32)}:{})};
  const ticket=await authorizer.prepare(request,TOKEN);
  ix=await authorizer.takeInstruction(ticket);signer=pub.verifier;
  // A used ticket cannot authorize another instruction.
  try {await authorizer.takeInstruction(ticket);throw new Error("ticket_replay_accepted");}
  catch(error){if(error.code!=="invalid_authorization")throw error;}
 } else if(q.action === "settle") {
  ix=client.settleMilestoneInstruction({sponsor:pub.sponsor,student:pub.student,caller:pub.caller,internshipId:8n,milestoneId:1n});signer=pub.caller;
 } else {
  const step=[...retained.organization.steps,...(retained.submission?.steps??[])].find(s=>s.action===q.action);
  if(!step || step.instructions.length!==1)throw new Error("unknown_journey_step");
  const i=step.instructions[0];
  ix=new TransactionInstruction({programId:new PublicKey(i.programId),keys:i.keys.map(k=>({...k,pubkey:new PublicKey(k.pubkey)})),data:Buffer.from(i.dataBase64,"base64")});
  signer=step.feePayer;
 }
 const transaction=new Transaction().add(ix);transaction.feePayer=new PublicKey(signer);
 return {transaction,signer};
}
