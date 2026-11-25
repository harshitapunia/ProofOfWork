import { useEffect, useRef, useState } from "react";
import { WalletApprovalFlow, requestPhantomTransaction, type WalletStage } from "./wallet-execution";
import { ENVELOPE, ApiError, getWallet, message, request } from "./api";
interface Review {kind:"wallet_execution_review";state:"blocked"|"ready_for_review";liveExecution:boolean;operation:string;wallet:string;blockers:string[];
 deployment:{programExists:boolean;executable:boolean;artifactEquality:string;mint:{exists:boolean;decimals:number|null;supplyRaw:string|null}}|null;
 messageBase58:string|null;reviewId:string|null;messageBase64:string|null;feeLamports:number|null;rentLamports:number|null;expiresAt:string|null;rewardPayment:"not_established"}
export function ExecutionReview({workflow,operations,wallet,onExpired}:{workflow:object;operations:string[];wallet:string;onExpired:()=>void}){
 const [review,setReview]=useState<Review|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");const generation=useRef(0),flow=useRef<WalletApprovalFlow|null>(null);
 const [receipt,setReceipt]=useState<{rewardAmountRaw:string;studentBeforeRaw:string;studentAfterRaw:string;sponsorSurplusRaw:string;completion:string}|null>(null);
 const [stage,setStage]=useState<WalletStage>("prepared");
 useEffect(()=>()=>{generation.current++;},[]);
 async function inspect(operation:string){const n=++generation.current;setReview(null);setReceipt(null);flow.current=null;setStage("prepared");setError("");setBusy(true);
  try{const r=await request<Review>("/api/v1/workflow/review","wallet_execution_review",{...ENVELOPE,operation,workflow});
   if(generation.current!==n)return;if(r.data.wallet!==wallet||r.data.operation!==operation)throw new ApiError("invalid_api_response");setReview(r.data);
   if(r.data.state==="ready_for_review" && r.data.reviewId && r.data.messageBase58 && r.data.expiresAt){
    const reviewed={wallet,reviewId:r.data.reviewId,messageBase58:r.data.messageBase58,expiresAt:r.data.expiresAt,liveExecution:r.data.liveExecution};
    const encode=(wire:Uint8Array)=>btoa(Array.from(wire,b=>String.fromCharCode(b)).join(""));
    flow.current=new WalletApprovalFlow(reviewed,{mode:r.data.liveExecution?"approved-devnet":"disabled",wallet:()=>getWallet().publicKey?.toBase58()??null,
     revalidate:async()=>{await request("/api/v1/workflow/revalidate","wallet_execution_revalidation",{...ENVELOPE,reviewId:reviewed.reviewId});},
     sign:async()=>{await request("/api/v1/workflow/authorize","wallet_execution_authorization",{...ENVELOPE,reviewId:reviewed.reviewId});if(generation.current!==n)throw new Error("review_changed");return requestPhantomTransaction(getWallet(),reviewed);},
     validate:async wire=>(await request<{signature:string}>("/api/v1/workflow/validate","wallet_execution_signature",{...ENVELOPE,reviewId:reviewed.reviewId,wireBase64:encode(wire)})).data.signature,
     broadcast:async wire=>{const sent=await request<{signature:string;state:string}>("/api/v1/workflow/broadcast","wallet_execution_submission",{...ENVELOPE,reviewId:reviewed.reviewId,wireBase64:encode(wire)});if(sent.data.state!=="submitted")throw new Error("submission_uncertain");return sent.data.signature;},
     confirm:async(wire,signature)=>{setStage("confirming");const c=await request<{state:"confirmed"|"failed"|"unknown";signature:string;rewardPayment:string;settlement?:{rewardAmountRaw:string;studentBeforeRaw:string;studentAfterRaw:string;sponsorSurplusRaw:string;completion:string}}>("/api/v1/workflow/confirm","wallet_execution_confirmation",{...ENVELOPE,reviewId:reviewed.reviewId,wireBase64:encode(wire)});if(c.data.signature!==signature)throw new Error("signature_mismatch");if(generation.current===n&&c.data.state==="confirmed"&&c.data.rewardPayment==="exact_reward_confirmed"&&c.data.settlement)setReceipt(c.data.settlement);return c.data.state;}},()=>Date.now(),s=>{if(generation.current===n)setStage(s);});setStage("ready_for_review");
   }
  }catch(e){if(generation.current===n){if(e instanceof ApiError&&e.status===401)onExpired();else setError(e instanceof ApiError&&e.code==="wallet_review_unavailable"?"Devnet review is unavailable. Enable the existing APP_CHAIN_READS=devnet configuration and build the pinned SBF artifact; signing stays disabled.":message(e));}}
  finally{if(generation.current===n)setBusy(false);}}
 async function approve(){if(!flow.current)return;await flow.current.approve();}
 async function broadcast(){if(!flow.current)return;await flow.current.broadcast();}
 async function reconcile(){if(!flow.current)return;await flow.current.reconcile();}
 return <section aria-label="Wallet execution review"><h3>Review fresh Devnet state</h3>
  <p>Each action is reviewed separately against current program, mint, accounts, deadlines, balances, fees and rent. Prepared proposal JSON is not authority.</p>
  <div className="actions">{operations.map(operation=><button type="button" key={operation} disabled={busy} onClick={()=>void inspect(operation)}>{operation.replaceAll("_"," ")} — review</button>)}</div>
  {busy&&<p role="status">Reading Devnet. No transaction is being signed or sent…</p>}{error&&<p role="alert" className="error">{error}</p>}
  {review&&<div className="notice"><h4>{review.state==="blocked"?"Execution blocked":review.liveExecution?"Approved Devnet action — review before signing":"Ready for review — signing disabled"}</h4><p>RPC observations are not independent chain proofs. Review expires: {review.expiresAt??"Not issued"}.</p>
   <ul>{review.blockers.map(b=><li key={b}>{b.replaceAll("_"," ")}</li>)}</ul>
   {review.deployment&&<p>Program exists: {String(review.deployment.programExists)}. Executable: {String(review.deployment.executable)}. Artifact comparison: {review.deployment.artifactEquality.replaceAll("_"," ")}. DEMO mint exists: {String(review.deployment.mint.exists)}; decimals: {review.deployment.mint.decimals??"unknown"}; raw supply: {review.deployment.mint.supplyRaw??"unknown"}.</p>}
   {review.messageBase64&&<label>Reviewed unsigned transaction message<textarea readOnly value={review.messageBase64}/></label>}
   <p>Fee: {review.feeLamports??"Not established"} lamports. Rent: {review.rentLamports??"Not established"} lamports. Reward payment not established.</p></div>}
  <p>Prepared instructions require a separate fresh review for each operation. No creation or payment is confirmed by preparation.</p>
  {receipt&&<p role="status">Correlated settlement RPC evidence: student raw DEMO balance {receipt.studentBeforeRaw} → {receipt.studentAfterRaw}; exact reward {receipt.rewardAmountRaw}; sponsor surplus {receipt.sponsorSurplusRaw}; completion {receipt.completion}. Vault closure and rent return checked. RPC evidence is not an independent chain proof.</p>}
  <p>Wallet execution state: {stage.replaceAll("_"," ")}. No automatic retries are permitted.</p>
  <p>Live wallet signing and broadcasting require a separately authorized controlled Devnet rehearsal. The server requires an unexpired approval for this exact action and scope.</p>
  <div className="actions"><button disabled={!review?.liveExecution||stage!=="ready_for_review"} onClick={()=>void approve()}>Approve transaction in wallet{!review?.liveExecution?" — disabled":""}</button><button disabled={!review?.liveExecution||stage!=="signed_awaiting_broadcast"} onClick={()=>void broadcast()}>Broadcast signed transaction{!review?.liveExecution?" — disabled":""}</button><button disabled={stage!=="unknown"} onClick={()=>void reconcile()}>Check transaction confirmation</button></div>
 </section>;
}
