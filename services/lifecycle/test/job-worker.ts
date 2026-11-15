import { parentPort, workerData } from "node:worker_threads";
import { LifecycleStore } from "../src/index.js";
const q=workerData;
const s=new LifecycleStore(q.path,5000);
parentPort!.postMessage("ready");Atomics.wait(new Int32Array(q.gate),0,0);
try{
 const job=q.create?s.jobs.createOrGetJob(q.workerId,q.bindings):s.jobs.getJob(q.jobId)!;
 const result=s.jobs.claimJob(job.jobId,job.identity,q.create?job.revision:0,q.workerId);
 parentPort!.postMessage({ok:true,...result});
}catch(e){parentPort!.postMessage({ok:false,code:(e as {code?:string}).code});}
s.close();
