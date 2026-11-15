/** Owned child fixture; only public signed TEST envelopes cross IPC. Never key material. */
import { writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { LifecycleStore } from "@proofwork/lifecycle";
import { offlineExecutionObserver } from "../src/offline-execution.js";
const path=process.argv[2]!,mode=process.argv[3]!;
const stop=()=>{writeSync(4,Buffer.from("checkpoint"));process.kill(process.pid,"SIGSTOP");};
process.send!({ready:true});
process.once("message",async (v:any)=>{
  let store:LifecycleStore|undefined;
  try {
    if(mode==="migration") {
      const db=new DatabaseSync(path);db.exec("BEGIN IMMEDIATE");
      const schema=await import(new URL("../../../lifecycle/dist/src/schema.js",import.meta.url).href);
      db.exec(schema.EXECUTION_SCHEMA_V5[0]!);db.exec("PRAGMA user_version=5");stop();return;
    }
    const db=new DatabaseSync(path,{timeout:1000});db.exec("PRAGMA foreign_keys=ON;PRAGMA synchronous=EXTRA;PRAGMA journal_mode=DELETE");
    const module=await import(new URL("../../../lifecycle/dist/src/execution-attempts.js",import.meta.url).href);
    const facade=module.createExecutionAttempts(<T>(fn:(db:DatabaseSync)=>T,write=true):T=>{
      if(mode==="before")stop();
      db.exec(write?"BEGIN IMMEDIATE":"BEGIN");
      try {
        const result=fn(db);if(mode==="during"&&write)stop();
        db.exec("COMMIT");if(mode==="after"&&write)stop();return result;
      }catch(e){db.exec("ROLLBACK");throw e;}
    });
    if(mode==="hold") {db.exec("BEGIN IMMEDIATE");stop();return;}
    let result;
    if(v.action==="create")result=facade.attempts.create(v.claim,v.jobRevision,v.requestId,v.intentId,v.intentIdentity,v.authority);
    else if(v.action==="invoke" || v.action==="simulate")result=facade.attempts.recordSimulatedInvocation(v.claim,v.jobRevision,v.ref,v.eventId);
    else if(v.action==="uncertain")result=facade.recovery.requireReconciliation(v.fence,v.ref,v.eventId);
    else {
      store=new LifecycleStore(path);
      const snapshot=store.executionAttempts.get(v.ref.attemptId)!;
      const observer=offlineExecutionObserver({mode:"offline-test-observation-source",read:async()=>v.envelope},
        {mode:"offline-attestation-fixture",read:async()=>v.state});
      const token=await observer.observe(snapshot);
      result=v.action==="signed"?facade.attempts.recordSubmissionIntent(v.claim,v.jobRevision,v.ref,token)
        :facade.recovery.applyObservation(v.fence,v.ref,token);
    }
    if(v.action==="simulate") { const local={simulate:async()=>{if(mode==="inside-simulation")stop();}}; await local.simulate(); }
    if(mode==="pause")stop();
    process.send!({ok:true,result});db.close();
  }catch(e){process.send!({ok:false,code:(e as any).code??"rejected"});}
  finally{store?.close();process.disconnect();}
});
