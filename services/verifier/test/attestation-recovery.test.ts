import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, sha256 } from "../src/commitments.js";
import { createRecoveryAttempt, createOfflineRecoveryObserver, transitionRecovery, classifyRecovery, RecoveryError,
  type RecoveryAttempt, type RecoveryBindings, type RecoveryEvent, type RecoveryObservation, type RecoveryStore } from "../src/attestation-recovery.js";
import { fixture } from "./helpers.js";

// Synthetic public transaction IDs only: 64 decoded bytes, with no signatures generated.
const TX="1".repeat(63)+"2", OTHER_TX="1".repeat(63)+"3";
function binding(): RecoveryBindings {
  const f=fixture();
  return {cluster:"devnet",genesisHash:"EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",programId:PROGRAM_ID.toBase58(),
    milestone:f.milestone.toBase58(),submission:f.submission.toBase58(),student:f.request.student,
    verifier:f.verifier.toBase58(),feePayer:new PublicKey(f.i.subarray(8,40)).toBase58(),
    requirementsHash:f.requirements.toString("hex"),evidenceHash:f.evidence.toString("hex"),
    messageDigest:sha256(Buffer.from("synthetic unsigned message; never signed")).toString("hex"),
    blockhash:f.internship.toBase58(),lastValidBlockHeight:200};
}
const create=()=>createRecoveryAttempt("attempt-1",binding());
const code=(c:string)=>(e:unknown)=>e instanceof RecoveryError && e.code===c;
async function step(a: RecoveryAttempt,event: RecoveryEvent,eventId="event-"+(a.revision+1)):Promise<RecoveryAttempt> {
  const source=createOfflineRecoveryObserver(async()=>({attemptId:a.attemptId,expectedRevision:a.revision,bindings:a.bindings,eventId,event}));
  return transitionRecovery(a,await source.observe(a));
}
async function submitted() {return step(await step(create(),{kind:"signing_started"}),{kind:"submission_started",transactionId:TX});}
const status=(outcome:"success"|"failure",finality:"processed"|"confirmed"|"finalized"="confirmed",slot=100):RecoveryEvent=>
  ({kind:"transaction_status",transactionId:TX,outcome,finality,slot});
function denied(a: RecoveryAttempt) {
  const c=classifyRecovery(a);assert.equal(c.retryAuthorized,false);assert.equal(c.submissionAuthorized,false);
  assert.equal(c.reservation,"retained");assert.equal(c.observationsOnly,true);
}

