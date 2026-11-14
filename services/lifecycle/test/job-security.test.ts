import { test } from "node:test";
import assert from "node:assert/strict";
import { bindings,error,temp } from "./job-helpers.js";
for(const [field,value] of [
 ["cluster","mainnet"],["genesisHash","wrong"],["programId","11111111111111111111111111111111"],
 ["sponsor","bad"],["internship","bad"],["milestone","bad"],["submission","bad"],["student","bad"],["verifier","bad"],
 ["requirementsHash","00".repeat(32)],["evidenceHash","bad"],["verificationSpecHash","ab".repeat(32)],
 ["commit","HEAD"],["commit","00".repeat(20)],["repositoryId","0"],["contributorId","0"],
 ["internshipId","18446744073709551616"],["milestoneId","01"],["repositoryId",1001],["contributorId","1.5"]
] as const){
 test("job identity rejects malformed "+field+"="+String(value).slice(0,24),t=>{
  const s=temp(t).store();assert.throws(()=>s.jobs.createOrGetJob("request",{...bindings(),[field]:value} as never),error("invalid_input"));
  assert.equal(s.jobs.listRecoveryRequired().entries.length,0);
 });
}
for(const field of ["student","verifier","repositoryId","contributorId","commit","evidenceHash","requirementsHash"] as const){
 test("new request IDs cannot replace immutable "+field,t=>{
  const s=temp(t).store(),b=bindings(),j=s.jobs.createOrGetJob("first",b);
  const patch=field==="student"||field==="verifier"?{student:b.verifier,verifier:b.student}
   :field==="requirementsHash"?{requirementsHash:"ab".repeat(32),verificationSpecHash:"ab".repeat(32)}
   :{[field]:field==="repositoryId"||field==="contributorId"?"9999":field==="commit"?"ab".repeat(20):"ab".repeat(32)};
  assert.throws(()=>s.jobs.createOrGetJob("new_request",{...b,...patch}),error("job_conflict"));
  assert.deepEqual(s.jobs.getJob(j.jobId),j);
 });
}
test("wrong linked PDAs and aliased roles cannot enter the job ledger",t=>{
 const s=temp(t).store(),b=bindings(),other=bindings(true);
 for(const patch of [{milestone:other.milestone},{internship:other.internship},{submission:other.submission},
  {student:b.sponsor},{verifier:b.sponsor},{student:b.verifier}]){
  assert.throws(()=>s.jobs.createOrGetJob("request",{...b,...patch}),error("invalid_input"));
 }
});
test("inputs are copied; accessors, proxies, symbols and arbitrary approval JSON are rejected",t=>{
 const s=temp(t).store(),b={...bindings()},job=s.jobs.createOrGetJob("first",b);b.commit="ab".repeat(20);
 assert.notEqual(s.jobs.getJob(job.jobId)!.bindings.commit,b.commit);
 const evil=new Proxy({}, {ownKeys(){throw Error("private sentinel");}});
 for(const value of [evil,{...bindings(),approved:true},{...bindings(),githubToken:"private sentinel"},
  {...bindings(),[Symbol("private")]:true},Object.defineProperty({...bindings()},"commit",{get(){throw Error("private sentinel");}})]){
  assert.throws(()=>s.jobs.createOrGetJob("rejected",value as never),error("invalid_input"));
 }
});
for(const to of ["approved","signing","submitted","confirmed","settled","created","claimed"]){
 test("no job transition can authorize "+to,t=>{
  const s=temp(t).store(),j=s.jobs.createOrGetJob("request",bindings()),a=s.jobs.claimJob(j.jobId,j.identity,0,"worker");
  assert.throws(()=>s.jobs.transitionJob(a.claim,1,to as never),error("invalid_transition"));
  assert.equal(s.jobs.getJob(j.jobId)!.signingAuthorization,"not_granted");
 });
}
test("claims reject malformed, mutated or lease-shaped input without leaking errors",t=>{
 const s=temp(t).store(),j=s.jobs.createOrGetJob("request",bindings()),a=s.jobs.claimJob(j.jobId,j.identity,0,"worker");
 for(const patch of [{generation:-1},{generation:1.5},{generation:Number.MAX_SAFE_INTEGER+1},{workerId:"../bad"},
  {leaseExpiresAt:0},{attemptId:"replacement"},{identity:"bad"}]){
  assert.throws(()=>s.jobs.transitionJob({...a.claim,...patch} as never,1,"verification_running"),error("invalid_input"));
 }
 assert.throws(()=>s.jobs.transitionJob(new Proxy({}, {ownKeys(){throw Error("private sentinel");}}) as never,1,"verification_running"),error("invalid_input"));
});
test("mutable row and bounded append-only history must agree on every read",t=>{
 const x=temp(t),s=x.store(),j=s.jobs.createOrGetJob("request",bindings()),raw=x.raw();
 raw.prepare("UPDATE verification_jobs SET state='closed' WHERE job_id=?").run(j.jobId);
 assert.throws(()=>s.jobs.getJob(j.jobId),error("corrupt_store"));
 assert.throws(()=>s.jobs.listRecoveryRequired(),error("corrupt_store"));
});
test("database constraints reject history deletion/update and immutable identity replacement",t=>{
 const x=temp(t),s=x.store(),j=s.jobs.createOrGetJob("request",bindings()),raw=x.raw();
 assert.throws(()=>raw.prepare("DELETE FROM verification_job_history WHERE job_id=?").run(j.jobId));
 assert.throws(()=>raw.prepare("UPDATE verification_job_history SET digest='bad' WHERE job_id=?").run(j.jobId));
 assert.throws(()=>raw.prepare("UPDATE verification_jobs SET creation_id='replaced' WHERE job_id=?").run(j.jobId));
 assert.deepEqual(s.jobs.getJob(j.jobId),j);
});
test("hostile serialized binding metadata is detected even after test-only trigger removal",t=>{
 const x=temp(t),s=x.store(),j=s.jobs.createOrGetJob("request",bindings()),raw=x.raw();
 raw.exec("DROP TRIGGER verification_job_identity_immutable");
 raw.prepare("UPDATE verification_jobs SET bindings='[]' WHERE job_id=?").run(j.jobId);
 assert.throws(()=>s.jobs.getJob(j.jobId),error("corrupt_store"));
 s.close();assert.throws(()=>x.store(),error("schema_mismatch"));
});
test("tampered history cannot manufacture a different claim generation",t=>{
 const x=temp(t),s=x.store(),j=s.jobs.createOrGetJob("request",bindings());
 s.jobs.claimJob(j.jobId,j.identity,0,"worker");const raw=x.raw();
 raw.exec("DROP TRIGGER verification_history_no_update");
 raw.prepare("UPDATE verification_job_history SET event=? WHERE job_id=? AND revision=1")
  .run(JSON.stringify(["claimed","other_worker"]),j.jobId);
 assert.throws(()=>s.jobs.getJobHistory(j.jobId),error("corrupt_store"));
});
test("a failed history append rolls back the mutable head and fence atomically",t=>{
 const x=temp(t),s=x.store(),j=s.jobs.createOrGetJob("request",bindings()),raw=x.raw();
 // Test-only SQLite fault injection AFTER initialization; not a production hook.
 raw.exec("CREATE TRIGGER inject_failure BEFORE INSERT ON verification_job_history BEGIN SELECT RAISE(ABORT,'injected'); END");
 assert.throws(()=>s.jobs.claimJob(j.jobId,j.identity,0,"worker"),error("conflict"));
 assert.deepEqual(s.jobs.getJob(j.jobId),j);assert.equal(s.jobs.getJobHistory(j.jobId).length,1);
 raw.exec("DROP TRIGGER inject_failure");assert.equal(s.jobs.claimJob(j.jobId,j.identity,0,"worker").job.generation,1);
});
test("lock contention is bounded and cannot produce a phantom claim",t=>{
 const x=temp(t),s=x.store(),j=s.jobs.createOrGetJob("request",bindings()),other=new (s.constructor as typeof import("../src/index.js").LifecycleStore)(x.path,0),raw=x.raw();
 try{raw.exec("BEGIN IMMEDIATE");assert.throws(()=>other.jobs.claimJob(j.jobId,j.identity,0,"worker"),error("storage_busy"));
 }finally{raw.exec("ROLLBACK");other.close();}
 assert.equal(s.jobs.getJob(j.jobId)!.generation,0);
});
test("stored job metadata is rejected by existing process-local authorization/recovery boundaries",async t=>{
 const s=temp(t).store(),j=s.jobs.createOrGetJob("request",bindings()),b=bindings();
 const {AttestationAuthorizer}=await import(new URL("../../../../services/verifier/dist/src/attestation.js",import.meta.url).href);
 const {AttestationTransactionPolicy}=await import(new URL("../../../../services/verifier/dist/src/transaction-policy.js",import.meta.url).href);
 const {classifyRecovery}=await import(new URL("../../../../services/verifier/dist/src/attestation-recovery.js",import.meta.url).href);
 const never=async()=>{throw Error("must not be reached");};
 const a=new AttestationAuthorizer({verify:never},{read:never},b.verifier);
 const policy=new AttestationTransactionPolicy(a,{read:never},{read:never},
  {verifier:b.verifier,feePayer:b.sponsor,maxAgeMs:1000,minRemainingBlockHeights:1});
 for(const metadata of [j,JSON.parse(JSON.stringify(j)),{...j,approved:true}]){
  await assert.rejects(a.takeInstruction(metadata),(e:any)=>e.code==="invalid_authorization");
  await assert.rejects(policy.consume(metadata),(e:any)=>e.code==="invalid_transaction_authorization");
  assert.throws(()=>classifyRecovery(metadata),(e:any)=>e.code==="invalid_attempt");
 }
 const methods=Object.keys(s.jobs).sort();
 assert.deepEqual(methods,["claimJob","createOrGetJob","getJob","getJobHistory","listRecoveryRequired","transitionJob"].sort());
 assert.deepEqual(Object.keys(s.jobRecovery),["interruptJob"]);
 assert.ok(Object.isFrozen(s.jobs)&&Object.isFrozen(s.jobRecovery));
});
