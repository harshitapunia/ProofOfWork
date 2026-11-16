/** Owned TEST child. Only synthetic request/public identities cross IPC; private key closures never do. */
import {writeSync} from "node:fs";
import {LifecycleStore, type VerificationJobs, type TransactionIntents, type ExecutionAttempts} from "@proofwork/lifecycle";
import {secureFixture} from "./secure-integration-helpers.js";
import {TOKEN} from "./helpers.js";
const path=process.argv[2]!,window=process.argv[3]!;
function stop(){writeSync(4,Buffer.from("checkpoint"));process.kill(process.pid,"SIGSTOP");}
class CrashStore extends LifecycleStore{
 override get jobs():VerificationJobs{
  const jobs=super.jobs;
  return {...jobs,createOrGetJob(...args:Parameters<VerificationJobs["createOrGetJob"]>){
   if(window==="before_job")stop();const row=jobs.createOrGetJob(...args);if(window==="after_job")stop();return row;
  }};
 }
 override get transactionIntents():TransactionIntents{
  const intents=super.transactionIntents;
  return {...intents,recordPreparation(...args:Parameters<TransactionIntents["recordPreparation"]>){
   const row=intents.recordPreparation(...args);if(window==="after_preparation")stop();return row;
  }};
 }
 override get executionAttempts():ExecutionAttempts{
  const attempts=super.executionAttempts;
  return {...attempts,create(...args:Parameters<ExecutionAttempts["create"]>){
   if(window==="before_execution")stop();const row=attempts.create(...args);if(window==="after_execution")stop();return row;
  },markUncertain(...args:Parameters<ExecutionAttempts["markUncertain"]>){
   if(window==="before_hold")stop();const row=attempts.markUncertain(...args);if(window==="after_hold")stop();return row;
  }};
 }
}
const store=new CrashStore(path),f=await secureFixture(path,store),state=await f.chain.read(f.state.milestone);
if(window==="before_verifier")f.verifier.before(async()=>stop());
if(window==="after_verifier")f.verifier.after(async()=>stop());
if(window==="after_payer")f.payer.after(async()=>stop());
if(window==="during_observation")f.onStatus(async()=>stop());
if(window==="after_revocation")f.verifier.before(async()=>{f.revoke();stop();});
process.send!({ready:true,config:f.config,state,request:f.request});
process.once("message",async()=>{
 try{
  const result=await f.integration.investigate(f.request,TOKEN);
  if(window==="after_matching")stop();
  process.send!({ok:true,result});
 }catch{process.send!({ok:false,code:"child_failure"});}
 finally{store.close();process.disconnect();}
});
