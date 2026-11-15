import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { fork } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { deriveInternship, deriveSponsorFallbackDestination } from "@proofwork/finance-client";
import { LifecycleStore, LifecycleError, MAX_ID, type FallbackBindings } from "../src/index.js";

const f=JSON.parse(readFileSync(new URL("../../../../packages/finance-client/test/lifecycle-rust-abi.json",import.meta.url),"utf8")).vectors[0] as {sponsor:string;student:string;verifier:string};
const bad=(code:string)=>(e:unknown)=>e instanceof LifecycleError&&e.code===code;
function temp(t:TestContext){
 const dir=mkdtempSync(join(tmpdir(),"pow-lifecycle-")),path=join(dir,"ledger.sqlite");
 const close:(()=>void)[]=[];
 t.after(()=>{for(const fn of close.reverse())try{fn();}catch{}rmSync(dir,{recursive:true,force:true});});
 return {dir,path,store(timeout=1000){const s=new LifecycleStore(path,timeout);close.push(()=>s.close());return s;},
  raw(){const d=new DatabaseSync(path);close.push(()=>d.close());return d;}};
}
test("first IDs and increasing reservations are durable and scoped",t=>{
 const x=temp(t),s=x.store();
 assert.equal(s.reserveInternship(f.sponsor).value,0n);assert.equal(s.reserveInternship(f.sponsor).value,1n);
 assert.equal(s.reserveInternship(f.student).value,0n);
 const a=deriveInternship(f.sponsor,0n)[0].toBase58(),b=deriveInternship(f.sponsor,1n)[0].toBase58();
 assert.equal(s.reserveMilestone(a).value,0n);assert.equal(s.reserveMilestone(a).value,1n);assert.equal(s.reserveMilestone(b).value,0n);
});
test("lossless maximum and above-safe-number IDs exhaust without wrap or reset",t=>{
 const x=temp(t),s=x.store();
 assert.equal(s.reserveInternship(f.sponsor,9007199254740993n).value,9007199254740993n);
 assert.equal(s.reserveInternship(f.sponsor).value,9007199254740994n);
 assert.equal(s.reserveInternship(f.student,MAX_ID).value,MAX_ID);
 assert.throws(()=>s.reserveInternship(f.student),bad("id_exhausted"));
 assert.throws(()=>s.reserveInternship(f.student,0n),bad("id_exhausted"));
});
for(const value of [-1n,MAX_ID+1n,1,"1",null,NaN]){
 test("invalid ID cannot update a counter: "+String(value),t=>{
  const s=temp(t).store();assert.throws(()=>s.reserveInternship(f.sponsor,value as never),bad("invalid_input"));
  assert.equal(s.reserveInternship(f.sponsor).value,0n);
 });
}
test("separate database connections share counters and restart history",t=>{
 const x=temp(t),a=x.store(),b=x.store();
 const r=a.reserveInternship(f.sponsor);assert.equal(b.get(r.id)!.value,0n);
 b.transition(r.id,0,"prepared",{messageDigest:"ab".repeat(32)});
 a.close();b.close();const c=x.store();
 assert.equal(c.get(r.id)!.state,"prepared");assert.equal(c.reserveInternship(f.sponsor).value,1n);
 assert.deepEqual(c.history(r.id).map(e=>e.state),["reserved","prepared"]);
 assert.equal(c.listOutstanding().length,2);
});
test("concurrent workers allocate unique IDs using real SQLite connections",{timeout:20000},async t=>{
 const x=temp(t);x.store().close();const gate=new SharedArrayBuffer(4);
 const workers=Array.from({length:4},()=>new Worker(new URL("./storage-worker.js",import.meta.url),
  {workerData:{path:x.path,sponsor:f.sponsor,gate,count:20}}));
 t.after(async()=>{await Promise.all(workers.map(w=>w.terminate()));});
 await Promise.all(workers.map(async w=>{const [msg]=await once(w,"message");assert.equal(msg,"ready");}));
 // Race all four connections per round; no worker monopolizes 20 consecutive
 // fsync transactions while another exhausts its unchanged bounded busy wait.
 const collected:string[]=[];
 for(let round=1;round<=20;round++){
  const results=workers.map(w=>once(w,"message"));
  Atomics.store(new Int32Array(gate),0,round);Atomics.notify(new Int32Array(gate),0);
  collected.push(...(await Promise.all(results)).map(([v])=>v as string));
 }
 const values=collected.map(BigInt).sort((a,b)=>a<b?-1:1);
 assert.equal(new Set(values).size,80);assert.deepEqual(values,Array.from({length:80},(_,n)=>BigInt(n)));
 assert.equal(x.store().reserveInternship(f.sponsor).value,80n);
});
test("database busy is bounded and does not consume identifiers",t=>{
 const x=temp(t),a=x.store(),b=x.store(0),raw=x.raw();
 raw.exec("BEGIN IMMEDIATE");
 assert.throws(()=>b.reserveInternship(f.sponsor),bad("storage_busy"));
 raw.exec("ROLLBACK");assert.equal(a.reserveInternship(f.sponsor).value,0n);
});
test("duplicate insert rolls back counter update and history atomically",t=>{
 const x=temp(t),s=x.store();const r=s.reserveInternship(f.sponsor),raw=x.raw();
 raw.prepare("UPDATE counters SET next=?").run("00000000000000000000");
 assert.throws(()=>s.reserveInternship(f.sponsor),bad("conflict"));
 assert.equal(raw.prepare("SELECT next FROM counters").get()!.next,"00000000000000000000");
 assert.equal(s.history(r.id).length,1);assert.equal(s.listOutstanding().length,1);
});
test("strict revision CAS rejects duplicate or stale prepared transitions",t=>{
 const x=temp(t),a=x.store(),b=x.store(),r=a.reserveInternship(f.sponsor);
 a.transition(r.id,0,"prepared",{messageDigest:"ab".repeat(32)});
 assert.throws(()=>b.transition(r.id,0,"prepared",{messageDigest:"cd".repeat(32)}),bad("conflict"));
 assert.equal(a.get(r.id)!.messageDigest,"ab".repeat(32));assert.equal(a.history(r.id).length,2);
});
test("pending/ambiguous/failed states retain IDs and never authorize confirmation/retry",t=>{
 const x=temp(t),s=x.store(),r=s.reserveInternship(f.sponsor);
 s.transition(r.id,0,"prepared",{messageDigest:"ab".repeat(32)});
 // Synthetic public 64-byte identifier; no signature is generated.
 const alphabet="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
 let n=BigInt("0x"+"07".repeat(64)),transactionId="";
 while(n){transactionId=alphabet[Number(n%58n)]+transactionId;n/=58n;}
 s.transition(r.id,1,"pending",{transactionId});
 s.transition(r.id,2,"reconciliation");
 assert.equal(s.get(r.id)!.transactionId,transactionId);
 assert.throws(()=>s.transition(r.id,3,"prepared",{messageDigest:"ef".repeat(32)}),bad("invalid_transition"));
 assert.throws(()=>s.transition(r.id,3,"confirmed" as never),bad("invalid_transition"));
 assert.equal(s.reserveInternship(f.sponsor).value,1n);
 const r2=s.reserveInternship(f.sponsor);s.transition(r2.id,0,"failed");
 assert.equal(s.reserveInternship(f.sponsor).value,3n);s.close();
 const reopened=x.store();assert.equal(reopened.get(r.id)!.state,"reconciliation");
 assert.ok(reopened.listOutstanding().some(x=>x.id===r2.id));
});
test("invalid transition metadata and unknown states roll back",t=>{
 const s=temp(t).store(),r=s.reserveInternship(f.sponsor);
 for(const metadata of [{messageDigest:"bad"},{messageDigest:"00".repeat(32)},{messageDigest:"ab".repeat(32),githubToken:"must-not-persist"}]){
  assert.throws(()=>s.transition(r.id,0,"prepared",metadata),bad("invalid_input"));
 }
 assert.throws(()=>s.transition(r.id,0,"pending",{transactionId:"invented"}),bad("invalid_transition"));
 assert.throws(()=>s.transition(r.id,0,"unknown" as never),bad("invalid_transition"));
 assert.equal(s.get(r.id)!.revision,0);assert.equal(s.history(r.id).length,1);
});
const fallback=():FallbackBindings=>({caller:f.verifier,sponsor:f.sponsor,student:f.student,internshipId:0n,milestoneId:0n,seed:"public-test-1"});
test("fallback addresses bind exact immutable operation and never recycle",async t=>{
 const x=temp(t),a=x.store(),b=x.store(),input=fallback();
 const r=await a.reserveFallback(input);
 assert.equal(r.address,(await deriveSponsorFallbackDestination(input.caller,input.seed)).toBase58());
 await assert.rejects(b.reserveFallback(input),bad("conflict"));
 await assert.rejects(b.reserveFallback({...input,milestoneId:1n}),bad("conflict"));
 a.transition(r.id,0,"failed");await assert.rejects(b.reserveFallback(input),bad("conflict"));
 const other=await b.reserveFallback({...input,seed:"public-test-2"});assert.notEqual(other.address,r.address);
 const otherCaller=await b.reserveFallback({...input,caller:f.student});assert.notEqual(otherCaller.address,r.address);
 a.close();b.close();assert.equal(x.store().get(r.id)!.bindings[8],r.bindings[8]);
});
test("fallback invalid seeds/roles/additional fields cannot persist",async t=>{
 const s=temp(t).store();
 for(const patch of [{seed:""},{seed:"a".repeat(33)},{student:f.sponsor},{caller:"invalid"},{seed:"secret/invalid"},{githubToken:"do-not-store"}]){
  await assert.rejects(s.reserveFallback({...fallback(),...patch}));
 }
 assert.equal(s.listOutstanding().length,0);
});
test("fallback bindings are snapshotted before asynchronous derivation",async t=>{
 const s=temp(t).store(),input={...fallback()},expected={...input};
 const pending=s.reserveFallback(input);input.sponsor=f.verifier;input.seed="changed";
 const r=await pending;assert.equal(r.bindings[4],expected.sponsor);assert.equal(r.value,expected.seed);
});
for(const mode of ["committed","uncommitted"]){
 test("process crash recovery: "+mode,{timeout:15000},async t=>{
  const x=temp(t);const s=x.store();
  if(mode==="uncommitted")s.reserveInternship(f.sponsor);
  const child=fork(new URL("./storage-process.js",import.meta.url),[x.path,f.sponsor,mode],{stdio:["ignore","ignore","pipe","ipc"]});
  try{
   const [msg]=await once(child,"message") as [{ready:boolean;id?:string;value?:string}];assert.equal(msg.ready,true);
   const exited=once(child,"exit");child.kill("SIGKILL");await exited;
   s.close();const reopened=x.store();assert.equal(reopened.reserveInternship(f.sponsor).value,1n);
   if(mode==="committed"){assert.equal(reopened.get(msg.id!)!.value,0n);assert.equal(reopened.history(msg.id!).length,1);}
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");}
 });
}
test("migration initializes once and rejects newer/foreign schema without discarding data",t=>{
 const x=temp(t),s=x.store();const r=s.reserveInternship(f.sponsor);s.close();
 x.store().close();const raw=x.raw();assert.equal(raw.prepare("PRAGMA user_version").get()!.user_version,5);
 raw.exec("PRAGMA user_version=6");assert.throws(()=>x.store(),bad("schema_mismatch"));
 assert.equal(raw.prepare("SELECT id FROM reservations").get()!.id,r.id);
});
test("unrecognized existing database is never adopted or erased",t=>{
 const x=temp(t),raw=x.raw();raw.exec("CREATE TABLE unrelated(value TEXT);INSERT INTO unrelated VALUES('preserved')");
 assert.throws(()=>x.store(),bad("schema_mismatch"));
 assert.equal(raw.prepare("SELECT value FROM unrelated").get()!.value,"preserved");
 assert.equal(raw.prepare("PRAGMA user_version").get()!.user_version,0);
});
test("schema tampering is detected rather than silently migrated",t=>{
 const x=temp(t);x.store().close();const raw=x.raw();raw.exec("ALTER TABLE reservations ADD COLUMN unwanted TEXT");
 assert.throws(()=>x.store(),bad("schema_mismatch"));
});
for(const field of ["bindings","identity","state","message_digest"]){
 test("malformed persisted metadata fails closed: "+field,t=>{
  const x=temp(t),s=x.store(),r=s.reserveInternship(f.sponsor),raw=x.raw();
  if(field==="state")raw.exec("PRAGMA ignore_check_constraints=ON");
  const value=field==="bindings"?'["malformed"]':field==="state"?"unknown":"bad";
  raw.prepare("UPDATE reservations SET "+field+"=? WHERE id=?").run(value,r.id);
  assert.throws(()=>s.get(r.id),bad("corrupt_store"));
  assert.throws(()=>s.listOutstanding(),bad("corrupt_store"));
 });
}
test("stored confirmed claims are not accepted without a future trusted adapter",t=>{
 const x=temp(t),s=x.store(),r=s.reserveInternship(f.sponsor),raw=x.raw();
 raw.prepare("UPDATE reservations SET state='confirmed' WHERE id=?").run(r.id);
 assert.throws(()=>s.get(r.id),bad("corrupt_store"));
 assert.throws(()=>s.listOutstanding(),bad("corrupt_store"));
});
test("database paths, closed handles, scope addresses and pagination are bounded",t=>{
 const x=temp(t),s=x.store();
 assert.throws(()=>new LifecycleStore(":memory:"),bad("invalid_input"));
 assert.throws(()=>new LifecycleStore("relative.sqlite"),bad("invalid_input"));
 assert.throws(()=>s.reserveInternship("invalid"),bad("invalid_input"));
 assert.throws(()=>s.reserveMilestone("invalid"),bad("invalid_input"));
 for(const n of [0,101,NaN])assert.throws(()=>s.listOutstanding(undefined,n),bad("invalid_input"));
 const at=join(x.dir,"link.sqlite");symlinkSync(x.path,at);
 assert.throws(()=>new LifecycleStore(at),bad("invalid_input"));
 const dangling=join(x.dir,"dangling.sqlite");symlinkSync(join(x.dir,"missing.sqlite"),dangling);
 assert.throws(()=>new LifecycleStore(dangling),bad("invalid_input"));
 const first=s.reserveInternship(f.sponsor),second=s.reserveInternship(f.sponsor);
 const page=s.listOutstanding(undefined,1);assert.equal(page.length,1);
 assert.equal(s.listOutstanding(page[0]!.id,1).length,1);
 assert.ok(first.id!==second.id);s.close();s.close();assert.throws(()=>s.get(first.id),bad("closed"));
});

test("unexpected triggers or tables cannot hide behind a matching version",t=>{
 const x=temp(t);x.store().close();const raw=x.raw();
 raw.exec("CREATE TRIGGER unexpected AFTER INSERT ON history BEGIN SELECT 1; END");
 assert.throws(()=>x.store(),bad("schema_mismatch"));
});

test("persisted history cannot invent confirmation or skip lifecycle transitions",t=>{
 const x=temp(t),s=x.store(),r=s.reserveInternship(f.sponsor);
 s.transition(r.id,0,"prepared",{messageDigest:"ab".repeat(32)});
 const raw=x.raw();raw.prepare("UPDATE history SET state='confirmed' WHERE reservation_id=? AND revision=0").run(r.id);
 assert.throws(()=>s.get(r.id),bad("corrupt_store"));
 assert.throws(()=>s.history(r.id),bad("corrupt_store"));
 assert.throws(()=>s.listOutstanding(),bad("corrupt_store"));
});

test("pinned engine never enables the affected WAL mode",t=>{
 const x=temp(t);x.store();const raw=x.raw();
 assert.equal(raw.prepare("PRAGMA journal_mode").get()!.journal_mode,"delete");
});

test("untrusted metadata inspection never leaks raw exceptions",async t=>{
 const s=temp(t).store(),r=s.reserveInternship(f.sponsor);
 const evil=new Proxy({}, {ownKeys(){throw new Error("private sentinel must not leak");}});
 assert.throws(()=>s.transition(r.id,0,"prepared",evil as never),bad("invalid_input"));
 await assert.rejects(s.reserveFallback(evil as never),bad("invalid_input"));
});

test("sqliteCache is a user table, never an empty adoptable database",t=>{
 const x=temp(t),raw=x.raw();raw.exec("CREATE TABLE sqliteCache(value TEXT);INSERT INTO sqliteCache VALUES('preserved')");
 assert.throws(()=>x.store(),bad("schema_mismatch"));
 assert.equal(raw.prepare("SELECT value FROM sqliteCache").get()!.value,"preserved");
 assert.equal(raw.prepare("PRAGMA user_version").get()!.user_version,0);
});
test("sqliteAudit is a user trigger and must fail schema validation",t=>{
 const x=temp(t);x.store().close();const raw=x.raw();
 raw.exec("CREATE TRIGGER sqliteAudit AFTER INSERT ON history BEGIN SELECT 1; END");
 assert.throws(()=>x.store(),bad("schema_mismatch"));
});
for(const column of ["message_digest","transaction_id"]){
 test("terminal history retains pending metadata: "+column,t=>{
  const x=temp(t),s=x.store(),r=s.reserveInternship(f.sponsor);
  s.transition(r.id,0,"prepared",{messageDigest:"ab".repeat(32)});
  const alphabet="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n=BigInt("0x"+"07".repeat(64)),transactionId="";
  while(n){transactionId=alphabet[Number(n%58n)]+transactionId;n/=58n;}
  s.transition(r.id,1,"pending",{transactionId});s.transition(r.id,2,"reconciliation");
  x.raw().prepare("UPDATE reservations SET "+column+"=NULL WHERE id=?").run(r.id);
  assert.throws(()=>s.get(r.id),bad("corrupt_store"));
  assert.throws(()=>s.listOutstanding(),bad("corrupt_store"));
 });
}
test("direct reconciliation has no invented prepared or pending metadata",t=>{
 const x=temp(t),s=x.store(),r=s.reserveInternship(f.sponsor);
 s.transition(r.id,0,"reconciliation");
 assert.equal(s.get(r.id)!.messageDigest,undefined);assert.equal(s.get(r.id)!.transactionId,undefined);
 assert.deepEqual(s.history(r.id).map(e=>e.state),["reserved","reconciliation"]);
});
