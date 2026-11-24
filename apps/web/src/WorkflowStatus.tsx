import {useEffect,useRef,useState,type FormEvent} from "react";
import {ApiError,ENVELOPE,message,request,base64,type Session} from "./api";
import type {Preparation} from "./Workflow";
interface State {kind:"workflow_state";internship:string;milestone:string;internshipExists:boolean;milestoneExists:boolean;status:string|null;student:string|null;verifier:string|null;requirementsHash:string|null;rewardAmountRaw:string|null;evidenceHash:string|null;verifiedAt:string|null;completion:string|null;settledAt:string|null;vaultAmountRaw:string|null;vaultClosed:boolean|null;slot:number;commitment:"confirmed";provenance:"offline_fixture"|"unverified_devnet_rpc";persisted:false;rewardPayment:"not_established"}
interface Handoff {kind:"verification_handoff";request:object;dispatch:"unavailable";authorization:"not_granted";persisted:false;rewardPayment:"not_established"}
export function WorkflowStatus({session,role,prepared,workflow,onExpired}:{session:Session;role:"organization"|"student";prepared:Preparation|null;workflow:object|null;onExpired:()=>void}){
 const [target,setTarget]=useState({sponsor:role==="organization"?session.wallet:"",internshipId:"",milestoneId:""});
 const [state,setState]=useState<State|null>(null),[handoff,setHandoff]=useState<Handoff|null>(null),[evidence,setEvidence]=useState("");
 const [busy,setBusy]=useState(false),[error,setError]=useState("");const generation=useRef(0),pending=useRef<AbortController|null>(null);
 const clear=()=>{generation.current++;pending.current?.abort();setState(null);setHandoff(null);setError("");setBusy(false);};
 useEffect(()=>()=>{generation.current++;pending.current?.abort();},[]);
 useEffect(()=>{
  clear();setEvidence("");
  if(!prepared||!workflow)return;
  const t=prepared.terms;setTarget({sponsor:t.sponsor,internshipId:t.internshipId,milestoneId:t.milestoneId});
  const w=workflow as {action?:string;evidence?:object};
  if(w.action==="submission"&&w.evidence){
   try{setEvidence(JSON.stringify({manifestBase64:base64(new TextEncoder().encode(t.manifest)),milestone:prepared.milestone,student:session.wallet,
    repositoryId:JSON.parse(t.manifest).repositoryId,owner:t.owner,repository:t.repository,...w.evidence},null,2));}catch{/* Server validates any later explicit handoff. */}
  }
 },[prepared,workflow,session.wallet]);
 async function inspect(event:FormEvent,verification=false){event.preventDefault();const n=++generation.current;pending.current?.abort();
  const controller=new AbortController();pending.current=controller;setError("");setBusy(true);setHandoff(null);if(!verification)setState(null);
  try{const body={...ENVELOPE,...target,...(verification?{evidence:JSON.parse(evidence)}:{})};
   const r=verification?await request<Handoff>("/api/v1/workflow/verification","verification_handoff",body,AbortSignal.any([controller.signal,AbortSignal.timeout(12000)]))
    :await request<State>("/api/v1/workflow/state","workflow_state",body,AbortSignal.any([controller.signal,AbortSignal.timeout(12000)]));
   if(n!==generation.current)return;
   if(verification)setHandoff(r.data as Handoff);else setState(r.data as State);
  }catch(e){if(n===generation.current){if(e instanceof ApiError&&e.status===401)onExpired();else setError(e instanceof ApiError&&e.code==="invalid_request"?"Enter a canonical sponsor wallet and whole decimal IDs within u64.":e instanceof SyntaxError?"Enter the complete private verifier request JSON.":message(e));}}
  finally{if(n===generation.current)setBusy(false);}
 }
 return <section aria-label="Observed workflow state"><h2>Read the actual milestone</h2>
  <p>Explicit IDs only; this does not allocate or reserve IDs. Imported proposals are not assignments. Reads do not create jobs or confirm a transaction.</p>
  <form onSubmit={e=>void inspect(e)}><div className="workflow-grid">{([['sponsor','Recorded sponsor wallet'],['internshipId','Internship ID to inspect'],['milestoneId','Milestone ID to inspect']] as const).map(([key,label])=><label key={key}>{label}<input required autoComplete="off" maxLength={key==='sponsor'?44:20} value={target[key]} onChange={e=>{clear();setEvidence("");setTarget({...target,[key]:e.target.value});}}/></label>)}</div><button disabled={busy}>Refresh chain observation</button></form>
  {busy&&<p role="status">Reading current state. No signing, sending or verification dispatch…</p>}{error&&<p role="alert">{error}</p>}
  {state&&<div className="notice" role="status"><h3>{state.status??(state.internshipExists?"Internship observed; milestone absent":"Scope absent at observed slot")}</h3>
   <p>Source: {state.provenance.replaceAll("_"," ")}; {state.commitment} RPC context at slot {state.slot}. Deployment and transaction correlation are not established. No operational ingestion performed.</p>
   <dl className="facts">{[["Internship PDA",state.internship],["Milestone PDA",state.milestone],["Recorded student",state.student??"Not assigned"],["Independent verifier",state.verifier??"Not observed"],["Requirements commitment",state.requirementsHash??"Not observed"],["Reward raw DEMO units",state.rewardAmountRaw??"Not observed"],["Escrow raw DEMO units",state.vaultAmountRaw??"Not observed"],["Submission commitment",state.evidenceHash??"Not submitted"],["Attestation time",state.verifiedAt??"Not attested"],["Completion record",state.completion??"Not observed"],["Vault closure",state.vaultClosed===true?"Token vault absent in terminal-state snapshot":state.vaultClosed===false?"Not closed":"Not established"]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
   <p>Creation/milestone collisions are observations only; IDs are not reserved. Reward payment remains not established without a correlated settlement transaction and exact balance evidence.</p>
  </div>}
  {role==="student"&&<form onSubmit={e=>void inspect(e,true)}><h3>Prepare the independent verifier handoff</h3><p>Requires your actual Submitted milestone and matching commitments. This validates the existing verifier request format; it does not run GitHub verification or authorize attestation.</p>
   <label>Verification evidence request JSON (private)<textarea required maxLength={20000} value={evidence} spellCheck={false} onChange={e=>{generation.current++;pending.current?.abort();setBusy(false);setError("");setHandoff(null);setEvidence(e.target.value);}}/></label>
   <p>First refresh the actual Submitted milestone for this wallet. An unsigned proposal cannot enable this handoff.</p><button disabled={busy||state?.status!=="Submitted"||state.student!==session.wallet}>Validate private verifier handoff</button>
   {handoff&&<div role="status"><p>Request matches the observed submission. Trusted dispatch unavailable; independent GitHub authentication and approved isolated runner are still required. No verification or attestation succeeded.</p><label>Private validated verifier request — do not publish<textarea readOnly value={JSON.stringify(handoff.request,null,2)}/></label></div>}
  </form>}
  <p>Durable operational state ingestion is unavailable pending policy/schema approval. Existing authorized job reads remain separate.</p>
 </section>;
}
