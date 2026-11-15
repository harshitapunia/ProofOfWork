import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { fork } from "node:child_process";
import { bindings,error,temp } from "./job-helpers.js";
async function stop(child:ReturnType<typeof fork>){
 if(child.exitCode===null&&child.signalCode===null){const done=once(child,"exit");child.kill("SIGKILL");await done;}
}
for(const count of [2,8]){
 test(count+" worker threads race for one durable claim",{timeout:30000},async t=>{
  const x=temp(t),s=x.store(),j=s.jobs.createOrGetJob("request",bindings()),gate=new SharedArrayBuffer(4);
  const workers=Array.from({length:count},(_,n)=>new Worker(new URL("./job-worker.js",import.meta.url),
   {workerData:{path:x.path,gate,jobId:j.jobId,workerId:"worker_"+n}}));
  try{
   await Promise.all(workers.map(w=>once(w,"message")));
   const results=workers.map(w=>once(w,"message"));Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);
   const values=(await Promise.all(results)).map(([v])=>v);
   assert.equal(values.filter(v=>v.ok).length,1);
   assert.ok(values.filter(v=>!v.ok).every(v=>v.code==="conflict"));
   assert.equal(s.jobs.getJob(j.jobId)!.generation,1);assert.equal(s.jobs.getJobHistory(j.jobId).length,2);
  }finally{await Promise.all(workers.map(w=>w.terminate()));}
 });
}
test("separate processes cannot create conflicting jobs or claims",{timeout:30000},async t=>{
 const x=temp(t),s=x.store(),b=bindings();
 const children=Array.from({length:4},()=>fork(new URL("./job-process.js",import.meta.url),[x.path,"normal"],
  {stdio:["ignore","ignore","pipe","ipc"]}));
 try{
  await Promise.all(children.map(c=>once(c,"message")));
  const replies=children.map(c=>once(c,"message"));
  children.forEach((c,n)=>c.send({create:true,bindings:b,workerId:"request_"+n}));
  const results=(await Promise.all(replies)).map(([v])=>v as any);
  assert.equal(results.filter(v=>v.ok).length,1);
  const jobs=s.jobs.listRecoveryRequired().entries;assert.equal(jobs.length,1);
  assert.equal(jobs[0]!.job.generation,1);
  assert.equal(s.jobs.getJobHistory(jobs[0]!.job.jobId).length,2);
 }finally{await Promise.all(children.map(stop));}
});
for(const mode of ["crash-claimed","crash-running"]){
 test("restart retains identity/fence after "+mode,{timeout:20000},async t=>{
  const x=temp(t),s=x.store(),j=s.jobs.createOrGetJob("request",bindings());
  const child=fork(new URL("./job-process.js",import.meta.url),[x.path,mode],{stdio:["ignore","ignore","pipe","ipc"]});
  try{
   await once(child,"message");const response=once(child,"message");
   child.send({jobId:j.jobId,workerId:"crashed_worker"});const [result]=await response as any;
   assert.equal(result.ok,true);await stop(child);s.close();
   const reopened=x.store(),before=reopened.jobs.getJob(j.jobId)!;
   assert.equal(before.identity,j.identity);assert.equal(before.generation,1);
   assert.equal(before.state,mode==="crash-claimed"?"claimed":"verification_running");
   assert.throws(()=>reopened.jobs.claimJob(j.jobId,j.identity,before.revision,"new_worker"),error("invalid_transition"));
   const revoked=reopened.jobRecovery.interruptJob(j.jobId,j.identity,before.revision,"trusted_operator");
   const fresh=reopened.jobs.claimJob(j.jobId,j.identity,revoked.revision,"new_worker");
   assert.equal(fresh.claim.generation,3);
   assert.throws(()=>reopened.jobs.transitionJob(result.claim,fresh.job.revision,"verification_running"),error("stale_claim"));
  }finally{await stop(child);}
 });
}
test("process kill during uncommitted head mutation restores the accepted history",{timeout:20000},async t=>{
 const x=temp(t),s=x.store(),j=s.jobs.createOrGetJob("request",bindings());
 const child=fork(new URL("./job-process.js",import.meta.url),[x.path,"uncommitted"],{stdio:["ignore","ignore","pipe","ipc"]});
 try{
  await once(child,"message");const response=once(child,"message");child.send({jobId:j.jobId});
  assert.equal((await response as any)[0].ok,true);await stop(child);s.close();
  assert.deepEqual(x.store().jobs.getJob(j.jobId),j);
 }finally{await stop(child);}
});
test("independent connections reject a lost update using the previous revision",t=>{
 const x=temp(t),a=x.store(),b=x.store(),j=a.jobs.createOrGetJob("request",bindings()),claim=a.jobs.claimJob(j.jobId,j.identity,0,"worker");
 const read1=a.jobs.getJob(j.jobId)!,read2=b.jobs.getJob(j.jobId)!;
 a.jobs.transitionJob(claim.claim,read1.revision,"verification_running");
 assert.throws(()=>b.jobs.transitionJob(claim.claim,read2.revision,"verification_running"),error("conflict"));
 assert.equal(b.jobs.getJobHistory(j.jobId).length,3);
});
