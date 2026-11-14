import { test } from "node:test";
import assert from "node:assert/strict";
import { bindings,error,temp } from "./job-helpers.js";
test("canonical operation is idempotent across request IDs and object insertion order",t=>{
 const s=temp(t).store(),b=bindings(),a=s.jobs.createOrGetJob("request_a",b);
 const reordered=Object.fromEntries(Object.entries(b).reverse()) as unknown as typeof b;
 assert.deepEqual(s.jobs.createOrGetJob("request_a",reordered),a);
 assert.deepEqual(s.jobs.createOrGetJob("request_b",b),a);
 assert.equal(s.jobs.getJobHistory(a.jobId).length,1);
 assert.equal(a.creationId,"request_a");assert.equal(a.signingAuthorization,"not_granted");
 assert.ok(Object.isFrozen(a)&&Object.isFrozen(a.bindings));
});
test("one database owns reservations and jobs without changing reservation semantics",t=>{
 const s=temp(t).store(),b=bindings(),r=s.reserveInternship(b.sponsor);
 const j=s.jobs.createOrGetJob("request",b);
 assert.equal(s.get(r.id)!.value,0n);assert.equal(s.jobs.getJob(j.jobId)!.state,"created");
 assert.equal(s.reserveInternship(b.sponsor).value,1n);
});
test("verification and authorization bookkeeping never imply chain execution",t=>{
 const s=temp(t).store(),j=s.jobs.createOrGetJob("request",bindings());
 const {claim,job}=s.jobs.claimJob(j.jobId,j.identity,0,"worker_a");
 let current=s.jobs.transitionJob(claim,job.revision,"verification_running");
 current=s.jobs.transitionJob(claim,current.revision,"verification_completed");
 assert.equal(current.verificationOutcome,"passed");assert.equal(current.signingAuthorization,"not_granted");
 current=s.jobs.transitionJob(claim,current.revision,"authorization_pending");
 assert.equal(current.signingAuthorization,"not_granted");
 assert.deepEqual(s.jobs.getJobHistory(j.jobId).map(e=>e.state),
  ["created","claimed","verification_running","verification_completed","authorization_pending"]);
 assert.equal(s.jobs.listRecoveryRequired().entries[0]!.classification,"authorization_uncertain");
});
test("rejected/closed job is permanently retained and cannot be resurrected",t=>{
 const x=temp(t),s=x.store(),b=bindings(),j=s.jobs.createOrGetJob("request",b);
 const {claim,job}=s.jobs.claimJob(j.jobId,j.identity,0,"worker");
 const running=s.jobs.transitionJob(claim,job.revision,"verification_running");
 const rejected=s.jobs.transitionJob(claim,running.revision,"verification_rejected");
 const closed=s.jobs.transitionJob(claim,rejected.revision,"closed");
 assert.equal(closed.verificationOutcome,"rejected");
 assert.throws(()=>s.jobs.claimJob(j.jobId,j.identity,closed.revision,"other"),error("invalid_transition"));
 assert.throws(()=>x.raw().prepare("DELETE FROM verification_jobs WHERE job_id=?").run(j.jobId));
 s.close();const reopened=x.store();
 assert.deepEqual(reopened.jobs.createOrGetJob("new_request",b),closed);
 assert.equal(reopened.jobs.listRecoveryRequired().entries.length,0);
});
test("job creation identity cannot be substituted for a different operation",t=>{
 const s=temp(t).store(),a=s.jobs.createOrGetJob("request",bindings());
 assert.throws(()=>s.jobs.createOrGetJob("request",bindings(true)),error("job_conflict"));
 const b=s.jobs.createOrGetJob("other",bindings(true));
 assert.notEqual(a.operationKey,b.operationKey);
 assert.throws(()=>s.jobs.claimJob(b.jobId,a.identity,0,"worker"),error("job_conflict"));
});
test("explicit revocation fences the old worker before safe verification restart",t=>{
 const s=temp(t).store(),j=s.jobs.createOrGetJob("request",bindings());
 const a=s.jobs.claimJob(j.jobId,j.identity,0,"worker_a");
 const interrupted=s.jobRecovery.interruptJob(j.jobId,j.identity,a.job.revision,"operator");
 assert.equal(interrupted.generation,2);assert.equal(interrupted.workerId,null);
 assert.throws(()=>s.jobs.transitionJob(a.claim,interrupted.revision,"verification_running"),error("stale_claim"));
 const b=s.jobs.claimJob(j.jobId,j.identity,interrupted.revision,"worker_b");
 assert.equal(b.claim.generation,3);
 const running=s.jobs.transitionJob(b.claim,b.job.revision,"verification_running");
 const interrupted2=s.jobRecovery.interruptJob(j.jobId,j.identity,running.revision,"operator");
 assert.equal(interrupted2.recoveryReason,"verification_interrupted");
 const c=s.jobs.claimJob(j.jobId,j.identity,interrupted2.revision,"worker_c");
 assert.equal(c.claim.generation,5);
 assert.throws(()=>s.jobs.transitionJob(b.claim,c.job.revision,"verification_running"),error("stale_claim"));
});
for(const phase of ["verification_completed","authorization_pending"] as const){
 test("uncertain "+phase+" never becomes a new worker/signing authorization",t=>{
  const x=temp(t),s=x.store(),j=s.jobs.createOrGetJob("request",bindings()),a=s.jobs.claimJob(j.jobId,j.identity,0,"worker");
  let current=s.jobs.transitionJob(a.claim,a.job.revision,"verification_running");
  current=s.jobs.transitionJob(a.claim,current.revision,"verification_completed");
  if(phase==="authorization_pending")current=s.jobs.transitionJob(a.claim,current.revision,phase);
  const blocked=s.jobRecovery.interruptJob(j.jobId,j.identity,current.revision,"operator");
  assert.throws(()=>s.jobs.claimJob(j.jobId,j.identity,blocked.revision,"new_worker"),error("invalid_transition"));
  assert.throws(()=>s.jobs.transitionJob(a.claim,blocked.revision,"authorization_pending"),error("stale_claim"));
  s.close();const reopened=x.store(),restored=reopened.jobs.getJob(j.jobId)!;
  assert.equal(restored.state,"recovery_required");assert.equal(restored.verificationOutcome,"passed");
  assert.equal(restored.signingAuthorization,"not_granted");
  assert.equal(reopened.jobs.createOrGetJob("another_request",bindings()).jobId,j.jobId);
 });
}
test("readonly restart classification distinguishes all unfinished phases",t=>{
 const x=temp(t),s=x.store(),b=bindings(),created=s.jobs.createOrGetJob("created",b);
 assert.equal(s.jobs.listRecoveryRequired().entries[0]!.classification,"never_claimed");
 const a=s.jobs.claimJob(created.jobId,created.identity,0,"worker");
 assert.equal(s.jobs.listRecoveryRequired().entries[0]!.classification,"claimed_unfinished");
 s.jobs.transitionJob(a.claim,a.job.revision,"verification_running");
 s.close();const reopened=x.store();
 assert.equal(reopened.jobs.listRecoveryRequired().entries[0]!.classification,"verification_unfinished");
 assert.deepEqual(reopened.jobs.getJobHistory(created.jobId).map(e=>e.generation),[0,1,1]);
});
test("state changes require the current revision and matching worker/fence/identity",t=>{
 const s=temp(t).store(),j=s.jobs.createOrGetJob("request",bindings()),a=s.jobs.claimJob(j.jobId,j.identity,0,"worker");
 assert.throws(()=>s.jobs.claimJob(j.jobId,j.identity,0,"other"),error("conflict"));
 assert.throws(()=>s.jobs.claimJob(j.jobId,j.identity,1,"other"),error("invalid_transition"));
 assert.throws(()=>s.jobs.transitionJob(a.claim,0,"verification_running"),error("conflict"));
 for(const patch of [{workerId:"other"},{generation:0}])
  assert.throws(()=>s.jobs.transitionJob({...a.claim,...patch},1,"verification_running"),error("stale_claim"));
 assert.throws(()=>s.jobs.transitionJob({...a.claim,identity:"00".repeat(32)},1,"verification_running"),error("job_conflict"));
 assert.throws(()=>s.jobs.transitionJob(a.claim,1,"authorization_pending"),error("invalid_transition"));
 assert.equal(s.jobs.getJob(j.jobId)!.revision,1);
});
test("bounded keyset recovery scanning and closed handles fail predictably",t=>{
 const s=temp(t).store();s.jobs.createOrGetJob("a",bindings());s.jobs.createOrGetJob("b",bindings(true));
 const page=s.jobs.listRecoveryRequired(undefined,1);assert.equal(page.entries.length,1);
 assert.equal(s.jobs.listRecoveryRequired(page.nextAfter,1).entries.length,1);
 for(const limit of [0,101,NaN])assert.throws(()=>s.jobs.listRecoveryRequired(undefined,limit),error("invalid_input"));
 s.close();assert.throws(()=>s.jobs.listRecoveryRequired(),error("closed"));
});

test("bounded history exhaustion retains the operation and never wraps fencing",{timeout:60000},t=>{
 const s=temp(t).store(),b=bindings(),j=s.jobs.createOrGetJob("request",b);
 let current=j;
 for(let n=0;n<128;n++){
  const c=s.jobs.claimJob(j.jobId,j.identity,current.revision,"worker");
  current=s.jobRecovery.interruptJob(j.jobId,j.identity,c.job.revision,"operator");
  assert.equal(current.generation,2*(n+1));
 }
 assert.equal(current.revision,256);
 assert.throws(()=>s.jobs.claimJob(j.jobId,j.identity,256,"new_worker"),error("job_exhausted"));
 assert.equal(s.jobs.getJobHistory(j.jobId).length,257);
 assert.equal(s.jobs.createOrGetJob("replacement_request",b).jobId,j.jobId);
});
