/** Settlement-specific preparation/effect checks for the existing wallet reviewer; never signs or sends. */
import {PublicKey,Transaction} from "@solana/web3.js";
import {prepareSettlementTransaction,deriveStudentAta,deriveVault,deriveVaultAuthority,deriveCompletion,DEMO_MINT,DEMO_DECIMALS,SETTLEMENT_DEVNET_RPC,TOKEN_PROGRAM_ID} from "@proofwork/finance-client";
import {WorkflowStateReader} from "./workflow-state.js";
import type {ReadOnlyWalletRpc} from "./devnet-wallet-review.js";
import {WalletAuthError} from "./wallet-sessions.js";
function check(v:unknown):asserts v{if(!v)throw new WalletAuthError("settlement_evidence_invalid",400);}
function raw(v:unknown):bigint{check(typeof v==="string"&&/^(0|[1-9][0-9]{0,19})$/.test(v));const n=BigInt(v);check(n<=0xffffffffffffffffn);return n;}
function lamports(v:unknown):bigint{check(typeof v==="number"&&Number.isSafeInteger(v)&&v>=0);return BigInt(v);}
export interface SettlementReviewPlan {
 scope:{apiVersion:string;cluster:string;sponsor:string;internshipId:string;milestoneId:string};
 transaction:Transaction;seed:string;slot:number;student:string;sponsor:string;milestone:string;destination:string;destinationKind:string;
 reward:bigint;vaultRent:bigint;balance:bigint;rent:bigint;
}
export interface SettlementReceipt {student:string;mint:string;rewardAmountRaw:string;studentBeforeRaw:string;studentAfterRaw:string;
 sponsorSurplusRaw:string;sponsorDestination:string;completion:string;vaultClosed:true;rentReturnedRaw:string}
