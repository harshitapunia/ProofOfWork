import crypto from "node:crypto";
import readline from "node:readline";
import { createRequire } from "node:module";
const require=createRequire(new URL("../../../packages/finance-client/package.json",import.meta.url));
const {PublicKey,Transaction,TransactionInstruction,SystemProgram}=require("@solana/web3.js");
const client=await import("../../../packages/finance-client/dist/src/index.js");
const keys=new Map(),pub={};
for(const role of ["sponsor","student","verifier","caller","sentinel"]){
 const pair=crypto.generateKeyPairSync("ed25519");
 const address=new PublicKey(pair.publicKey.export({format:"der",type:"spki"}).subarray(-32)).toBase58();
 keys.set(address,pair.privateKey);pub[role]=address;
}
function ix(v){return new TransactionInstruction({programId:new PublicKey(v.programId),data:Buffer.from(v.dataHex,"hex"),
 keys:v.keys.map(k=>({pubkey:new PublicKey(k.pubkey),isSigner:k.isSigner,isWritable:k.isWritable}))});}
for await(const line of readline.createInterface({input:process.stdin})){
 try{
  const q=JSON.parse(line);
  if(q.op==="init"){console.log(JSON.stringify({ok:true,pub}));continue;}
  let tx,selection=null,expectedSigner=pub.caller;
  if(q.op==="prepare"){
   const rpc={rpcEndpoint:client.SETTLEMENT_DEVNET_RPC,
    async getGenesisHash(){return client.SETTLEMENT_DEVNET_GENESIS;},
    async getMultipleAccountsInfo(addresses){return addresses.map(k=>{
      const a=q.accounts[k.toBase58()];return a?{...a,owner:new PublicKey(a.owner),data:Buffer.from(a.dataHex,"hex")}:null;});},
    async getMinimumBalanceForRentExemption(){return q.rent;}};
   const plan=await client.prepareSettlementTransaction({sponsor:pub.sponsor,student:pub.student,caller:pub.caller,
    internshipId:7n,milestoneId:1n,fallbackSeed:q.seed??"bridge_1",...q.input},rpc);
   tx=plan.transaction;selection={destination:plan.sponsorDestination.toBase58(),kind:plan.destinationKind};
  }else if(q.op==="raw-settle"){
   tx=new Transaction().add(client.settleMilestoneInstruction({sponsor:pub.sponsor,student:pub.student,caller:pub.caller,
    internshipId:7n,milestoneId:1n,...q.input}));
   tx.feePayer=new PublicKey(pub.caller);
  }else if(q.op==="lifecycle"){
   const id=q.milestoneId??"1";
   if(typeof id!=="string"||!/^(0|[1-9][0-9]*)$/.test(id))throw new Error("invalid test milestone ID");
   const input={sponsor:pub.sponsor,internshipId:7n,milestoneId:BigInt(id),...q.input};
   let built,role;
   if(q.action==="assign"){
    built=client.assignStudentInstruction({student:pub.student,...input});role=pub.sponsor;
   }else if(q.action==="submit"){
    built=client.submitMilestoneInstruction({student:pub.student,evidenceHash:"09".repeat(32),...input});role=pub.student;
   }else if(q.action==="refund"){
    built=client.refundUnclaimedMilestoneInstruction(input);role=pub.sponsor;
   }else throw new Error("unknown lifecycle builder");
   expectedSigner=q.payer??role;
   tx=new Transaction().add(built);tx.feePayer=new PublicKey(expectedSigner);
  }else if(q.op==="fixture"){
   tx=new Transaction().add(...q.instructions.map(ix));tx.feePayer=new PublicKey(q.payer);
  }else throw new Error("unknown test operation");
  if(q.mutate){const last=tx.instructions.at(-1);last.keys[q.mutate.slot].pubkey=new PublicKey(q.mutate.address);}
  if(q.lateFailure)tx.add(SystemProgram.transfer({fromPubkey:tx.feePayer,toPubkey:new PublicKey(pub.sentinel),lamports:18446744073709551615n}));
  tx.recentBlockhash=q.blockhash;
  const message=tx.serializeMessage(),required=tx.compileMessage().accountKeys.slice(0,tx.compileMessage().header.numRequiredSignatures);
  if(q.op!=="fixture" && (required.length!==1||required[0].toBase58()!==expectedSigner))throw new Error("unexpected signing identity");
  if(!q.unsigned)for(const address of required){
   const secret=keys.get(q.wrongSignature?pub.sentinel:address.toBase58());
   if(!secret)throw new Error("unknown fixture signer");
   tx.addSignature(address,crypto.sign(null,message,secret));
  }
  const wire=tx.serialize({requireAllSignatures:!q.unsigned,verifySignatures:!q.unsigned&&!q.wrongSignature});
  console.log(JSON.stringify({ok:true,origin:q.op,action:q.action??null,mutation:q.mutate??null,lateFailure:Boolean(q.lateFailure),selection,wireHex:wire.toString("hex"),wireSha256:crypto.createHash("sha256").update(wire).digest("hex"),
    size:wire.length,accountCount:tx.compileMessage().accountKeys.length,
    requiredSigners:required.map(k=>k.toBase58()),instructions:tx.instructions.map(i=>({programId:i.programId.toBase58(),
      dataHex:i.data.toString("hex"),keys:i.keys.map(k=>({pubkey:k.pubkey.toBase58(),isSigner:k.isSigner,isWritable:k.isWritable}))}))}));
 }catch(error){console.log(JSON.stringify({ok:false,error:error.code??error.message}));}
}
