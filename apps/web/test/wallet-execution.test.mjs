import {test} from "node:test";
import assert from "node:assert/strict";
import {WalletApprovalFlow,requestPhantomTransaction,LIVE_WALLET_EXECUTION} from "../src/wallet-execution.ts";
const reviewed=()=>({wallet:"offline-test-wallet",reviewId:"offline-test-review",messageBase58:"offline-test-message",expiresAt:new Date(Date.now()+10000).toISOString()});
function setup(overrides={}){const calls=[];const ports={mode:"offline-test-only",wallet:()=>"offline-test-wallet",revalidate:async()=>{calls.push("read");},sign:async()=>{calls.push("sign");return new Uint8Array([1]);},validate:async()=>{calls.push("validate");return "offline-test-signature";},broadcast:async()=>{calls.push("send");return "offline-test-signature";},confirm:async()=>{calls.push("confirm");return "confirmed";},...overrides};return {flow:new WalletApprovalFlow(reviewed(),ports),calls};}
test("separate approval and broadcast actions never automatically send",async()=>{const {flow,calls}=setup();assert.equal(flow.stage,"ready_for_review");assert.deepEqual(calls,[]);await flow.approve();assert.equal(flow.stage,"signed_awaiting_broadcast");assert(!calls.includes("send"));await flow.broadcast();assert.equal(flow.stage,"confirmed");assert.equal(calls.filter(v=>v==="send").length,1);await assert.rejects(flow.broadcast());});
for(const [name,overrides] of [["wrong wallet",{wallet:()=>"other"}],["RPC failure",{revalidate:async()=>{throw Error();}}],["wallet rejection",{sign:async()=>{throw Error();}}],["invalid signed wire",{validate:async()=>{throw Error();}}]])test(name+" consumes attempt without sending",async()=>{const {flow,calls}=setup(overrides);await flow.approve();assert.equal(flow.stage,"failed");assert(!calls.includes("send"));await assert.rejects(flow.approve());});
test("unknown submission is terminal and is not retried",async()=>{let sends=0;const {flow}=setup({broadcast:async()=>{sends++;throw Error("timeout");}});await flow.approve();await flow.broadcast();assert.equal(flow.stage,"unknown");assert.equal(sends,1);await assert.rejects(flow.broadcast());assert.equal(sends,1);});
for(const result of ["unknown","failed"])test("confirmation "+result+" is not success",async()=>{const {flow}=setup({confirm:async()=>result});await flow.approve();await flow.broadcast();assert.equal(flow.stage,result);});
test("stale review and production mode cannot call wallet",async()=>{const {flow,calls}=setup({mode:"disabled"});await flow.approve();assert.equal(flow.stage,"failed");assert.deepEqual(calls,[]);const fresh=setup();fresh.flow=new WalletApprovalFlow({...reviewed(),expiresAt:new Date(0).toISOString()},{mode:"offline-test-only",wallet:()=>"offline-test-wallet"});await fresh.flow.approve();assert.equal(fresh.flow.stage,"failed");});
test("real Phantom adapter is hard-disabled before even inspecting or invoking provider",async()=>{let requests=0;assert.equal(LIVE_WALLET_EXECUTION,false);await assert.rejects(requestPhantomTransaction({publicKey:{toBase58:()=>"offline-test-wallet"},request:async()=>{requests++;throw Error();}},reviewed()),/live_execution_disabled/);assert.equal(requests,0);});

test("concurrent explicit broadcast clicks cannot duplicate submission during revalidation",async()=>{
 let sends=0,release;let reads=0;const gate=new Promise(r=>{release=r;});const {flow}=setup({revalidate:async()=>{if(++reads===2)await gate;},broadcast:async()=>{sends++;return "offline-test-signature";}});
 await flow.approve();const first=flow.broadcast();await assert.rejects(flow.broadcast(),/not_signed/);release();await first;assert.equal(sends,1);assert.equal(flow.stage,"confirmed");
});

test("stage observer receives actual transitions and uncertainty never becomes confirmed",async()=>{
 const stages=[];const {flow:old}=setup();
 const ports={mode:"offline-test-only",wallet:()=>"offline-test-wallet",revalidate:async()=>{},sign:async()=>new Uint8Array([1]),validate:async()=>"offline-signature",broadcast:async()=>"offline-signature",confirm:async()=>"unknown"};
 const flow=new WalletApprovalFlow(reviewed(),ports,()=>Date.now(),s=>stages.push(s));
 await flow.approve();await flow.broadcast();
 assert.deepEqual(stages,["awaiting_wallet_approval","signed_awaiting_broadcast","submitted","confirming","unknown"]);
 assert.equal(old.stage,"ready_for_review");await assert.rejects(flow.broadcast());
});

for(const phase of ["approve","broadcast"])for(const change of ["wallet","expiry"])test("late validation cannot "+phase+" after "+change+" changes",async()=>{
 let wallet="offline-test-wallet",now=0,sends=0,validations=0;
 const ports={mode:"offline-test-only",wallet:()=>wallet,revalidate:async()=>{},sign:async()=>new Uint8Array([1]),
 validate:async()=>{validations++;if(validations===(phase==="approve"?1:2)){if(change==="wallet")wallet="other";else now=10000;}return "signature";},
 broadcast:async()=>{sends++;return "signature";},confirm:async()=>"confirmed"};
 const flow=new WalletApprovalFlow({...reviewed(),expiresAt:new Date(10000).toISOString()},ports,()=>now);
 await flow.approve();if(phase==="broadcast")await flow.broadcast();assert.equal(flow.stage,"failed");assert.equal(sends,0);
});