export async function prepareReviewedSettlement(rpc:ReadOnlyWalletRpc,input:unknown,wallet:string,minimum:number,seed:string):Promise<SettlementReviewPlan>{
 const scope=structuredClone(input) as SettlementReviewPlan["scope"];
 const state=await new WorkflowStateReader(rpc).read(scope,wallet);check(state.slot>=minimum&&state.status==="Verified"&&state.student&&state.rewardAmountRaw&&state.vaultAmountRaw);
 let slot=state.slot;const accounts=new Map<string,any>();
 const connection={rpcEndpoint:SETTLEMENT_DEVNET_RPC,getGenesisHash:()=>rpc.call("getGenesisHash"),
  getMultipleAccountsInfo:async(keys:PublicKey[])=>{const batch=await rpc.accounts(keys.map(k=>k.toBase58()),slot);slot=batch.slot;
   return batch.values.map((a:any,i:number)=>{accounts.set(keys[i]!.toBase58(),a);if(a===null)return null;check(a&&Array.isArray(a.data)&&a.data[1]==="base64");const data=Buffer.from(a.data[0],"base64");check(data.toString("base64")===a.data[0]);return {...a,owner:new PublicKey(a.owner),data};});},
  getMinimumBalanceForRentExemption:(space:number)=>rpc.call("getMinimumBalanceForRentExemption",[space,{commitment:"confirmed"}])};
 const plan=await prepareSettlementTransaction({sponsor:scope.sponsor,student:state.student,caller:wallet,internshipId:BigInt(scope.internshipId),milestoneId:BigInt(scope.milestoneId),fallbackSeed:seed},connection);
 const dest=plan.sponsorDestination.toBase58(),vault=deriveVault(state.milestone)[0].toBase58(),completion=deriveCompletion(state.milestone)[0].toBase58();
 const token=(address:string)=>{const a=accounts.get(address);check(a?.owner===TOKEN_PROGRAM_ID);return Buffer.from(a.data[0],"base64").readBigUInt64LE(64);};
 const rentCompletion=lamports(await connection.getMinimumBalanceForRentExemption(249)),rentToken=lamports(await connection.getMinimumBalanceForRentExemption(165));
 const completionBefore=accounts.get(completion),destinationBefore=accounts.get(dest);
 const completionTopUp=rentCompletion>(completionBefore?lamports(completionBefore.lamports):0n)?rentCompletion-(completionBefore?lamports(completionBefore.lamports):0n):0n;
 const destinationTopUp=["created","prefunded"].includes(plan.destinationKind)?(rentToken>(destinationBefore?lamports(destinationBefore.lamports):0n)?rentToken-(destinationBefore?lamports(destinationBefore.lamports):0n):0n):0n;
 const vaultAmount=token(vault);check(vaultAmount>=raw(state.rewardAmountRaw));
 return {scope,transaction:plan.transaction,seed,slot,student:state.student,sponsor:scope.sponsor,milestone:state.milestone,destination:dest,destinationKind:plan.destinationKind,
  reward:raw(state.rewardAmountRaw),
  vaultRent:lamports(accounts.get(vault).lamports),balance:lamports(accounts.get(wallet).lamports),rent:completionTopUp+destinationTopUp};
}
/** Requires exact transaction metadata, raw deltas, rent return and fresh terminal account bindings. */
export async function settlementPostconditions(rpc:ReadOnlyWalletRpc,p:SettlementReviewPlan,wallet:string,tx:Transaction,meta:any,slot:number,expectedFee:number):Promise<SettlementReceipt>{
 const keys=tx.compileMessage().accountKeys.map(k=>k.toBase58()),studentAta=deriveStudentAta(p.student).toBase58(),vault=deriveVault(p.milestone)[0].toBase58(),completion=deriveCompletion(p.milestone)[0].toBase58();
 const amount=(rows:any,address:string,owner:string,missing=false):bigint=>{check(Array.isArray(rows));const found=rows.filter((v:any)=>v.accountIndex===keys.indexOf(address));check(found.length<=1);if(found.length===0){check(missing);return 0n;}const v=found[0];check(v.mint===DEMO_MINT&&v.owner===owner&&v.uiTokenAmount?.decimals===DEMO_DECIMALS);return raw(v.uiTokenAmount.amount);};
 const preStudent=amount(meta.preTokenBalances,studentAta,p.student),postStudent=amount(meta.postTokenBalances,studentAta,p.student);
 const preSponsor=amount(meta.preTokenBalances,p.destination,p.sponsor,["created","prefunded"].includes(p.destinationKind)),postSponsor=amount(meta.postTokenBalances,p.destination,p.sponsor);
 const preVault=amount(meta.preTokenBalances,vault,deriveVaultAuthority(p.milestone)[0].toBase58());
 // Transaction-local balances are authoritative for this receipt. Independent
 // credits/spends and unsolicited surplus may occur after the earlier preview.
 check(preVault>=p.reward&&postStudent-preStudent===p.reward&&postSponsor-preSponsor===preVault-p.reward);
 check(Array.isArray(meta.postTokenBalances)&&!meta.postTokenBalances.some((v:any)=>v.accountIndex===keys.indexOf(vault)));
 check(Array.isArray(meta.preBalances)&&Array.isArray(meta.postBalances)&&meta.preBalances.length===keys.length&&meta.postBalances.length===keys.length);
 const before=(a:string)=>lamports(meta.preBalances[keys.indexOf(a)]),after=(a:string)=>lamports(meta.postBalances[keys.indexOf(a)]);
 const returnedRent=before(vault);check(returnedRent>=p.vaultRent&&after(vault)===0n);const rent=after(completion)-before(completion)+(["created","prefunded"].includes(p.destinationKind)?after(p.destination)-before(p.destination):0n);
 check(rent>=0n&&rent<=p.rent);
 const fee=lamports(meta.fee);check(fee===BigInt(expectedFee));check(after(p.sponsor)-before(p.sponsor)===returnedRent-(wallet===p.sponsor?rent+fee:0n));
 if(wallet!==p.sponsor)check(after(wallet)-before(wallet)===-rent-fee);
 const state=await new WorkflowStateReader(rpc).read(p.scope,wallet);
 check(state.slot>=slot&&state.status==="Settled"&&state.student===p.student&&state.rewardAmountRaw===p.reward.toString()&&state.completion===completion&&state.vaultClosed===true);
 return {student:p.student,mint:DEMO_MINT,rewardAmountRaw:p.reward.toString(),studentBeforeRaw:preStudent.toString(),studentAfterRaw:postStudent.toString(),sponsorSurplusRaw:(preVault-p.reward).toString(),sponsorDestination:p.destination,completion,vaultClosed:true,rentReturnedRaw:returnedRent.toString()};
}
