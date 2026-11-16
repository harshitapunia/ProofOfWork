/** Owned offline child process. Reads only; no signing or RPC. */
import {writeSync} from "node:fs";
import {LifecycleStore} from "@proofwork/lifecycle";
import {OfflineReadOnlyObservationAdapter,reconcileOfflineReadEvidence} from "../src/read-only-observation.js";
import {mockSource} from "./read-only-helpers.js";
const path=process.argv[2]!,window=process.argv[3]!;
function stop(){writeSync(4,Buffer.from("checkpoint"));process.kill(process.pid,"SIGSTOP");}
process.send!({ready:true});
process.once("message",async(v:any)=>{
 let s:LifecycleStore|undefined;
 try{
  s=new LifecycleStore(path);const store=s;
  if(window==="before_read"||window==="after_restart"||window==="after_revocation")stop();
  const source=mockSource(v.bundle);
  const readStatus=source.readStatus,readTransaction=source.readTransaction,readAccounts=source.readAccounts;
  source.readStatus=async q=>{if(window==="during_status")stop();return readStatus(q);};
  source.readTransaction=async q=>{if(window==="after_status")stop();return readTransaction(q);};
  source.readAccounts=async q=>{if(window==="between_status_accounts")stop();const result=await readAccounts(q);if(window==="during_accounts")stop();return result;};
  if(window==="missing_history")source.readStatus=async()=>{
   stop();return {kind:"status_read",provenance:v.bundle.status.provenance,currentBlockHeight:"150",evidence:{kind:"missing",reason:"history_missing"}};
  };
  let result;
  if(window==="during_classification"){
   const view=store.executionAttempts.get(v.plan.attempt.attemptId)!;
   // A test-only proxy pauses inside the classifier's bundle structural validation.
   const bundle=new Proxy(v.bundle,{ownKeys(target){stop();return Reflect.ownKeys(target);}});
   result=reconcileOfflineReadEvidence(v.plan,[bundle],view,view);
  }else{
   const observer=new OfflineReadOnlyObservationAdapter([source],{get:id=>store.executionAttempts.get(id)},{readTimeoutMs:1000});
   result=await observer.observe(v.plan);
  }
  if(window==="after_complete")stop();
  process.send!({ok:true,result});
 }catch(error){process.send!({ok:false,code:(error as any).code??"observation_error"});}
 finally{s?.close();process.disconnect();}
});
