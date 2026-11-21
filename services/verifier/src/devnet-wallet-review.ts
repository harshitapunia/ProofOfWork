/** Read-only Devnet wallet review. No signer, sender, custody, state mutation or live enable switch. */
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PublicKey, Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import { decodeInternship, decodeMilestone, decodeSubmission } from "@proofwork/lifecycle";
import { PROGRAM_ID, DEMO_MINT, DEMO_DECIMALS, TOKEN_PROGRAM_ID, SETTLEMENT_DEVNET_RPC, SETTLEMENT_DEVNET_GENESIS,
  deriveSponsorAta, deriveVault, deriveVaultAuthority, deriveSubmission } from "@proofwork/finance-client";
import { jsonResponse } from "./http.js";
import { prepareWorkflow, type WorkflowPreparation } from "./workflow-preparation.js";
import { WalletAuthError } from "./wallet-sessions.js";
import { transactionId as base58 } from "./devnet-execution.js";
export const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const MINT_AUTHORITY = "249mMS9awYGUyMe22zabsSCo8cH4RDo3MeN3mAHFdy69"; // TEAM_APPROVAL.md
const operations = ["create_internship", "create_milestone", "fund_milestone", "assign_student", "submit_milestone"] as const;
export type WalletOperation = typeof operations[number];
function check(ok: unknown, code: string): asserts ok { if (!ok) throw new WalletAuthError(code, 400); }
function integer(v: unknown): number { check(typeof v === "number" && Number.isSafeInteger(v) && v >= 0, "invalid_rpc_response"); return v; }
function contextual(value:any,minimum:number):any {check(value && integer(value.context?.slot)>=minimum && Object.hasOwn(value,"value"),"stale_rpc_context");return value.value;}
function data(a: any, size?: number): Buffer {
  check(a && Array.isArray(a.data) && a.data.length === 2 && a.data[1] === "base64" && typeof a.data[0] === "string", "invalid_account");
  const b = Buffer.from(a.data[0], "base64"); check(b.toString("base64") === a.data[0] && (size === undefined || b.length === size), "invalid_account"); return b;
}
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
export interface ApprovedArtifact { bytes: Buffer; sha256: string }
export async function reviewedArtifact(): Promise<ApprovedArtifact> {
  const pin = JSON.parse(await readFile(new URL("../../../../tests/runtime/artifact-provenance.json", import.meta.url), "utf8"));
  const bytes = await readFile(new URL("../../../../target/keyless-sbf/sbpfv3-solana-solana/release/proof_of_work.so", import.meta.url));
  check(hash(bytes) === pin.sha256 && bytes.subarray(0,4).equals(Buffer.from([127,69,76,70])), "artifact_mismatch"); return { bytes, sha256: pin.sha256 };
}
export interface DeploymentObservation {
  genesis: string; slot: number; programExists: boolean; executable: boolean; programOwner: string | null;
  programData: string | null; deploymentSlot: string | null; upgradeAuthority: string | null;
  artifactEquality: "not_established" | "rpc_bytes_match_reviewed_artifact"; approvedArtifactSha256: string | null;
  mint: { exists: boolean; owner: string | null; decimals: number | null; authority: string | null; freezeAuthority: string | null; supplyRaw: string | null };
  blockers: string[]; provenance: "unverified_devnet_rpc";
}
export class ReadOnlyWalletRpc {
  constructor(private readonly request: typeof fetch = fetch) {}
  async call(method: string, params: unknown[] = [], signal?: AbortSignal): Promise<any> {
    check(["getGenesisHash","getMultipleAccounts","getLatestBlockhash","getBlockHeight","getBlockTime","isBlockhashValid","getFeeForMessage","getMinimumBalanceForRentExemption","getSignatureStatuses","getTransaction"].includes(method), "rpc_method_disabled");
    try {
      const response = await this.request(SETTLEMENT_DEVNET_RPC, { method:"POST",redirect:"error",signal:signal ?? AbortSignal.timeout(10000),
        headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:method,method,params}) });
      check(response.ok,"rpc_failure"); const v:any=await jsonResponse(response, 5_000_000);
      check(v?.jsonrpc==="2.0" && v.id===method && !Object.hasOwn(v,"error") && Object.hasOwn(v,"result"),"invalid_rpc_response");return v.result;
    } catch(e) { if(e instanceof WalletAuthError) throw e; throw new WalletAuthError("rpc_unavailable",503); }
  }
  async accounts(addresses:string[], minimum=0, signal?:AbortSignal):Promise<{slot:number;values:any[]}> {
    const r=await this.call("getMultipleAccounts",[addresses,{encoding:"base64",commitment:"confirmed",minContextSlot:minimum}],signal);
    const slot=integer(r?.context?.slot);check(slot>=minimum && Array.isArray(r.value) && r.value.length===addresses.length,"invalid_rpc_response");return {slot,values:r.value};
  }
}
function mintObservation(a:any):DeploymentObservation["mint"] {
  if(a===null)return {exists:false,owner:null,decimals:null,authority:null,freezeAuthority:null,supplyRaw:null};
  check(a.executable===false && a.owner===TOKEN_PROGRAM_ID,"incorrect_mint_owner"); const b=data(a,82);
  check([0,1].includes(b.readUInt32LE(0)) && [0,1].includes(b.readUInt32LE(46)) && b[45]===1,"invalid_mint");
  return {exists:true,owner:a.owner,decimals:b[44]!,authority:b.readUInt32LE(0)===1?new PublicKey(b.subarray(4,36)).toBase58():null,
    freezeAuthority:b.readUInt32LE(46)===1?new PublicKey(b.subarray(50,82)).toBase58():null,supplyRaw:b.readBigUInt64LE(36).toString()};
}
export async function observeDeployment(rpc:ReadOnlyWalletRpc,artifact?:ApprovedArtifact,signal=AbortSignal.timeout(10000)):Promise<DeploymentObservation> {
  const genesis=await rpc.call("getGenesisHash",[],signal);check(genesis===SETTLEMENT_DEVNET_GENESIS,"wrong_cluster");
  const batch=await rpc.accounts([PROGRAM_ID,DEMO_MINT],0,signal),[p,m]=batch.values;
  const out:DeploymentObservation={genesis,slot:batch.slot,programExists:p!==null,executable:p?.executable===true,programOwner:p?.owner??null,
    programData:null,deploymentSlot:null,upgradeAuthority:null,artifactEquality:"not_established",approvedArtifactSha256:artifact?.sha256??null,
    mint:mintObservation(m),blockers:[],provenance:"unverified_devnet_rpc"};
  if(!out.mint.exists)out.blockers.push("missing_mint");
  else if(out.mint.decimals!==DEMO_DECIMALS || out.mint.freezeAuthority!==null || out.mint.authority!==MINT_AUTHORITY)out.blockers.push("incorrect_mint_configuration");
  if(p===null)out.blockers.push("missing_program");
  else if(!p.executable || p.owner!==UPGRADEABLE_LOADER)out.blockers.push("invalid_program_owner_or_executable");
  else {
    const pd=data(p,36);check(pd.readUInt32LE(0)===2,"invalid_program_state");out.programData=new PublicKey(pd.subarray(4,36)).toBase58();
    check(out.programData===PublicKey.findProgramAddressSync([new PublicKey(PROGRAM_ID).toBuffer()],new PublicKey(UPGRADEABLE_LOADER))[0].toBase58(),"invalid_programdata_binding");
    const next=await rpc.accounts([PROGRAM_ID,out.programData],batch.slot,signal),[again,account]=next.values;
    check(again?.owner===UPGRADEABLE_LOADER && again.executable===true && data(again,36).equals(pd),"program_changed");
    check(account && account.executable===false && account.owner===UPGRADEABLE_LOADER,"invalid_programdata");
    const b=data(account);check(b.length>=45 && b.readUInt32LE(0)===3 && [0,1].includes(b[12]!),"invalid_programdata");
    out.deploymentSlot=b.readBigUInt64LE(4).toString();check(BigInt(out.deploymentSlot)<=BigInt(next.slot),"invalid_programdata");out.slot=next.slot;
    out.upgradeAuthority=b[12]===1?new PublicKey(b.subarray(13,45)).toBase58():null;
    // No approved mutable upgrade authority policy exists in the repository. Never invent one.
    if(out.upgradeAuthority!==null)out.blockers.push("upgrade_authority_policy_unapproved");
    if(!artifact)out.blockers.push("reviewed_artifact_unavailable");
    else {
      check(hash(artifact.bytes)===artifact.sha256,"invalid_artifact");const code=b.subarray(45);
      if(code.length>=artifact.bytes.length && code.subarray(0,artifact.bytes.length).equals(artifact.bytes) && code.subarray(artifact.bytes.length).every(v=>v===0)) out.artifactEquality="rpc_bytes_match_reviewed_artifact";
      else out.blockers.push("deployed_artifact_mismatch");
    }
  }
  return out;
}
export interface WalletReview {
  kind:"wallet_execution_review"; state:"blocked"|"ready_for_review"; liveExecution:false; operation:WalletOperation;
  wallet:string; reviewId:string|null; messageBase64:string|null; messageBase58:string|null; lastValidBlockHeight:number|null;
  blockhash:string|null; observedSlot:number|null; expiresAt:string|null; feeLamports:number|null; rentLamports:number|null;
  deployment:DeploymentObservation|null; blockers:string[]; rewardPayment:"not_established"; provenance:"unverified_devnet_rpc";
}
interface Context { view:WalletReview; plan:WorkflowPreparation; message:Buffer; deadline:number; created:number; beforeToken:bigint|null }
export interface WalletConfirmation {kind:"wallet_execution_confirmation";state:"confirmed"|"failed"|"unknown";signature:string;explorerUrl:string|null;rewardPayment:"not_established";retryAuthorized:false;provenance:"unverified_devnet_rpc"}
export class WalletExecutionReviewer {
  readonly #tickets=new Map<string,Context>();
  constructor(readonly rpc=new ReadOnlyWalletRpc(),private readonly artifact:()=>Promise<ApprovedArtifact|undefined>=async()=>{try{return await reviewedArtifact();}catch{return undefined;}},private readonly now=()=>Date.now()){}
  private context(id:string,wallet:string):Context {const c=this.#tickets.get(id);check(c && c.view.wallet===wallet && this.now()-c.created>=0 && this.now()-c.created<600000,"review_unavailable");return c;}
  private prune(){for(const [id,c]of this.#tickets)if(this.now()-c.created<0 || this.now()-c.created>=600000)this.#tickets.delete(id);check(this.#tickets.size<64,"review_capacity");}
  private token(a:any,authority:string):bigint {check(a && a.executable===false && a.owner===TOKEN_PROGRAM_ID,"invalid_token_account");const b=data(a,165);
    check(new PublicKey(b.subarray(0,32)).toBase58()===DEMO_MINT && new PublicKey(b.subarray(32,64)).toBase58()===authority && b[108]===1
      && b.readUInt32LE(109)===0 && b.readUInt32LE(72)===0 && b.readUInt32LE(129)===0,"invalid_token_account");return b.readBigUInt64LE(64);}
  private async snapshot(plan:WorkflowPreparation,op:WalletOperation,wallet:string,minimum:number,post=false,signal?:AbortSignal){
    const t=plan.terms,addresses=[plan.internship,plan.milestone,deriveSubmission(plan.milestone)[0].toBase58(),deriveVault(plan.milestone)[0].toBase58(),deriveSponsorAta(t.sponsor).toBase58(),wallet];
    const {slot,values:a}=await this.rpc.accounts(addresses,minimum,signal);const time=await this.rpc.call("getBlockTime",[slot],signal);
    check(Number.isSafeInteger(time) && time>0,"chain_clock_unavailable");
    const payer=a[5];check(payer && payer.executable===false && payer.owner===SystemProgram.programId.toBase58() && data(payer,0).length===0,"invalid_payer");const balance=integer(payer.lamports);
    if(op==="create_internship" && !post){check(a[0]===null,"duplicate_internship");return {slot,balance,token:null};}
    const parent=decodeInternship(plan.internship,a[0]);check(parent.sponsor===t.sponsor && parent.internshipId===BigInt(t.internshipId),"binding_mismatch");
    if(op==="create_internship")return {slot,balance,token:null};
    if(op==="create_milestone" && !post){check(a[1]===null,"duplicate_milestone");check(BigInt(time)<BigInt(t.assignBy),"expired_deadline");return {slot,balance,token:null};}
    const m=decodeMilestone(plan.milestone,a[1],parent);
    check(m.milestoneId===BigInt(t.milestoneId) && m.verifier===t.verifier && m.requirementsHash===plan.requirementsHash
      && m.rewardAmount===BigInt(t.rewardAmountRaw) && m.assignBy===BigInt(t.assignBy) && m.submitBy===BigInt(t.submitBy),"binding_mismatch");
    const states:Record<WalletOperation,string>={create_internship:"",create_milestone:"Created",fund_milestone:post?"Funded":"Created",assign_student:post?"Assigned":"Funded",submit_milestone:post?"Submitted":"Assigned"};
    check(m.status===states[op],"invalid_milestone_state");
    if(!post)check(BigInt(time)<(op==="submit_milestone"?m.submitBy:m.assignBy),"expired_deadline");
    if(op==="assign_student" && post || op==="submit_milestone")check(m.student===t.student,"incorrect_student");
    if(op==="submit_milestone" && post){const s=decodeSubmission(addresses[2]!,a[2],m);check(s.evidenceHash===plan.evidenceHash,"evidence_mismatch");}
    else check(a[2]===null,"duplicate_submission");
    let token:bigint|null=null;
    if(op==="fund_milestone" && !post){check(a[3]===null,"duplicate_vault");token=this.token(a[4],t.sponsor);check(token>=m.rewardAmount,"insufficient_tokens");}
    if(op==="assign_student" || op==="submit_milestone" || op==="fund_milestone" && post){check(this.token(a[3],deriveVaultAuthority(plan.milestone)[0].toBase58())>=m.rewardAmount,"insufficient_escrow");}
    if(op==="fund_milestone" && post)token=this.token(a[4],t.sponsor);
    return {slot,balance,token};
  }
  async review(input:unknown,wallet:string):Promise<WalletReview>{
    this.prune();const v=input as any;check(v && typeof v==="object" && JSON.stringify(Object.keys(v).sort())==='["operation","workflow"]' && operations.includes(v.operation),"invalid_wallet_review");
    const op:WalletOperation=v.operation,plan=prepareWorkflow(v.workflow,wallet),step=plan.steps.find(s=>s.action===op);check(step && step.feePayer===wallet,"incorrect_required_signer");
    const view:WalletReview={kind:"wallet_execution_review",state:"blocked",liveExecution:false,operation:op,wallet,reviewId:null,messageBase64:null,messageBase58:null,
      blockhash:null,lastValidBlockHeight:null,observedSlot:null,expiresAt:null,feeLamports:null,rentLamports:null,deployment:null,blockers:[],rewardPayment:"not_established",provenance:"unverified_devnet_rpc"};
    try {
      const signal=AbortSignal.timeout(10000);view.deployment=await observeDeployment(this.rpc,await this.artifact(),signal);
      check(view.deployment.blockers.length===0,view.deployment.blockers[0]??"deployment_unverified");
      const before=await this.snapshot(plan,op,wallet,view.deployment.slot,false,signal);
      const latest=await this.rpc.call("getLatestBlockhash",[{commitment:"confirmed",minContextSlot:before.slot}],signal);
      check(integer(latest?.context?.slot)>=before.slot,"stale_rpc_context");const blockhash=new PublicKey(latest.value.blockhash).toBase58();check(blockhash===latest.value.blockhash && blockhash!==PublicKey.default.toBase58(),"invalid_blockhash");
      const deadline=integer(latest.value.lastValidBlockHeight),height=integer(await this.rpc.call("getBlockHeight",[{commitment:"confirmed",minContextSlot:latest.context.slot}],signal));
      check(height<deadline && contextual(await this.rpc.call("isBlockhashValid",[blockhash,{commitment:"confirmed",minContextSlot:latest.context.slot}],signal),latest.context.slot)===true,"expired_blockhash");
      const tx=new Transaction({feePayer:new PublicKey(wallet),recentBlockhash:blockhash});
      for(const i of step.instructions)tx.add(new TransactionInstruction({programId:new PublicKey(i.programId),keys:i.keys.map(k=>({...k,pubkey:new PublicKey(k.pubkey)})),data:Buffer.from(i.dataBase64,"base64")}));
      const message=tx.serializeMessage();check(tx.compileMessage().header.numRequiredSignatures===1 && tx.compileMessage().accountKeys[0]!.toBase58()===wallet,"incorrect_required_signer");
      const fee=integer(contextual(await this.rpc.call("getFeeForMessage",[message.toString("base64"),{commitment:"confirmed",minContextSlot:before.slot}],signal),before.slot));
      const size=op==="create_internship"?49:op==="create_milestone"?276:op==="fund_milestone"?165:op==="submit_milestone"?113:0;
      const rent=size?integer(await this.rpc.call("getMinimumBalanceForRentExemption",[size,{commitment:"confirmed"}],signal)):0;
      check(BigInt(before.balance)>=BigInt(fee)+BigInt(rent),"insufficient_lamports");
      const id=randomUUID(),created=this.now();Object.assign(view,{state:"ready_for_review",reviewId:id,messageBase64:message.toString("base64"),messageBase58:base58(message),
        blockhash,lastValidBlockHeight:deadline,observedSlot:before.slot,expiresAt:new Date(created+20000).toISOString(),feeLamports:fee,rentLamports:rent,blockers:["live_execution_disabled"]});
      this.#tickets.set(id,{view:structuredClone(view),plan,message,deadline,created,beforeToken:before.token});
    } catch(e){view.blockers=[e instanceof WalletAuthError?e.code:"account_validation_failed"];}
    return view;
  }
  async revalidate(id:string,wallet:string):Promise<void>{
    const c=this.context(id,wallet);check(this.now()-c.created>=0 && this.now()-c.created<20000,"review_expired");const signal=AbortSignal.timeout(10000);
    const observation=await observeDeployment(this.rpc,await this.artifact(),signal);check(observation.blockers.length===0,"deployment_changed");
    const before=await this.snapshot(c.plan,c.view.operation,wallet,Math.max(c.view.observedSlot!,observation.slot),false,signal);
    const size=c.view.operation==="create_internship"?49:c.view.operation==="create_milestone"?276:c.view.operation==="fund_milestone"?165:c.view.operation==="submit_milestone"?113:0;
    const rent=size?integer(await this.rpc.call("getMinimumBalanceForRentExemption",[size,{commitment:"confirmed"}],signal)):0;
    check(rent===c.view.rentLamports,"rent_changed");check(BigInt(before.balance)>=BigInt(c.view.feeLamports!)+BigInt(rent),"insufficient_lamports");
    c.beforeToken=before.token;
    check(integer(await this.rpc.call("getBlockHeight",[{commitment:"confirmed"}],signal))<c.deadline
      && contextual(await this.rpc.call("isBlockhashValid",[c.view.blockhash,{commitment:"confirmed",minContextSlot:before.slot}],signal),before.slot)===true,"expired_blockhash");
    check(integer(contextual(await this.rpc.call("getFeeForMessage",[c.view.messageBase64,{commitment:"confirmed",minContextSlot:before.slot}],signal),before.slot))===c.view.feeLamports,"fee_changed");
    check(this.now()-c.created>=0 && this.now()-c.created<20000,"review_expired");
  }
  validateSigned(id:string,wallet:string,wireBase64:string):{signature:string;wire:Buffer}{
    const c=this.context(id,wallet);check(typeof wireBase64==="string" && wireBase64.length<=1700,"invalid_signed_transaction");const wire=Buffer.from(wireBase64,"base64");
    check(wire.toString("base64")===wireBase64 && wire.length<=1232,"invalid_signed_transaction");const tx=Transaction.from(wire);
    check(tx.serializeMessage().equals(c.message) && tx.signatures.length===1 && tx.signatures[0]!.publicKey.toBase58()===wallet && tx.verifySignatures() && tx.serialize().equals(wire),"transaction_substitution");
    return {signature:base58(tx.signatures[0]!.signature!),wire};
  }
  async confirm(id:string,wallet:string,wireBase64:string):Promise<WalletConfirmation>{
    const c=this.context(id,wallet),signed=this.validateSigned(id,wallet,wireBase64);
    const out:WalletConfirmation={kind:"wallet_execution_confirmation",state:"unknown",signature:signed.signature,explorerUrl:null,rewardPayment:"not_established",retryAuthorized:false,provenance:"unverified_devnet_rpc"};
    try {
      const signal=AbortSignal.timeout(10000);check(await this.rpc.call("getGenesisHash",[],signal)===SETTLEMENT_DEVNET_GENESIS,"wrong_cluster");
      const status=await this.rpc.call("getSignatureStatuses",[[signed.signature],{searchTransactionHistory:true}],signal);
      check(Array.isArray(status?.value) && status.value.length===1,"invalid_rpc_response");const s=status.value[0];if(s===null)return out;
      check(s && ["processed","confirmed","finalized"].includes(s.confirmationStatus) && Object.hasOwn(s,"err"),"invalid_rpc_response");
      if(!["confirmed","finalized"].includes(s.confirmationStatus))return out;
      if(s.err!==null){out.state="failed";return out;}const slot=integer(s.slot);check(integer(status.context?.slot)>=slot && slot>=c.view.observedSlot!,"invalid_rpc_response");
      const transaction=await this.rpc.call("getTransaction",[signed.signature,{encoding:"base64",commitment:"confirmed",maxSupportedTransactionVersion:0}],signal);
      check(transaction?.meta?.err===null && integer(transaction.slot)===slot && Array.isArray(transaction.transaction) && transaction.transaction[1]==="base64"
        && transaction.transaction[0]===wireBase64,"transaction_not_correlated");
      const after=await this.snapshot(c.plan,c.view.operation,wallet,slot,true,signal);
      if(c.view.operation==="fund_milestone")check(after.token===c.beforeToken!-BigInt(c.plan.terms.rewardAmountRaw),"token_postcondition_mismatch");
      out.state="confirmed";out.explorerUrl="https://explorer.solana.com/tx/"+signed.signature+"?cluster=devnet";
    }catch{/* A submitted signature or an RPC error never proves success and never permits automatic retry. */}
    return out;
  }
  async broadcast():Promise<never>{throw new WalletAuthError("live_execution_disabled",403);}
}
