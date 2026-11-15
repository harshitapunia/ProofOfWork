import { LifecycleStore } from "../src/index.js";
import { DatabaseSync } from "node:sqlite";
import { JOB_SCHEMA_V2 } from "../src/schema.js";
const [path,mode]=process.argv.slice(2) as [string,string];
if(mode==="migration"){
 const db=new DatabaseSync(path);db.exec("BEGIN IMMEDIATE");db.exec(JOB_SCHEMA_V2[0]!);db.exec("PRAGMA user_version=2");
 process.send!({ready:true});process.on("message",()=>{});
}else{
 const s=new LifecycleStore(path,5000);process.send!({ready:true});
 process.on("message",()=>{}); // Keep crash fixtures alive until the parent explicitly kills them.
 process.once("message",(q:any)=>{
  if(mode==="uncommitted"){
   const db=new DatabaseSync(path);db.exec("BEGIN IMMEDIATE");db.prepare("UPDATE verification_jobs SET state='closed' WHERE job_id=?").run(q.jobId);
   process.send!({ok:true});return;
  }
  try{
   const j=q.create?s.jobs.createOrGetJob(q.workerId,q.bindings):s.jobs.getJob(q.jobId)!;
   const claimed=s.jobs.claimJob(j.jobId,j.identity,q.create?j.revision:0,q.workerId);
   let job=claimed.job;
   if(mode==="crash-running")job=s.jobs.transitionJob(claimed.claim,job.revision,"verification_running");
   process.send!({ok:true,claim:claimed.claim,job},()=>{
    if(mode==="normal"){s.close();process.disconnect();}
   });
  }catch(e){process.send!({ok:false,code:(e as {code?:string}).code},()=>{s.close();process.disconnect();});}
 });
}