test("normal observed lifecycle is immutable and never grants execution",async()=>{
  const a=create(),s=await step(a,{kind:"signing_started"}),b=await step(s,{kind:"submission_started",transactionId:TX});
  const pending=await step(b,{kind:"submission_acknowledged",transactionId:TX});
  const confirmed=await step(pending,status("success")),finalized=await step(confirmed,status("success","finalized"));
  assert.deepEqual([a,s,b,pending,confirmed,finalized].map(x=>x.state),["authorization_prepared","signing_initiated","submission_initiated","confirmation_pending","success_observed","success_observed"]);
  assert.equal(classifyRecovery(finalized).finality,"finalized");
  for(const x of [a,s,b,pending,confirmed,finalized]) {denied(x);assert.ok(Object.isFrozen(x)&&Object.isFrozen(x.bindings)&&Object.isFrozen(x.events));assert.equal(x.identity,a.identity);}
  assert.equal(a.revision,0);assert.equal(a.transactionId,undefined);assert.equal(finalized.transactionId,TX);
});
for(const event of [{kind:"submission_started",transactionId:TX},{kind:"submission_acknowledged",transactionId:TX},
  {kind:"signing_timeout"},{kind:"submission_timeout"},{kind:"signing_failed"}] as const) {
  test("rejects out-of-order "+event.kind,async()=>assert.rejects(step(create(),event),code("invalid_transition")));
}
test("missing transaction evidence cannot become an observed success",async()=>{
  await assert.rejects(step(create(),status("success")),code("missing_transaction_evidence"));
  const a=await step(create(),{kind:"signing_started"});
  for(const value of [undefined,"",TX.slice(1),"bad!", "1".repeat(64)])
    await assert.rejects(step(a,{kind:"submission_started",transactionId:value as string}),code("invalid_transaction_id"));
});
for(const event of ["rpc_timeout","unknown_status","null_lookup","history_missing","crash"] as const) {
  test(event+" remains unresolved and reservation retained",async()=>{
    const next=await step(await submitted(),{kind:event});assert.equal(next.state,"recovery_blocked");
    assert.equal(classifyRecovery(next).kind,"reconciliation_required");denied(next);
    await assert.rejects(step(next,{kind:"signing_started"}),code("invalid_transition"));
    await assert.rejects(step(next,{kind:"submission_started",transactionId:TX}),code("invalid_transition"));
  });
}
test("signing timeout and crash before submission never permit a new signing action",async()=>{
  const s=await step(create(),{kind:"signing_started"});
  for(const event of [{kind:"signing_timeout"},{kind:"crash"}] as const) {
    const next=await step(s,event);denied(next);
    await assert.rejects(step(next,{kind:"submission_started",transactionId:TX}),code("invalid_transition"));
    await assert.rejects(step(next,status("success")),code("missing_transaction_evidence"));
  }
});
test("submission timeout accepts late matching completion as observation only",async()=>{
  const unknown=await step(await submitted(),{kind:"submission_timeout"});
  assert.equal(unknown.state,"submission_uncertain");denied(unknown);
  const late=await step(unknown,{kind:"submission_acknowledged",transactionId:TX});
  assert.equal(late.state,"confirmation_pending");denied(late);
  const done=await step(late,status("success","finalized"));denied(done);
});
test("unknown submission side effects require reconciliation",async()=>{
  const a=await step(await submitted(),{kind:"submission_side_effects_unknown"});
  assert.equal(classifyRecovery(a).kind,"reconciliation_required");denied(a);
});
for(const event of [{kind:"preparation_failed"},{kind:"signing_failed"}] as const) {
  test(event.kind+" is an observed failure, never retry permission",async()=>{
    const a=event.kind==="signing_failed"?await step(create(),{kind:"signing_started"}):create();
    const next=await step(a,event);assert.equal(next.state,"failure_observed");denied(next);
    await assert.rejects(step(next,{kind:"signing_started"}),code("invalid_transition"));
  });
}
test("processed transaction error is unresolved; later confirmed evidence can resolve it",async()=>{
  const a=await step(await submitted(),status("failure","processed"));
  assert.equal(a.state,"recovery_blocked");assert.equal(a.transaction,undefined);denied(a);
  const b=await step(a,status("success","confirmed"));assert.equal(b.state,"success_observed");denied(b);
});
for(const outcome of ["success","failure"] as const) {
  test(outcome+" observations require evidence and preserve finality",async()=>{
    const confirmed=await step(await submitted(),status(outcome));
    assert.equal(classifyRecovery(confirmed).kind,outcome==="success"?"success_observed":"failure_observed");denied(confirmed);
    const finalized=await step(confirmed,status(outcome,"finalized"));denied(finalized);
    await assert.rejects(step(finalized,status(outcome,"finalized")),code("consumed_state"));
    await assert.rejects(step(confirmed,status(outcome==="success"?"failure":"success","finalized")),code("contradictory_observation"));
    await assert.rejects(step(confirmed,status(outcome,"finalized",101)),code("contradictory_observation"));
    await assert.rejects(step(confirmed,status(outcome,"processed")),code("contradictory_observation"));
  });
}
test("expired blockhash alone does not prove failure or rule out earlier success",async()=>{
  const a=await submitted();
  await assert.rejects(step(a,{kind:"blockhash_expired",currentBlockHeight:200}),code("invalid_expiry"));
  const expired=await step(a,{kind:"blockhash_expired",currentBlockHeight:201});
  assert.equal(expired.transaction,undefined);assert.equal(expired.state,"recovery_blocked");denied(expired);
  const historical=await step(expired,status("success","finalized"));assert.equal(historical.state,"success_observed");denied(historical);
});
test("crash points remain blocked across a new observer instance",async()=>{
  for(const a of [create(),await step(create(),{kind:"signing_started"}),await submitted(),
    await step(await submitted(),{kind:"submission_acknowledged",transactionId:TX})]) {
    const crash=await step(a,{kind:"crash"});assert.equal(crash.state,"recovery_blocked");denied(crash);
    const again=await step(crash,{kind:"history_missing"});denied(again);assert.equal(again.identity,a.identity);
  }
});
test("stale events against a newer head and lifecycle restarts are rejected",async()=>{
  const a=create();
  const observer=createOfflineRecoveryObserver(async()=>({attemptId:a.attemptId,expectedRevision:0,bindings:a.bindings,eventId:"same",event:{kind:"signing_started"}}));
  const token=await observer.observe(a),next=transitionRecovery(a,token);
  assert.throws(()=>transitionRecovery(next,token),code("observation_conflict"));
  await assert.rejects(step(next,{kind:"signing_started"}),code("invalid_transition"));
  await assert.rejects(step(next,{kind:"rpc_timeout"},"same"),code("duplicate_event"));
});
test("client JSON, serialized tokens and retry events cannot authorize recovery",async()=>{
  const a=create();
  for(const token of [{approved:true,status:"confirmed"},{},null])
    assert.throws(()=>transitionRecovery(a,token as unknown as RecoveryObservation),code("untrusted_observation"));
  await assert.rejects(step(a,{kind:"retry"} as unknown as RecoveryEvent),code("invalid_observation"));
  await assert.rejects(step(a,{kind:"signing_started",approved:true} as unknown as RecoveryEvent),code("invalid_observation"));
});
test("bindings, identity and transaction evidence cannot be substituted",async()=>{
  const a=create(),b=await submitted();
  for(const field of ["milestone","submission","verifier","feePayer","student","blockhash","requirementsHash","evidenceHash","messageDigest","lastValidBlockHeight"] as const) {
    const changed={...a.bindings,[field]:field==="lastValidBlockHeight"?201:field.endsWith("Hash")||field==="messageDigest"?"aa".repeat(32):a.bindings.blockhash};
    if(changed[field]===a.bindings[field]) (changed as unknown as Record<string,unknown>)[field]=a.bindings.student;
    const observer=createOfflineRecoveryObserver(async()=>({attemptId:a.attemptId,expectedRevision:a.revision,bindings:changed,eventId:"changed",event:{kind:"rpc_timeout"}}));
    await assert.rejects(observer.observe(a),e=>e instanceof RecoveryError);
  }
  assert.throws(()=>classifyRecovery({...a,state:"success_observed"}),code("invalid_attempt"));
  assert.throws(()=>classifyRecovery(JSON.parse(JSON.stringify(a)) as RecoveryAttempt),code("invalid_attempt"));
  await assert.rejects(step(b,{kind:"submission_acknowledged",transactionId:OTHER_TX}),code("transaction_substitution"));
  await assert.rejects(step(b,{...status("success"),transactionId:OTHER_TX} as RecoveryEvent),code("transaction_substitution"));
  assert.throws(()=>{(a.bindings as {milestone:string}).milestone=a.bindings.student;},TypeError);
});
for(const change of [{cluster:"mainnet"},{genesisHash:"wrong"},{programId:"11111111111111111111111111111111"},
  {lastValidBlockHeight:-1},{lastValidBlockHeight:Number.MAX_SAFE_INTEGER+1},{requirementsHash:"00".repeat(32)},
  {messageDigest:"bad"},{milestone:"bad"},{evidenceHash:"00".repeat(32)}]) {
  test("rejects malformed initial binding "+Object.keys(change)[0]+JSON.stringify(change),()=>{
    assert.throws(()=>createRecoveryAttempt("attempt",{...binding(),...change} as RecoveryBindings),e=>e instanceof RecoveryError);
  });
}
test("records and injected evidence are copied, and classification has no network or execution hooks",async()=>{
  const raw=binding(),a=createRecoveryAttempt("copy-test",raw);(raw as {blockhash:string}).blockhash=raw.student;
  assert.notEqual(a.bindings.blockhash,raw.blockhash);
  const event={kind:"signing_started"} as const;
  const input={attemptId:a.attemptId,expectedRevision:0,bindings:a.bindings,eventId:"copy",event};
  const observer=createOfflineRecoveryObserver(async()=>input);const token=await observer.observe(a);
  (input as {event:RecoveryEvent}).event={kind:"submission_started",transactionId:TX};
  assert.equal(transitionRecovery(a,token).state,"signing_initiated");
  const source=await readFile(new URL("../../src/attestation-recovery.ts",import.meta.url),"utf8");
  assert.ok(!/\b(fetch|signMessage|sendTransaction|submit|Keypair)\s*\(/.test(source));
});
/** Test-only atomic map; not a persistence implementation or production reservation manager. */
class StoreDouble implements RecoveryStore {
  readonly records=new Map<string,RecoveryAttempt>();
  async insertIfAbsent(a:RecoveryAttempt):Promise<boolean> {
    if(this.records.has(a.operationKey))return false;this.records.set(a.operationKey,a);return true;
  }
  async read(k:string) {return this.records.get(k);}
  async compareAndSwap(previous:RecoveryAttempt,next:RecoveryAttempt):Promise<boolean> {
    if(this.records.get(previous.operationKey)!==previous || next.identity!==previous.identity || next.operationKey!==previous.operationKey || next.revision!==previous.revision+1)return false;
    this.records.set(previous.operationKey,next);return true;
  }
}
test("future store contract prevents concurrent forks and second attempts for the same milestone",async()=>{
  const store=new StoreDouble(),a=create();
  const competing=createRecoveryAttempt("other-attempt",a.bindings);
  const inserted=await Promise.all([store.insertIfAbsent(a),store.insertIfAbsent(competing)]);
  assert.equal(inserted.filter(Boolean).length,1);
  const x=await step(a,{kind:"signing_started"}),y=await step(a,{kind:"preparation_failed"});
  const results=await Promise.all([store.compareAndSwap(a,x),store.compareAndSwap(a,y)]);
  assert.equal(results.filter(Boolean).length,1);
  const saved=await store.read(a.operationKey);assert.equal(saved,x);denied(saved!);
  assert.equal(await store.insertIfAbsent(competing),false);
  assert.equal(await store.compareAndSwap(x,{...x,attemptId:"other-attempt",identity:competing.identity,revision:2}),false);
  assert.equal("delete" in store,false);assert.equal("release" in store,false);
});


test("stale revisions, changed observation identity and unexpected fields are rejected",async()=>{
  const a=create();
  for(const patch of [{attemptId:"other-attempt"},{expectedRevision:1},{eventId:"bad event"},{approved:true}]) {
    const observer=createOfflineRecoveryObserver(async()=>({...{attemptId:a.attemptId,expectedRevision:0,bindings:a.bindings,eventId:"event",event:{kind:"rpc_timeout"} as const},...patch}));
    await assert.rejects(observer.observe(a),e=>e instanceof RecoveryError);
  }
});
test("malformed transaction observations and incorrect current heights fail closed",async()=>{
  const a=await submitted();
  for(const event of [{...status("success"),slot:-1},{...status("success"),slot:NaN},
    {...status("success"),outcome:"unknown"},{...status("success"),finality:"untrusted"},
    {kind:"blockhash_expired",currentBlockHeight:Infinity}]) {
    await assert.rejects(step(a,event as RecoveryEvent),e=>e instanceof RecoveryError);
  }
});
test("observation history is bounded without granting retries or discarding reservations",async()=>{
  let a=create();
  for(let i=0;i<128;i++) a=await step(a,{kind:"rpc_timeout"});
  denied(a);assert.equal(a.events.length,128);
  await assert.rejects(step(a,{kind:"rpc_timeout"}),code("observation_limit"));
});
test("serialized observation tokens cannot be replayed",async()=>{
  const a=create();
  const observer=createOfflineRecoveryObserver(async()=>({attemptId:a.attemptId,expectedRevision:0,bindings:a.bindings,eventId:"event",event:{kind:"rpc_timeout"}}));
  const token=await observer.observe(a);
  assert.throws(()=>transitionRecovery(a,JSON.parse(JSON.stringify(token)) as RecoveryObservation),code("untrusted_observation"));
});


for(const failure of ["preparation_failed","signing_failed"] as const) {
  test("local "+failure+" cannot regress after later uncertainty",async()=>{
    const initial=failure==="signing_failed"?await step(create(),{kind:"signing_started"}):create();
    const failed=await step(initial,{kind:failure});
    for(const event of [{kind:"rpc_timeout"},{kind:"unknown_status"},{kind:"null_lookup"},{kind:"history_missing"},
      {kind:"crash"},{kind:"blockhash_expired",currentBlockHeight:201}] as const) {
      await assert.rejects(step(failed,event),code("invalid_transition"));
      assert.equal(classifyRecovery(failed).kind,"failure_observed");denied(failed);
    }
  });
}
test("binding accessors are rejected before evaluation or retaining a changing value",()=>{
  const raw=binding();let reads=0;
  Object.defineProperty(raw,"lastValidBlockHeight",{enumerable:true,get:()=>++reads===1?200:-1});
  assert.throws(()=>createRecoveryAttempt("accessor",raw),code("invalid_bindings"));assert.equal(reads,0);
});
test("array, proxy, symbol and nonenumerable binding properties fail closed",()=>{
  const array=Object.assign([],binding());
  assert.throws(()=>createRecoveryAttempt("array",array as unknown as RecoveryBindings),code("invalid_bindings"));
  const proxy=new Proxy(binding(),{});
  assert.throws(()=>createRecoveryAttempt("proxy",proxy),code("invalid_bindings"));
  for(const hidden of [Symbol("extra"),"extra"]) {
    const raw=binding();Object.defineProperty(raw,hidden,{value:"unexpected",enumerable:typeof hidden==="symbol"});
    assert.throws(()=>createRecoveryAttempt("hidden",raw),code("invalid_bindings"));
  }
});
test("observation source cannot hide accessors, symbols or array-shaped event records",async()=>{
  const a=create(),raw={attemptId:a.attemptId,expectedRevision:0,bindings:a.bindings,eventId:"event",event:{kind:"rpc_timeout"} as RecoveryEvent};
  let reads=0;
  const accessor={...raw};Object.defineProperty(accessor,"event",{enumerable:true,get:()=>{reads++;return raw.event;}});
  await assert.rejects(createOfflineRecoveryObserver(async()=>accessor).observe(a),code("invalid_observation"));assert.equal(reads,0);
  const symbol={...raw,[Symbol("extra")]:true};
  await assert.rejects(createOfflineRecoveryObserver(async()=>symbol).observe(a),code("invalid_observation"));
  const eventAccessor={...raw,event:{}};
  Object.defineProperty(eventAccessor.event,"kind",{enumerable:true,get:()=>{reads++;return "rpc_timeout";}});
  await assert.rejects(createOfflineRecoveryObserver(async()=>eventAccessor as typeof raw).observe(a),code("invalid_observation"));assert.equal(reads,0);
  const arrayEvent={...raw,event:Object.assign([],{kind:"rpc_timeout"})};
  await assert.rejects(createOfflineRecoveryObserver(async()=>arrayEvent as unknown as typeof raw).observe(a),code("invalid_observation"));
});
test("pure historical evaluations never claim replay exclusion without an atomic accepted head",async()=>{
  const a=create();
  const x=await step(a,{kind:"signing_started"},"branch-x"),y=await step(a,{kind:"crash"},"branch-y");
  denied(x);denied(y);const store=new StoreDouble();assert.equal(await store.insertIfAbsent(a),true);
  assert.equal(await store.compareAndSwap(a,x),true);assert.equal(await store.compareAndSwap(a,y),false);
  assert.equal(await store.read(a.operationKey),x);
});
