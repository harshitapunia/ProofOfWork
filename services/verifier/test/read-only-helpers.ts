/** Public signed wire reused from Phase 8C-2B; raw post-state fixtures never sign or send. */
import {readFileSync} from "node:fs";
import {PublicKey} from "@solana/web3.js";
import {DEMO_MINT,deriveVault,deriveVaultAuthority,deriveCompletion} from "@proofwork/finance-client";
import {LifecycleStore,INTENT_FORMAT,type ExecutionAttempt} from "@proofwork/lifecycle";
import {protocolFixture} from "./protocol-helpers.js";
import {fixture as rawFixture} from "./helpers.js";
import {protocolDataDigest} from "../src/operational-protocol.js";
import {OfflineReadOnlyObservationAdapter,reconcileOfflineReadEvidence,type OfflineReadPlan,type OfflineSourceBundle,type RawAccountSet,type OfflineReadSource} from "../src/read-only-observation.js";
export function observationFixture(){
 const f=protocolFixture(),b=f.anchor.bindings;
 const plan:OfflineReadPlan={kind:"offline_read_plan",attempt:{attemptId:f.anchor.jobId,identity:"ab".repeat(32),revision:0},
  admission:f.admission,submission:f.submission,anchor:f.anchor,snapshot:f.snapshot,requestId:"fixture_query",minimumContextSlot:"120",
  events:[{sourceId:"fixture_provider",eventId:"fixture_event"}],priorEvents:[]};
 const view={...plan.attempt,mode:"offline-test-model",wireDigest:null,testTransactionId:null,intent:{intentId:f.anchor.intentId,identity:f.anchor.intentIdentity,
  jobId:f.anchor.jobId,jobIdentity:f.anchor.jobIdentity,operationKey:f.admission.operationKey,bindings:b,feePayer:f.anchor.feePayer,
  state:"preparation_recorded",workerId:"worker",generation:1,jobRevision:4,reconciliationRequired:false,
  preparation:{identity:"cd".repeat(32),format:INTENT_FORMAT,messageDigest:f.anchor.messageDigest,blockhash:f.anchor.blockhash,
   lastValidBlockHeight:"200",observedBlockHeight:"100"}}} as unknown as ExecutionAttempt;
 const raw=rawFixture();
 new PublicKey(b.verifier).toBuffer().copy(raw.m,104);new PublicKey(DEMO_MINT).toBuffer().copy(raw.m,136);
 Buffer.from(b.requirementsHash,"hex").copy(raw.m,200);Buffer.from(b.evidenceHash,"hex").copy(raw.s,72);
 raw.m[274]=deriveVault(b.milestone)[1];raw.m[275]=deriveVaultAuthority(b.milestone)[1];
 raw.m[272]=4;raw.m.writeBigInt64LE(160n,264);
 const wrap=(address:string,data:Buffer)=>({address,account:{owner:b.programId,executable:false,data:[data.toString("base64"),"base64"] as const}});
 const accounts:RawAccountSet={internship:wrap(b.internship,raw.i),milestone:wrap(b.milestone,raw.m),
  submission:wrap(b.submission,raw.s),completion:{address:deriveCompletion(b.milestone)[0].toBase58(),account:null}};
 const provenance=(slot:string)=>({...f.observation.provenance,contextSlot:slot});
 const bundle:OfflineSourceBundle={...plan.events[0]!,status:{kind:"status_read",provenance:provenance("121"),currentBlockHeight:"150",evidence:f.status},
  transaction:{kind:"transaction_read",provenance:provenance("122"),commitment:"finalized",transactionId:f.submission.transactionId,
   wireBase64:f.submission.wireBase64,wireDigest:f.submission.wireDigest,transactionSlot:"120",outcome:"success",errorCode:null},
  accounts:{kind:"accounts_read",provenance:provenance("123"),commitment:"finalized",accounts},interruption:null};
 const reconcile=(bundles:unknown=[bundle],after:unknown=view)=>reconcileOfflineReadEvidence(plan,bundles,view,after);
 return {f,plan,view,accounts,bundle,reconcile};
}
export function mockSource(bundle:OfflineSourceBundle,calls:string[]=[]):OfflineReadSource{
 return {mode:"offline_mock",sourceId:bundle.sourceId,
  readStatus:async q=>{calls.push("status");if(q.transactionId!== (bundle.status as any)?.evidence?.transactionId
   &&(bundle.status as any)?.evidence?.kind==="status_claim")throw Error("query_identity");return structuredClone(bundle.status);},
  readTransaction:async()=>{calls.push("transaction");return structuredClone(bundle.transaction);},
  readAccounts:async()=>{calls.push("accounts");return structuredClone(bundle.accounts);}};
}
export function adapter(x:ReturnType<typeof observationFixture>,source=mockSource(x.bundle),get=()=>x.view){
 return new OfflineReadOnlyObservationAdapter([source],{get},{readTimeoutMs:1000});
}
export function mutateBytes(a:RawAccountSet,key:keyof RawAccountSet,fn:(d:Buffer)=>void){
 const d=Buffer.from(a[key].account!.data[0],"base64");fn(d);(a[key].account!.data as [string,string])[0]=d.toString("base64");
}
export function settled(x:ReturnType<typeof observationFixture>){
 mutateBytes(x.accounts,"milestone",d=>{d[272]=5;});
 const layouts=JSON.parse(readFileSync(new URL("../../../lifecycle/test/rust-layouts.json",import.meta.url),"utf8"));
 const c=Buffer.from(layouts.cases.find((v:any)=>v.status===5).completion.hex,"hex"),b=x.f.anchor.bindings;
 for(const [offset,address] of [[8,b.milestone],[40,b.student],[72,b.sponsor],[104,b.verifier],[136,b.submission]] as const)
  new PublicKey(address).toBuffer().copy(c,offset);
 Buffer.from(b.requirementsHash,"hex").copy(c,168);Buffer.from(b.evidenceHash,"hex").copy(c,200);
 c.writeBigInt64LE(160n,232);c.writeBigInt64LE(170n,240);c[248]=deriveCompletion(b.milestone)[1];
 (x.accounts.completion as any).account={owner:b.programId,executable:false,data:[c.toString("base64"),"base64"]};
}
/** Genuine schema-v5 ledger using public fixture identities; no key generation or signature creation. */
export function ledgerFixture(path:string){
 const x=observationFixture(),s=new LifecycleStore(path),b=x.f.anchor.bindings;
 const initial=s.jobs.createOrGetJob("observation_job",b),claimed=s.jobs.claimJob(initial.jobId,initial.identity,0,"worker");
 let job=claimed.job;
 for(const phase of ["verification_running","verification_completed","authorization_pending"] as const)
  job=s.jobs.transitionJob(claimed.claim,job.revision,phase);
 const first=s.transactionIntents.createIntent(claimed.claim,job.revision,"observation_intent",x.f.anchor.feePayer).intent;
 const intent=s.transactionIntents.recordPreparation(claimed.claim,job.revision,first.intentId,first.identity,0,{
  format:INTENT_FORMAT,messageDigest:x.f.anchor.messageDigest,blockhash:x.f.anchor.blockhash,lastValidBlockHeight:"200",observedBlockHeight:"100"});
 const attempt=s.executionAttempts.create(claimed.claim,job.revision,"observation_attempt",intent.intentId,intent.identity,rawFixture().verifier.toBase58()).attempt;
 Object.assign(x.plan.anchor,{jobId:job.jobId,jobIdentity:job.identity,intentId:intent.intentId,intentIdentity:intent.identity});
 Object.assign(x.plan.admission,{jobId:job.jobId,jobIdentity:job.identity,intentId:intent.intentId,intentIdentity:intent.identity});
 Object.assign(x.plan.submission,{admissionDigest:protocolDataDigest(x.plan.admission)});
 Object.assign(x.plan,{attempt:{attemptId:attempt.attemptId,identity:attempt.identity,revision:attempt.revision}});
 const snapshot=()=>({attempt:s.executionAttempts.get(attempt.attemptId),history:s.executionAttempts.history(attempt.attemptId),
  job:s.jobs.getJob(job.jobId),intent:s.transactionIntents.getIntent(intent.intentId),intentHistory:s.transactionIntents.getIntentHistory(intent.intentId)});
 return {...x,s,job,claim:claimed.claim,attempt,snapshot,lookup:{get:(id:string)=>s.executionAttempts.get(id)}};
}
