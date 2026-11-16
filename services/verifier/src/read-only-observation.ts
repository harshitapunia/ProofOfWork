import {record,list,check,freeze,OfflineReadError} from "./read-only-observation-data.js";
import {validateOfflineReadPlan,correlateExecution,reconcileOfflineReadEvidence,expectedAddresses} from "./read-only-evidence.js";
import type {OfflineReadSource,OfflineReadOptions,OfflineReadQuery,ReadOnlyExecutionLookup,OfflineSourceBundle,OfflineReconciliation} from "./read-only-observation-types.js";
export * from "./read-only-observation-types.js";
export {validateOfflineReadPlan,reconcileOfflineReadEvidence} from "./read-only-evidence.js";
export {compareOfflineAccounts} from "./read-only-account-comparison.js";
export {OfflineReadError} from "./read-only-observation-data.js";
async function bounded(fn:()=>Promise<unknown>,ms:number):Promise<unknown>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  return await Promise.race([Promise.resolve().then(fn),new Promise<never>((_,reject)=>{
   timer=setTimeout(()=>reject(new OfflineReadError("mock_read_timeout")),ms);
  })]);
 }finally{if(timer!==undefined)clearTimeout(timer);}
}
/** Explicit offline-only composition. Mode does NOT authenticate data or grant operational capabilities. */
export class OfflineReadOnlyObservationAdapter{
 readonly #sources:ReadonlyMap<string,OfflineReadSource>;readonly #lookup:ReadOnlyExecutionLookup;readonly #timeout:number;
 constructor(sources:readonly OfflineReadSource[],lookup:ReadOnlyExecutionLookup,options:OfflineReadOptions){
  const map=new Map<string,OfflineReadSource>();
  for(const input of list(sources,8)){
   const s=record(input,["mode","sourceId","readStatus","readTransaction","readAccounts"]);
   check(s.mode==="offline_mock"&&typeof s.sourceId==="string"&&/^[A-Za-z0-9_-]{1,80}$/.test(s.sourceId)
    &&typeof s.readStatus==="function"&&typeof s.readTransaction==="function"&&typeof s.readAccounts==="function"&&!map.has(s.sourceId));
   map.set(s.sourceId,Object.freeze({mode:"offline_mock",sourceId:s.sourceId,readStatus:s.readStatus.bind(input),
    readTransaction:s.readTransaction.bind(input),readAccounts:s.readAccounts.bind(input)}));
  }
  check(map.size>0);
  const l=record(lookup,["get"]),o=record(options,["readTimeoutMs"]);
  check(typeof l.get==="function"&&Number.isSafeInteger(o.readTimeoutMs)&&o.readTimeoutMs>0&&o.readTimeoutMs<=10000);
  this.#lookup=Object.freeze({get:l.get.bind(lookup)});this.#timeout=o.readTimeoutMs;this.#sources=map;
 }
 async observe(input:unknown):Promise<OfflineReconciliation>{
  const plan=validateOfflineReadPlan(input);
  for(const e of plan.events)check(this.#sources.has(e.sourceId),"source_not_configured");
  const before=correlateExecution(plan,this.#lookup.get(plan.attempt.attemptId));
  check(before.revision===plan.attempt.revision,"stale_execution_revision");
  const bundles:OfflineSourceBundle[]=[];
  for(const event of plan.events){
   const source=this.#sources.get(event.sourceId)!;
   const query:OfflineReadQuery=freeze({mode:"offline_mock",sourceId:event.sourceId,requestId:plan.requestId,eventId:event.eventId,
    attemptId:plan.attempt.attemptId,attemptIdentity:plan.attempt.identity,operationKey:plan.admission.operationKey,
    transactionId:plan.submission.transactionId,minimumContextSlot:plan.minimumContextSlot,addresses:expectedAddresses(plan)});
   let status:unknown=null,transaction:unknown=null,accounts:unknown=null;
   let stage:"status"|"transaction"|"accounts"="status",interruption:OfflineSourceBundle["interruption"]=null;
   try{
    status=await bounded(()=>source.readStatus(query),this.#timeout);
    // Inspect only through the strict reconciliation path. Invalid/missing status never starts later reads.
    const preliminary=reconcileOfflineReadEvidence(plan,[{...event,status,transaction:null,accounts:null,interruption:null}],before,before);
    if(preliminary.observations[0]?.status){
     stage="transaction";transaction=await bounded(()=>source.readTransaction(query),this.#timeout);
     const detail=reconcileOfflineReadEvidence(plan,[{...event,status,transaction,accounts:null,interruption:null}],before,before);
     const observed=detail.observations[0];
     if(observed?.transactionEvidenceConsistent&&observed.status?.outcome==="success"&&observed.classification!=="conflicting_evidence"
       &&observed.classification!=="reconciliation_required"){
      stage="accounts";accounts=await bounded(()=>source.readAccounts(query),this.#timeout);
     }
    }
   }catch(e){
    const kind=e instanceof OfflineReadError&&e.code==="mock_read_timeout"?"timeout":"exception";
    interruption=(stage+"_"+kind) as OfflineSourceBundle["interruption"];
   }
   bundles.push({...event,status,transaction,accounts,interruption});
  }
  const after=correlateExecution(plan,this.#lookup.get(plan.attempt.attemptId));
  return reconcileOfflineReadEvidence(plan,bundles,before,after);
 }
}
