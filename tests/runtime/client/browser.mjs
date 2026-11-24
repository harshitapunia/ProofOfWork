/** Offline test adapter only: actual browser/HTTPS, real SBF snapshots, no external RPC or live sender. */
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {generateKeyPairSync} from "node:crypto";
import {spawn,execFileSync} from "node:child_process";
import {once} from "node:events";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {createApplicationServer} from "../../../services/verifier/dist/src/application.js";
import {WalletSessions} from "../../../services/verifier/dist/src/wallet-sessions.js";
import {WorkflowStateReader} from "../../../services/verifier/dist/src/workflow-state.js";
import {ReadOnlyWalletRpc,WalletExecutionReviewer} from "../../../services/verifier/dist/src/devnet-wallet-review.js";
import {APPLICATION_API_VERSION} from "../../../services/verifier/dist/src/application-api-contracts.js";
import {manifest,COMMIT} from "../../../services/verifier/dist/test/helpers.js";
import {retainPlans,retainVerificationRequest} from "./journey.mjs";
const require=createRequire(new URL("../../../apps/web/package.json",import.meta.url));
const {chromium}=require("@playwright/test");
const lifecycle=await import("../../../services/lifecycle/dist/src/index.js");
let runtime;
async function tls(){
 const pair=generateKeyPairSync("rsa",{modulusLength:2048}),key=Buffer.from(pair.privateKey.export({format:"pem",type:"pkcs8"}));
 const child=spawn("bash",["-o","pipefail","-c","cat | openssl req -new -x509 -key /dev/stdin -subj /CN=localhost -days 1 -addext subjectAltName=DNS:localhost,IP:127.0.0.1"],{stdio:["pipe","pipe","pipe"]});
 const chunks=[];child.stdout.on("data",b=>chunks.push(Buffer.from(b)));child.stderr.resume();child.stdin.end(key);
 const [code]=await once(child,"close");assert.equal(code,0);return {key,cert:Buffer.concat(chunks)};
}
export async function stop(){
 if(!runtime)return;const x=runtime;runtime=null;
 try{await x.browser?.close();}finally{if(x.server){x.server.closeAllConnections();await new Promise(resolve=>x.server.close(resolve));}x.store?.close();rmSync(x.dir,{recursive:true,force:true});}
}
async function login(role){
 const {page,pub}=runtime;
 await page.evaluate(wallet=>{window.__offlineWallet=wallet;},pub[role]);
 const signIn=page.getByRole("button",{name:"Connect Phantom & sign in",exact:true});
 if(!await signIn.isVisible())await page.getByRole("button",{name:"Connect wallet",exact:true}).click();
 await signIn.click();
 await page.getByRole("button",{name:"Wallet session for "+pub[role],exact:true}).waitFor();
 const cookies=await page.context().cookies();const session=cookies.find(c=>c.name==="__Host-proofwork_session");
 assert(session?.secure&&session.httpOnly&&session.sameSite==="Strict");
}
async function logout(role){
 const {page,pub}=runtime;await page.getByRole("button",{name:"Wallet session for "+pub[role],exact:true}).click();
 await page.getByRole("button",{name:"Sign out",exact:true}).click();await page.getByText("Signed out. Private records were cleared.",{exact:true}).waitFor();
}
export async function handle(q,pub,signAuth){
 try{return await handleRequest(q,pub,signAuth);}catch(error){console.error(String(error.stack).split("\n").filter(line=>line.trim().startsWith("at ")).join("\n"));throw error;}
}
async function handleRequest(q,pub,signAuth){
 if(q.op==="browser-start"){
  assert(!runtime);const dir=mkdtempSync(join(tmpdir(),"pow-browser-sbf-"));runtime={dir,pub,accounts:{},errors:[]};
  try{
   const certificates=await tls(),certificate=join(dir,"public-test-ca.pem");writeFileSync(certificate,certificates.cert);
   // Trust only this public test certificate in this disposable browser HOME. No system/user trust changes or TLS bypass.
   const home=join(dir,"home"),nss=join(home,".local/share/pki/nssdb");mkdirSync(nss,{recursive:true});
   execFileSync("certutil",["-N","--empty-password","-d","sql:"+nss]);
   execFileSync("certutil",["-A","-d","sql:"+nss,"-n","ProofOfWork disposable HTTPS fixture","-t","C,,","-i",certificate]);
   const store=runtime.store=new lifecycle.LifecycleStore(join(dir,"empty.sqlite"));
   const rpc=new ReadOnlyWalletRpc(async(_url,init)=>{const body=JSON.parse(init.body);assert(["getGenesisHash","getMultipleAccounts"].includes(body.method));
    return Response.json({jsonrpc:"2.0",id:body.id,result:body.method==="getGenesisHash"?"EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG":{context:{slot:200},value:body.params[0].map(address=>{
     const a=runtime.accounts[address];return a?{...a,data:[Buffer.from(a.dataHex,"hex").toString("base64"),"base64"]}:null;
    })}});
   });
   // Bind first to obtain the actual loopback port; no operational endpoint or fixed port is invented.
   const {createServer}=await import("node:net");const probe=createServer();probe.listen(0,"127.0.0.1");await once(probe,"listening");const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
   const origin=runtime.origin="https://localhost:"+port;
   runtime.server=await createApplicationServer(certificates,{assetsDirectory:fileURLToPath(new URL("../../../apps/web/dist/",import.meta.url)),sessions:new WalletSessions({origin,domain:new URL(origin).host,cluster:"devnet"}),store,
    service:{verify:async()=>{throw Error("browser_verification_dispatch_forbidden");}},workflowState:new WorkflowStateReader(rpc,"offline_fixture"),walletReview:new WalletExecutionReviewer(rpc,async()=>undefined)});
   runtime.server.listen(port,"127.0.0.1");await once(runtime.server,"listening");
   runtime.browser=await chromium.launch({env:{...process.env,HOME:home,XDG_DATA_HOME:join(home,".local/share")}});
   const context=await runtime.browser.newContext({ignoreHTTPSErrors:false}),page=runtime.page=await context.newPage();
   await context.route("**/*",route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
   page.on("pageerror",e=>runtime.errors.push(e.message));
   await page.exposeFunction("__offlineAuthSignature",(wallet,bytes)=>{
    const message=Buffer.from(bytes).toString("utf8");assert(message.startsWith(new URL(origin).host+" wants you to sign in with your Solana account:\n"+wallet+"\n"));
    assert(message.includes("Sign in to ProofOfWork for read-only application access. No transaction or payment is authorized."));
    assert(message.includes("URI: "+origin+"\nVersion: 1\nChain ID: solana:devnet\n"));
    return Array.from(signAuth(wallet,Buffer.from(bytes)));
   });
   await page.addInitScript(()=>{const events={};const key={toBase58:()=>window.__offlineWallet};window.phantom={solana:{isPhantom:true,publicKey:key,
    connect:async()=>({publicKey:key}),disconnect:async()=>{for(const f of events.disconnect??[])f();},signMessage:async bytes=>({publicKey:key,signature:new Uint8Array(await window.__offlineAuthSignature(window.__offlineWallet,Array.from(bytes)))}),
    on:(name,f)=>(events[name]??=[]).push(f),removeListener:(name,f)=>{events[name]=(events[name]??[]).filter(x=>x!==f);}}};});
   await page.goto(origin+"/#organization");await login("sponsor");
   const now=Math.floor(Date.now()/1000),assign=new Date((now+3600)*1000).toISOString().slice(0,16),submit=new Date((now+7200)*1000).toISOString().slice(0,16);
   for(const [name,value] of Object.entries({title:"Fictional browser-to-SBF internship",student:pub.student,verifier:pub.verifier,internshipId:"8",milestoneId:"1",rewardAmountRaw:"1000000",assignBy:assign,submitBy:submit,owner:"proofwork-demo",repository:"assignment",manifest:JSON.stringify(manifest())}))await page.locator('[name="'+name+'"]').fill(value);
   await page.getByRole("button",{name:"Prepare organization instructions",exact:true}).click();
   await page.getByRole("heading",{name:"Unsigned instruction plan prepared",exact:true}).waitFor();
   const organization=runtime.organization=JSON.parse(await page.getByRole("textbox",{name:"Prepared instruction JSON",exact:true}).inputValue());
   assert.equal(organization.signed,false);assert.equal(organization.broadcast,false);assert.equal(organization.proposalAuthority,"not_proven");
   await page.getByRole("button",{name:"create internship — review",exact:true}).click();
   await page.getByRole("heading",{name:"Execution blocked",exact:true}).waitFor();
   assert(await page.getByRole("button",{name:"Approve transaction in wallet — disabled",exact:true}).isDisabled());
   retainPlans(organization,null,null);return {ok:true,organization,nowUnixSeconds:now,browser:"actual_chromium_real_https",signing:"offline_provider_double",trust:"isolated_profile_only"};
  }catch(error){await stop();throw error;}
 }
 assert(runtime);
 if(q.op==="browser-stop"){const errors=runtime.errors.slice();await stop();assert.deepEqual(errors,[]);return {ok:true,errors};}
 runtime.accounts=q.accounts??runtime.accounts;
 if(q.op==="browser-observe"){
  const section=runtime.page.getByRole("region",{name:"Observed workflow state",exact:true});await section.getByRole("button",{name:"Refresh chain observation",exact:true}).click();
  await section.getByRole("heading",{name:q.expected,exact:true}).waitFor();
  const text=await section.innerText();assert(text.includes("offline fixture"));assert(text.includes("Reward payment remains not established"));return {ok:true,status:q.expected};
 }
 if(q.op==="browser-student"){
  const {page,organization}=runtime;await logout("sponsor");await page.getByRole("link",{name:"Student workspace",exact:true}).click();await login("student");
  const evidence=runtime.evidence={contributorId:"2002",commit:COMMIT,nonce:"ef".repeat(32),pullRequest:7};
  await page.locator('[name="proposal"]').fill(JSON.stringify(organization));for(const [name,value] of Object.entries(evidence))await page.locator('[name="'+name+'"]').fill(String(value));
  await page.getByRole("button",{name:"Validate evidence & prepare submission",exact:true}).click();await page.getByRole("heading",{name:"Unsigned instruction plan prepared",exact:true}).waitFor();
  const submission=JSON.parse(await page.getByRole("textbox",{name:"Prepared instruction JSON",exact:true}).inputValue());
  retainPlans(organization,submission,evidence);return {ok:true,submission};
 }
 if(q.op==="browser-handoff"){
  const {page}=runtime;await page.getByRole("button",{name:"Validate private verifier handoff",exact:true}).click();
  await page.getByText(/Request matches the observed submission/).waitFor();
  const request=JSON.parse(await page.getByRole("textbox",{name:"Private validated verifier request — do not publish",exact:true}).inputValue());
  assert.equal(request.student,pub.student);assert.equal(request.milestone,runtime.organization.milestone);retainVerificationRequest(request);return {ok:true,milestone:request.milestone};
 }
 throw Error("unknown_browser_test_operation");
}
