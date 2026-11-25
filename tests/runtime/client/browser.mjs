import {ControlledActions} from "../../../services/verifier/dist/src/controlled-actions.js";
import {ControlledAttestation,attestationScope} from "../../../services/verifier/dist/src/controlled-attestation.js";
import {UPGRADEABLE_LOADER} from "../../../services/verifier/dist/src/devnet-wallet-review.js";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
const financeRequire=createRequire(new URL("../../../packages/finance-client/package.json",import.meta.url));
const {PublicKey,Transaction,Message}=financeRequire("@solana/web3.js");
const envelope={apiVersion:"proofwork-application-api-v1",cluster:"devnet"};
const finance=await import("../../../packages/finance-client/dist/src/index.js");
async function browserArtifact(){const bytes=readFileSync(process.env.PROOFWORK_SBF_PATH??new URL("../../../target/keyless-sbf/sbpfv3-solana-solana/release/proof_of_work.so",import.meta.url));const pin=JSON.parse(readFileSync(new URL("../artifact-provenance.json",import.meta.url)));assert.equal(createHash("sha256").update(bytes).digest("hex"),pin.sha256);return {bytes,sha256:pin.sha256};}
function decode58(v){const alphabet="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";let n=0n;for(const c of v)n=n*58n+BigInt(alphabet.indexOf(c));let h=n.toString(16);if(h.length%2)h="0"+h;return Buffer.concat([Buffer.alloc(v.length-v.replace(/^1+/,"").length),Buffer.from(h,"hex")]);}
function encode58(bytes){const alphabet="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";let n=BigInt("0x"+Buffer.from(bytes).toString("hex")),out="";while(n){out=alphabet[Number(n%58n)]+out;n/=58n;}let zeros=0;while(zeros<bytes.length&&bytes[zeros]===0)zeros++;return "1".repeat(zeros)+out;}
function approval(action){runtime.approvals.push({id:"fixture_"+runtime.approvals.length,operationKey:action.operationKey,scopeDigest:action.scopeDigest,wallet:action.wallet,additionalSigner:action.additionalSigner??null,expiresAt:new Date(Date.now()+60000).toISOString(),maxFeeLamports:10000,maxRentLamports:10000000});}
function wireResult(){const wire=runtime.pending;assert(wire);const tx=Transaction.from(wire);return {ok:true,wireHex:wire.toString("hex"),wireSha256:createHash("sha256").update(wire).digest("hex"),size:wire.length,accountCount:tx.compileMessage().accountKeys.length,requiredSigners:tx.signatures.map(s=>s.publicKey.toBase58())};}
import {DurableOfflineCoordinator} from "../../../services/verifier/dist/src/durable-offline-coordinator.js";
import {WorkflowVerification} from "../../../services/verifier/dist/src/workflow-verification.js";
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
import {retainPlans,retainVerificationRequest,verifierFor,retainVerifierComponents} from "./journey.mjs";
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
 try{await x.browser?.close();await x.workflowVerification?.drain();}finally{if(x.server){x.server.closeAllConnections();await new Promise(resolve=>x.server.close(resolve));}x.store?.close();rmSync(x.dir,{recursive:true,force:true});}
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
 if(q.op==="browser-start"||q.op==="browser-controlled-start"){
  assert(!runtime);const dir=mkdtempSync(join(tmpdir(),"pow-browser-sbf-"));runtime={dir,pub,accounts:q.accounts??{},errors:[],controlled:q.op==="browser-controlled-start",approvals:[],blockhash:q.blockhash,rents:q.rents,time:q.time};
  try{
   const certificates=await tls(),certificate=join(dir,"public-test-ca.pem");writeFileSync(certificate,certificates.cert);
   // Trust only this public test certificate in this disposable browser HOME. No system/user trust changes or TLS bypass.
   const home=join(dir,"home"),nss=join(home,".local/share/pki/nssdb");mkdirSync(nss,{recursive:true});
   execFileSync("certutil",["-N","--empty-password","-d","sql:"+nss]);
   execFileSync("certutil",["-A","-d","sql:"+nss,"-n","ProofOfWork disposable HTTPS fixture","-t","C,,","-i",certificate]);
   const store=runtime.store=new lifecycle.LifecycleStore(join(dir,"empty.sqlite"));
   const rpc=new ReadOnlyWalletRpc(async(_url,init)=>{const body=JSON.parse(init.body);if(runtime.controlled){
     const artifact=(await browserArtifact()).bytes,pd=PublicKey.findProgramAddressSync([new PublicKey(finance.PROGRAM_ID).toBuffer()],new PublicKey(UPGRADEABLE_LOADER))[0].toBase58();
     const observed=(address)=>{const a=runtime.accounts[address];let bytes=a?Buffer.from(a.dataHex,"hex"):null;
      // Explicit synthetic deployment observation only. VM mint/financial state is never changed here.
      if(address===finance.DEMO_MINT&&a){bytes=Buffer.from(bytes);new PublicKey("249mMS9awYGUyMe22zabsSCo8cH4RDo3MeN3mAHFdy69").toBuffer().copy(bytes,4);}
      if(address===finance.PROGRAM_ID){bytes=Buffer.alloc(36);bytes.writeUInt32LE(2);new PublicKey(pd).toBuffer().copy(bytes,4);return {owner:UPGRADEABLE_LOADER,executable:true,lamports:1,data:[bytes.toString("base64"),"base64"]};}
      if(address===pd){bytes=Buffer.alloc(45+artifact.length);bytes.writeUInt32LE(3);bytes.writeBigUInt64LE(1n,4);artifact.copy(bytes,45);return {owner:UPGRADEABLE_LOADER,executable:false,lamports:1,data:[bytes.toString("base64"),"base64"]};}
      return a?{...a,data:[bytes.toString("base64"),"base64"]}:null;
     };
     const values={getGenesisHash:finance.SETTLEMENT_DEVNET_GENESIS,getBlockTime:runtime.time,getLatestBlockhash:{context:{slot:200},value:{blockhash:runtime.blockhash,lastValidBlockHeight:500}},getBlockHeight:100,isBlockhashValid:{context:{slot:200},value:true},getSignatureStatuses:{context:{slot:200},value:[runtime.confirmation?{slot:200,confirmationStatus:"confirmed",err:null}:null]},getTransaction:runtime.confirmation??null};
     let result;if(body.method==="getMultipleAccounts")result={context:{slot:200},value:body.params[0].map(observed)};
     else if(body.method==="getMinimumBalanceForRentExemption")result=runtime.rents[String(body.params[0])];
     else if(body.method==="getFeeForMessage")result={context:{slot:200},value:Message.from(Buffer.from(body.params[0],"base64")).header.numRequiredSignatures*5000};
     else{assert(Object.hasOwn(values,body.method));result=values[body.method];}return Response.json({jsonrpc:"2.0",id:body.id,result});
    }assert(["getGenesisHash","getMultipleAccounts"].includes(body.method));
    return Response.json({jsonrpc:"2.0",id:body.id,result:body.method==="getGenesisHash"?"EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG":{context:{slot:200},value:body.params[0].map(address=>{
     const a=runtime.accounts[address];return a?{...a,data:[Buffer.from(a.dataHex,"hex").toString("base64"),"base64"]}:null;
    })}});
   });
   // Bind first to obtain the actual loopback port; no operational endpoint or fixed port is invented.
   const {createServer}=await import("node:net");const probe=createServer();probe.listen(0,"127.0.0.1");await once(probe,"listening");const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
   const origin=runtime.origin="https://localhost:"+port;
   const workflowState=new WorkflowStateReader(rpc,"offline_fixture"),components=verifierFor(pub,()=>runtime.accounts);
   const coordinator=new DurableOfflineCoordinator(store,components.service,components.reader,{verifier:pub.verifier,feePayer:pub.caller,maxAgeMs:30000,minRemainingBlockHeights:10},"browser_verifier",{read:async()=>({rpc:"https://api.devnet.solana.com",genesisHash:"EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",blockhash:runtime.blockhash,lastValidBlockHeight:500,currentBlockHeight:100,observedAtMs:performance.now(),valid:true})});
   components.takeAuthorizedMessage=()=>{const prepared=runtime.authorized;assert(prepared&&!prepared.used&&performance.now()-prepared.at<30000);prepared.used=true;return coordinator.readMockMessage(prepared.receipt);};
   const offlineVerification=new WorkflowVerification(workflowState,store,coordinator,async binding=>{
    assert.equal(binding.student,pub.student);assert.equal(binding.contributorId,"2002");return "test-user-credential";
   },receipt=>{runtime.authorized={receipt,at:performance.now(),used:false};});runtime.verifierComponents=components;
   const actions=new ControlledActions(store,async()=>({version:"proofwork-controlled-devnet-v1",programId:finance.PROGRAM_ID,mint:finance.DEMO_MINT,genesis:finance.SETTLEMENT_DEVNET_GENESIS,artifactSha256:"1711e2dbbd2f0129f34be5d70e3e48867c42a849b2beea7d36cfbddaf2ed64e1",upgradeAuthority:null,actions:runtime.approvals}),async(url,init)=>{assert.equal(url,finance.SETTLEMENT_DEVNET_RPC);const body=JSON.parse(init.body);assert.equal(body.method,"sendTransaction");assert.equal(body.params[1].skipPreflight,false);assert.equal(body.params[1].maxRetries,0);runtime.pending=Buffer.from(body.params[0],"base64");runtime.confirmation=null;return Response.json({jsonrpc:"2.0",id:body.id,result:encode58(Transaction.from(runtime.pending).signatures[0].signature)});});
   const workflowVerification=runtime.workflowVerification=runtime.controlled?new ControlledAttestation(workflowState,store,components.service,components.reader,actions,async()=>"test-user-credential",rpc,{read:async()=>({rpc:finance.SETTLEMENT_DEVNET_RPC,genesisHash:finance.SETTLEMENT_DEVNET_GENESIS,blockhash:runtime.blockhash,lastValidBlockHeight:500,currentBlockHeight:100,observedAtMs:performance.now(),valid:true})},browserArtifact):offlineVerification;
   runtime.reviewer=new WalletExecutionReviewer(rpc,runtime.controlled?browserArtifact:async()=>undefined,()=>Date.now(),runtime.controlled?actions:undefined);
   runtime.server=await createApplicationServer(certificates,{assetsDirectory:fileURLToPath(new URL("../../../apps/web/dist/",import.meta.url)),sessions:new WalletSessions({origin,domain:new URL(origin).host,cluster:"devnet"}),store,
    service:{verify:async()=>{throw Error("browser_verification_dispatch_forbidden");}},workflowState,workflowVerification,walletReview:runtime.reviewer});
   runtime.server.listen(port,"127.0.0.1");await once(runtime.server,"listening");
   runtime.browser=await chromium.launch({env:{...process.env,HOME:home,XDG_DATA_HOME:join(home,".local/share")}});
   const context=await runtime.browser.newContext({ignoreHTTPSErrors:false}),page=runtime.page=await context.newPage();
   await context.route("**/*",route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
   page.on("pageerror",e=>runtime.errors.push(e.message));
   const responseRuntime=runtime;runtime.walletRequests=0;runtime.apiErrors=[];page.on("response",async response=>{if(response.url().startsWith(origin+"/api/")){const body=await response.json().catch(()=>({}));responseRuntime.apiErrors.push({kind:body.data?.kind,path:new URL(response.url()).pathname,status:response.status(),code:body.error?.code});}});
   await page.exposeFunction("__offlineAuthSignature",(wallet,bytes)=>{
    const message=Buffer.from(bytes).toString("utf8");assert(message.startsWith(new URL(origin).host+" wants you to sign in with your Solana account:\n"+wallet+"\n"));
    assert(message.includes("Sign in to ProofOfWork for read-only application access. No transaction or payment is authorized."));
    assert(message.includes("URI: "+origin+"\nVersion: 1\nChain ID: solana:devnet\n"));
    return Array.from(signAuth(wallet,Buffer.from(bytes)));
   });
   await page.exposeFunction("__offlineTransactionSignature",(wallet,message)=>{runtime.walletRequests++;assert(runtime.controlled);const bytes=decode58(message),tx=Transaction.populate(Message.from(bytes));assert(Message.from(bytes).accountKeys.slice(0,Message.from(bytes).header.numRequiredSignatures).some(k=>k.toBase58()===wallet));tx.addSignature(new PublicKey(wallet),signAuth(wallet,bytes));return Array.from(tx.serialize({requireAllSignatures:false,verifySignatures:false}));});
   await page.addInitScript(()=>{const events={};const key={toBase58:()=>window.__offlineWallet};window.phantom={solana:{isPhantom:true,publicKey:key,
    request:async q=>{if(q.method!=="signTransaction")throw Error("unexpected_wallet_method");const bytes=new Uint8Array(await window.__offlineTransactionSignature(window.__offlineWallet,q.params.message).catch(error=>{window.__walletError=String(error);throw error;}));return {serialize:()=>bytes};},connect:async()=>({publicKey:key}),disconnect:async()=>{for(const f of events.disconnect??[])f();},signMessage:async bytes=>({publicKey:key,signature:new Uint8Array(await window.__offlineAuthSignature(window.__offlineWallet,Array.from(bytes)))}),
    on:(name,f)=>(events[name]??=[]).push(f),removeListener:(name,f)=>{events[name]=(events[name]??[]).filter(x=>x!==f);}}};});
   await page.goto(origin+"/#organization");await login("sponsor");
   const now=Math.floor(Date.now()/1000),assign=new Date((now+3600)*1000).toISOString().slice(0,16),submit=new Date((now+7200)*1000).toISOString().slice(0,16);
   for(const [name,value] of Object.entries({title:"Fictional browser-to-SBF internship",student:pub.student,verifier:pub.verifier,internshipId:"8",milestoneId:"1",rewardAmountRaw:"1000000",assignBy:assign,submitBy:submit,owner:"proofwork-demo",repository:"assignment",manifest:JSON.stringify(manifest())}))await page.locator('[name="'+name+'"]').fill(value);
   await page.getByRole("button",{name:"Prepare organization instructions",exact:true}).click();
   await page.getByRole("heading",{name:"Unsigned instruction plan prepared",exact:true}).waitFor();
   const organization=runtime.organization=JSON.parse(await page.getByRole("textbox",{name:"Prepared instruction JSON",exact:true}).inputValue());
   assert.equal(organization.signed,false);assert.equal(organization.broadcast,false);assert.equal(organization.proposalAuthority,"not_proven");
   await page.getByRole("button",{name:"create internship — review",exact:true}).click();
   await page.getByRole("heading",{name:runtime.controlled?"Ready for review — signing disabled":"Execution blocked",exact:true}).waitFor();
   assert(await page.getByRole("button",{name:"Approve transaction in wallet — disabled",exact:true}).isDisabled());
   retainPlans(organization,null,null);retainVerifierComponents(runtime.verifierComponents);return {ok:true,organization,nowUnixSeconds:now,browser:"actual_chromium_real_https",signing:"offline_provider_double",trust:"isolated_profile_only"};
  }catch(error){await stop();throw error;}
 }
 assert(runtime);
 if(q.op==="browser-stop"){const errors=runtime.errors.slice();await stop();assert.deepEqual(errors,[]);return {ok:true,errors};}
 runtime.accounts=q.accounts??runtime.accounts;runtime.blockhash=q.blockhash??runtime.blockhash;runtime.rents=q.rents??runtime.rents;runtime.time=q.time??runtime.time;runtime.confirmation=q.confirmation??runtime.confirmation;if(runtime.confirmation?.transaction?.[1]==="hex")runtime.confirmation={...runtime.confirmation,transaction:[Buffer.from(runtime.confirmation.transaction[0],"hex").toString("base64"),"base64"]};
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
  retainPlans(organization,submission,evidence);retainVerifierComponents(runtime.verifierComponents);return {ok:true,submission};
 }
 if(q.op==="browser-handoff"){
  const {page}=runtime;
  if(runtime.controlled){const s=await runtime.verifierComponents.reader.read(runtime.organization.milestone);approval({operationKey:"attest_milestone:"+s.milestone,scopeDigest:attestationScope(s,pub.caller),wallet:pub.caller,additionalSigner:pub.verifier});}
  await page.getByRole("button",{name:"Validate private verifier handoff",exact:true}).click();
  await page.getByText(/Request matches the observed submission/).waitFor();
  const request=JSON.parse(await page.getByRole("textbox",{name:"Private validated verifier request — do not publish",exact:true}).inputValue());
  assert.equal(request.student,pub.student);assert.equal(request.milestone,runtime.organization.milestone);retainVerificationRequest(request);
  await page.getByRole("button",{name:"Request independent verification",exact:true}).click();
  await page.getByRole("button",{name:"Refresh verification job",exact:true}).waitFor();await runtime.workflowVerification.drain();
  await page.getByRole("button",{name:"Refresh verification job",exact:true}).click();await page.getByText(/State: authorization pending. Outcome: passed/).waitFor();
  const jobs=runtime.store.jobs.listRecoveryRequired().entries;assert.equal(jobs.length,1);assert.equal(jobs[0].job.state,"authorization_pending");assert.equal(jobs[0].job.bindings.milestone,request.milestone);if(!runtime.controlled)assert.equal(runtime.store.offlineHandoffs.get(jobs[0].job.jobId)?.outcome,"recorded");runtime.jobId=jobs[0].job.jobId;
  return {ok:true,milestone:request.milestone};
 }
 if(q.op==="browser-controlled-wallet"){
  const workflow=q.action==="submit_milestone"?{...envelope,action:"submission",terms:runtime.organization.terms,evidence:runtime.evidence}:q.action==="settle_milestone"?{...envelope,sponsor:pub.sponsor,internshipId:"8",milestoneId:"1"}:{...envelope,action:"organization",terms:runtime.organization.terms};
  const wallet=await runtime.page.evaluate(()=>window.__offlineWallet),preview=await runtime.reviewer.review({operation:q.action,workflow},wallet);assert.equal(preview.state,"ready_for_review");approval(preview);
  await runtime.page.getByRole("button",{name:q.action.replaceAll("_"," ")+" — review",exact:true}).click();await runtime.page.getByRole("heading",{name:"Approved Devnet action — review before signing",exact:true}).waitFor();
  const section=runtime.page.getByRole("region",{name:"Wallet execution review",exact:true}).last();await section.getByRole("button",{name:"Approve transaction in wallet",exact:true}).click();await section.getByText(/Wallet execution state: (signed awaiting broadcast|failed)/).waitFor();if((await section.innerText()).includes("Wallet execution state: failed"))throw Error("wallet approval failed: "+JSON.stringify({responses:runtime.apiErrors,walletRequests:runtime.walletRequests,walletError:await runtime.page.evaluate(()=>window.__walletError)}));
  await section.getByRole("button",{name:"Broadcast signed transaction",exact:true}).click();await section.getByText(/Wallet execution state: unknown/).waitFor();return wireResult();
 }
 if(q.op==="browser-controlled-confirm"){
  const section=runtime.page.getByRole("region",{name:"Wallet execution review",exact:true}).last();await section.getByRole("button",{name:"Check transaction confirmation",exact:true}).click();await section.getByText(/Wallet execution state: confirmed/).waitFor();if(q.action==="settle_milestone")await section.getByText(/exact reward 1000000/).waitFor();return {ok:true};
 }
 if(q.op==="browser-controlled-attest"){
  const {page}=runtime;await logout("student");await login("verifier");const section=page.getByRole("region",{name:"Independent attestation wallet approvals",exact:true});
  const sign=async()=>{await section.getByLabel("Attestation job ID",{exact:true}).fill(runtime.jobId);await section.getByRole("button",{name:"Refresh attestation review",exact:true}).click();await section.getByRole("button",{name:"Approve attestation signature in Phantom",exact:true}).click();await section.getByText(/Your signature was checked/).waitFor();};
  await sign();await logout("verifier");await login("caller");await sign();await section.getByRole("button",{name:"Refresh attestation review",exact:true}).click();await section.getByRole("button",{name:"Broadcast jointly signed attestation",exact:true}).click();await section.getByText(/submitted:/).waitFor();return wireResult();
 }
 if(q.op==="browser-controlled-attest-confirm"){
  const {page}=runtime,section=page.getByRole("region",{name:"Independent attestation wallet approvals",exact:true});await section.getByRole("button",{name:"Check attestation confirmation",exact:true}).click();await section.getByText(/confirmed:/).waitFor();await logout("caller");await login("student");
  const scope=page.getByRole("region",{name:"Observed workflow state",exact:true});for(const [label,value]of [["Recorded sponsor wallet",pub.sponsor],["Internship ID to inspect","8"],["Milestone ID to inspect","1"]])await scope.getByLabel(label,{exact:true}).fill(value);return {ok:true};
 }
 throw Error("unknown_browser_test_operation");
}
