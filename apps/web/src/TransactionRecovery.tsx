import {useEffect,useRef,useState} from "react";
import {ApiError,ENVELOPE,message,request} from "./api";
const operations=["create_internship","create_milestone","fund_milestone","assign_student","submit_milestone","settle_milestone"];
interface Recovery {kind:"wallet_execution_recovery";signature:string|null;recordedState:string;confirmation:{state:string;rewardPayment:string;settlement?:{rewardAmountRaw:string;studentBeforeRaw:string;studentAfterRaw:string;completion:string}}|null;}
/** Read-only recovery after lost HTTP responses or renewed authentication; never asks a wallet to sign. */
export function TransactionRecovery({scope,onExpired}:{scope:object;onExpired:()=>void}){
 const [operation,setOperation]=useState("create_internship"),[result,setResult]=useState<Recovery|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");const generation=useRef(0);
 useEffect(()=>()=>{generation.current++;},[]);
 async function read(){const n=++generation.current;setBusy(true);setError("");setResult(null);try{const r=await request<Recovery>("/api/v1/workflow/recover","wallet_execution_recovery",{...ENVELOPE,operation,workflow:scope});if(n===generation.current)setResult(r.data);}catch(e){if(n===generation.current){if(e instanceof ApiError&&e.status===401)onExpired();else setError(message(e));}}finally{if(n===generation.current)setBusy(false);}}
 return <section aria-label="Previous transaction confirmation"><h3>Recheck a previous transaction</h3><p>Reads the recorded attempt for this scope and authenticated wallet. It never signs, sends or releases a reservation. A server restart may require manual read-only reconciliation.</p>
 <label>Previous operation<select value={operation} onChange={e=>{generation.current++;setOperation(e.target.value);setResult(null);setError("");setBusy(false);}}>{operations.map(op=><option key={op} value={op}>{op.replaceAll("_"," ")}</option>)}</select></label><button disabled={busy} onClick={()=>void read()}>Recheck recorded transaction</button>
 {result&&<div role="status"><p>Recorded attempt: {result.recordedState}. Signature: {result.signature??"Not recorded"}. Fresh correlated confirmation: {result.confirmation?.state??"not established; manual read-only reconciliation required"}.</p>{result.confirmation?.rewardPayment==="exact_reward_confirmed"&&result.confirmation.settlement&&<p>Exact reward {result.confirmation.settlement.rewardAmountRaw} raw DEMO; student {result.confirmation.settlement.studentBeforeRaw} → {result.confirmation.settlement.studentAfterRaw}; completion {result.confirmation.settlement.completion}.</p>}</div>}{error&&<p role="alert">{error}</p>}
 </section>;
}
