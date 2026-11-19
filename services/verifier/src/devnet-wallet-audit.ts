/** Explicit read-only public Devnet audit; never runs from default server startup or CI tests. */
import {fileURLToPath} from "node:url";
import {ReadOnlyWalletRpc,observeDeployment,reviewedArtifact} from "./devnet-wallet-review.js";
import {deriveSponsorAta} from "@proofwork/finance-client";
import {WalletAuthError} from "./wallet-sessions.js";
export async function auditDevnetDeployment(){
 const rpc=new ReadOnlyWalletRpc();let artifact;try{artifact=await reviewedArtifact();}catch{/* Missing build is not deployment evidence. */}
 const observedAtUtc=new Date().toISOString();
 try{
  const deployment=await observeDeployment(rpc,artifact);let authorityTokenAccount:unknown={status:"NOT_VERIFIED"};
  if(deployment.mint.authority){try{
   const address=deriveSponsorAta(deployment.mint.authority).toBase58(),batch=await rpc.accounts([address],deployment.slot),a=batch.values[0];
   authorityTokenAccount={address,slot:batch.slot,exists:a!==null,owner:a?.owner??null,executable:a?.executable??null,
     data:a?.data??null,note:"Canonical ATA for the observed public mint authority only; not a complete token-account inventory."};
  }catch{authorityTokenAccount={status:"NOT_VERIFIED",reason:"token_account_rpc_unavailable"};}}
  return {observedAtUtc,readOnly:true,liveTransactionsPerformed:false,status:"RPC_OBSERVATIONS_ONLY",deployment,authorityTokenAccount};
 }catch(e){return {observedAtUtc,readOnly:true,liveTransactionsPerformed:false,status:"NOT_VERIFIED",reason:e instanceof WalletAuthError?e.code:"rpc_unavailable"};}
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(JSON.stringify(await auditDevnetDeployment(),null,2));
