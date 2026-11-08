import { test } from "node:test";
import assert from "node:assert/strict";
import { CASES, TEST_DIGEST, parseManifest, suiteCaseIds, type Manifest } from "../src/manifest.js";
import { SUM_V2_DIGEST, SUM_V2_POLICY, SUM_V2_IDS, SUM_V2_HARNESS, sumV2OutcomesPass, sumV2OutputPass, createSumV2Cases, type RandomInt } from "../src/sum-v2.js";
import { DockerRunner, type Command, type CommandResult } from "../src/runner.js";
import { VerifierService } from "../src/service.js";
import { AttestationAuthorizer, AttestationError } from "../src/attestation.js";
import { DevnetAttestationReader } from "../src/attestation-chain.js";
import { GitHub } from "../src/github.js";
import { evidenceHash, requirementsHash, sha256 } from "../src/commitments.js";
import { VerificationError } from "../src/errors.js";
import { manifest, fixture, githubFetch, TOKEN, IMAGE } from "./helpers.js";

const v2 = (): Manifest => ({...manifest(),task:"sum-v2",tests:{suite:"sum-v2",sha256:SUM_V2_DIGEST}});
// Reproducible test doubles only; production defaults to node:crypto.randomInt.
const draw:RandomInt = (min,max)=> min + Math.floor((max-min)/3);
const error = (code:string)=>(e:unknown)=>e instanceof VerificationError && e.code===code;
const ok:CommandResult={code:0,stdout:"",stderr:"",timeout:false,overflow:false};
const id="12".repeat(32);
// Models Docker transport output for hand-written arithmetic behaviors. Never evaluates source on host.
function command(behavior:(values:number[])=>number,trace:string[][]=[]):Command {
  let input:number[]=[];
  return async args=>{
    trace.push(args);
    switch(args[0]) {
      case "version":return {...ok,stdout:"mock"};
      case "create":input=JSON.parse(args.at(-1)!) as number[];return {...ok,stdout:id};
      case "start":return {...ok,stdout:JSON.stringify(behavior(input))};
      case "inspect":return {...ok,stdout:JSON.stringify({Status:"exited",Running:false,OOMKilled:false,Error:"",ExitCode:0})};
      case "rm":return ok;
      default:throw Error("unexpected command");
    }
  };
}
const sum=(v:number[])=>v.reduce((a,b)=>a+b,0);

/** Binds the v2 manifest and evidence into mocked authoritative state without changing account ABI. */
function setup(m=v2()) {
  const f=fixture();
  const bytes=Buffer.from(JSON.stringify(m)), hash=requirementsHash(bytes);
  f.request.manifestBase64=bytes.toString("base64");hash.copy(f.m,200);
  evidenceHash({...f.request,requirementsHash:hash.toString("hex")}).copy(f.s,72);
  const chain=new DevnetAttestationReader("https://api.devnet.solana.com",f.verifier.toBase58(),f.rpc);
  return {...f,chain};
}

test("sum-v1 cases, digest and all four original runner outcomes remain unchanged",async()=>{
  assert.equal(TEST_DIGEST,"5b4904fdcfb094c62e7b1d8b674d8d2bf92ed3b7b5abaef9e811e8c003f76611");
  assert.deepEqual(CASES,[{id:"empty",input:[],expected:0},{id:"positive",input:[1,2,3],expected:6},
    {id:"negative",input:[-4,7,-2],expected:1},{id:"fraction",input:[.25,.5],expected:.75}]);
  const m=parseManifest(Buffer.from(JSON.stringify(manifest()))).manifest;
  const result=await new DockerRunner(IMAGE,command(sum),()=>{throw Error("v1 must not draw randomness");}).run(Buffer.from("mock source only"),m);
  assert.deepEqual(result,CASES.map(c=>({id:c.id,passed:true})));
});
test("sum-v2 policy pins test generation and acceptance separately from v1",()=>{
  assert.equal(SUM_V2_DIGEST,"e9186f25eda2c31fa47f99897064f10b51d2f1ba7699672504b4c08d48846d5a");
  assert.equal(SUM_V2_DIGEST,sha256(Buffer.from(SUM_V2_POLICY)).toString("hex"));
  assert.notEqual(SUM_V2_DIGEST,TEST_DIGEST);
  assert.deepEqual(suiteCaseIds(parseManifest(Buffer.from(JSON.stringify(v2()))).manifest),SUM_V2_IDS);
});
test("random and edge-case oracles use exact quarter ticks with bounded counts and lengths",()=>{
  let calls=0;
  const cases=createSumV2Cases((min,max)=>{calls++;return calls%2===0?min:max-1;});
  assert.equal(cases.length,18);assert.ok(calls<=8*(1+64));
  assert.deepEqual(cases.map(c=>c.id),SUM_V2_IDS);
  for(const c of cases) {
    assert.ok(c.input.length<=128);
    const ticks=c.input.map(v=>{assert.ok(Number.isSafeInteger(v*4));return BigInt(v*4);});
    assert.equal(c.expected,Number(ticks.reduce((a,b)=>a+b,0n))/4);
    assert.ok(Number.isFinite(c.expected));
  }
  assert.deepEqual(createSumV2Cases(draw),createSumV2Cases(draw));
  assert.ok(cases.some(c=>c.input.length===128));
  assert.ok(cases.some(c=>c.input.some(v=>v%1!==0)));
});
test("default CSPRNG runs use only the committed range and bounds",()=>{
  for(let n=0;n<5;n++) {
    const cases=createSumV2Cases();
    for(const c of cases.slice(10)) {
      assert.ok(c.input.length<=64);
      assert.ok(c.input.every(v=>v>=-1024&&v<=1024&&Number.isInteger(v*4)));
    }
  }
});
for(const bad of [NaN,Infinity,0.5,-100000,100000]) {
  test("invalid trusted randomness fails closed: "+bad,()=>assert.throws(()=>createSumV2Cases(()=>bad),error("runner_failure")));
}
test("entropy-source failure never starts a container",async()=>{
  let invoked=false;
  await assert.rejects(new DockerRunner(IMAGE,async()=>{invoked=true;return ok;},()=>{throw Error("entropy unavailable");})
    .run(Buffer.from("mock source"),v2()),/entropy unavailable/);
  assert.equal(invoked,false);
});
for(const patch of [{task:"sum-v3"},{tests:{suite:"sum-v1",sha256:TEST_DIGEST}},
  {tests:{suite:"sum-v2",sha256:TEST_DIGEST}},{tests:{suite:"sum-v2",sha256:"00".repeat(32)}}]) {
  test("rejects unsupported or downgraded suite policy "+JSON.stringify(patch),()=>{
    const m={...v2(),...patch};
    assert.throws(()=>parseManifest(Buffer.from(JSON.stringify(m))),error("invalid_manifest"));
    assert.throws(()=>suiteCaseIds(m as Manifest),error("invalid_manifest"));
  });
}
const behaviors:Record<string,(v:number[])=>number>={
  correct:sum,
  hardcoded:v=>({"[]":0,"[1,2,3]":6,"[-4,7,-2]":1,"[0.25,0.5]":.75}[JSON.stringify(v)]??999),
  negatives:v=>sum(v.filter(x=>x>=0)),fractions:v=>sum(v.map(Math.trunc)),
  empty:v=>v.length?sum(v):1,large:v=>sum(v.slice(0,8))
};
for(const [name,behavior] of Object.entries(behaviors)) {
  test("sum-v2 modeled Docker behavior: "+name,async()=>{
    const trace:string[][]=[];
    const outcomes=await new DockerRunner(IMAGE,command(behavior,trace),draw).run(Buffer.from("opaque fixture; not executed"),v2());
    assert.equal(outcomes.length,18);
    assert.equal(outcomes.every(o=>o.passed),name==="correct");
    assert.equal(trace.filter(a=>a[0]==="create").length,18);
    assert.equal(trace.filter(a=>a[0]==="rm").length,18);
    for(const a of trace.filter(a=>a[0]==="create"))
      for(const flag of ["--network=none","--user=65534:65534","--read-only","--cap-drop=ALL","--pull=never","--log-driver=none"])
        assert.ok(a.includes(flag));
    assert.ok(outcomes.every(o=>Object.keys(o).join(",")==="id,passed"));
  });
}
test("v2 service approval and single-use attestation require the v2 suite",async()=>{
  const f=setup();
  const service=new VerifierService(new GitHub(githubFetch()),f.chain,new DockerRunner(IMAGE,command(sum),draw));
  const result=await service.verify(f.request,TOKEN);
  assert.equal(result.approved,true);assert.deepEqual(result.outcomes.map(o=>o.id),SUM_V2_IDS);
  assert.ok(!JSON.stringify(result).includes('"input"')&&!JSON.stringify(result).includes('"expected"'));
  const authorizer=new AttestationAuthorizer(service,f.chain,f.verifier.toBase58());
  const ticket=await authorizer.prepare(f.request,TOKEN);
  assert.equal((await authorizer.takeInstruction(ticket)).data.length,104);
  await assert.rejects(authorizer.takeInstruction(ticket),e=>e instanceof AttestationError&&e.code==="invalid_authorization");
});
for(const behavior of Object.keys(behaviors).filter(n=>n!=="correct")) {
  test("v2 failed "+behavior+" never approves or authorizes",async()=>{
    const f=setup();
    const service=new VerifierService(new GitHub(githubFetch()),f.chain,new DockerRunner(IMAGE,command(behaviors[behavior]!),draw));
    const result=await service.verify(f.request,TOKEN);
    assert.equal(result.reason,"tests_failed");assert.equal(result.approved,false);assert.equal(result.attestation,undefined);
    await assert.rejects(new AttestationAuthorizer(service,f.chain,f.verifier.toBase58()).prepare(f.request,TOKEN),e=>e instanceof AttestationError&&e.code==="verification_failed");
  });
}
test("v1 outcomes cannot approve a v2 commitment, and v1 manifests cannot downgrade v2 chain requirements",async()=>{
  const f=setup();let runs=0;
  const service=new VerifierService(new GitHub(githubFetch()),f.chain,{run:async()=>{runs++;return CASES.map(c=>({id:c.id,passed:true}));}});
  assert.equal((await service.verify(f.request,TOKEN)).reason,"tests_failed");
  const old=Buffer.from(JSON.stringify(manifest())).toString("base64");
  assert.equal((await service.verify({...f.request,manifestBase64:old},TOKEN)).reason,"requirements_mismatch");
  assert.equal(runs,1);
});
test("authorizer independently rejects v1 outcome substitution in an otherwise successful v2 result",async()=>{
  const f=setup();
  const service=new VerifierService(new GitHub(githubFetch()),f.chain,new DockerRunner(IMAGE,command(sum),draw));
  const forged={verify:async(input:unknown,token:string)=>({...await service.verify(input,token),outcomes:CASES.map(c=>({id:c.id,passed:true}))})};
  await assert.rejects(new AttestationAuthorizer(forged,f.chain,f.verifier.toBase58()).prepare(f.request,TOKEN),e=>e instanceof AttestationError&&e.code==="verification_failed");
});


test("sum-v1 cannot claim the sum-v2 policy digest",()=>{
  assert.throws(()=>parseManifest(Buffer.from(JSON.stringify({...manifest(),tests:{suite:"sum-v2",sha256:SUM_V2_DIGEST}}))),error("invalid_manifest"));
});
test("sum-v2 malformed truthy outcomes fail closed",async()=>{
  const f=setup();
  const service=new VerifierService(new GitHub(githubFetch()),f.chain,{run:async()=>SUM_V2_IDS.map(id=>({id,passed:"true" as unknown as boolean}))});
  const result=await service.verify(f.request,TOKEN);
  assert.equal(result.approved,false);assert.equal(result.reason,"tests_failed");assert.equal(result.attestation,undefined);
});


test("invalid random element draw fails closed after a valid length draw",()=>{
  let calls=0;
  assert.throws(()=>createSumV2Cases(()=>++calls===1?1:4097),error("runner_failure"));
});
for(const mutation of ["missing","duplicate","reordered"] as const) {
  test("v2 rejects "+mutation+" outcome sets",async()=>{
    const f=setup();
    const outcomes=SUM_V2_IDS.map(id=>({id,passed:true}));
    if(mutation==="missing") outcomes.pop();
    if(mutation==="duplicate") outcomes[1]={...outcomes[0]!};
    if(mutation==="reordered") outcomes.reverse();
    const service=new VerifierService(new GitHub(githubFetch()),f.chain,{run:async()=>outcomes});
    assert.equal((await service.verify(f.request,TOKEN)).reason,"tests_failed");
    await assert.rejects(new AttestationAuthorizer(service,f.chain,f.verifier.toBase58()).prepare(f.request,TOKEN),e=>e instanceof AttestationError&&e.code==="verification_failed");
  });
}
test("v2 preserves GitHub identity failure before any Docker execution",async()=>{
  const f=setup();let runs=0;
  const service=new VerifierService(new GitHub(githubFetch({"/user":{id:9}})),f.chain,{run:async()=>{runs++;return [];}});
  const result=await service.verify(f.request,TOKEN);
  assert.equal(result.reason,"invalid_github_identity");assert.equal(result.approved,false);
  await assert.rejects(new AttestationAuthorizer(service,f.chain,f.verifier.toBase58()).prepare(f.request,TOKEN),e=>e instanceof AttestationError&&e.code==="verification_failed");
  assert.equal(runs,0);
});


for (const mutation of ["sparse", "hole", "inherited", "null", "extra-input", "array-entry"] as const) {
  test("v2 service and authorizer reject malformed outcomes: " + mutation, async () => {
    const f=setup();
    const outcomes=SUM_V2_IDS.map(id=>({id,passed:true}));
    if(mutation==="sparse") outcomes.fill(undefined as never);
    if(mutation==="sparse") for(let i=0;i<outcomes.length;i++) delete outcomes[i];
    if(mutation==="hole") delete outcomes[3];
    if(mutation==="inherited") { const proto=Object.create(Array.prototype) as Record<number,unknown>;proto[3]=outcomes[3];Object.setPrototypeOf(outcomes,proto);delete outcomes[3]; }
    if(mutation==="null") outcomes[3]=null as never;
    if(mutation==="extra-input") Object.assign(outcomes[3]!,{input:[1,2,3]});
    if(mutation==="array-entry") outcomes[3]=Object.assign([],{id:SUM_V2_IDS[3]!,passed:true});
    assert.equal(sumV2OutcomesPass(outcomes),false);
    const service=new VerifierService(new GitHub(githubFetch()),f.chain,{run:async()=>outcomes});
    const result=await service.verify(f.request,TOKEN);
    assert.equal(result.approved,false);assert.equal(result.reason,"tests_failed");assert.equal(result.attestation,undefined);
    await assert.rejects(new AttestationAuthorizer(service,f.chain,f.verifier.toBase58()).prepare(f.request,TOKEN),e=>e instanceof AttestationError&&e.code==="verification_failed");
    assert.deepEqual(result.outcomes,[]);
    assert.ok(!JSON.stringify(result).includes('"input"'));
    // Independently test the authorizer with a trusted-service double that claims success.
    const good=new VerifierService(new GitHub(githubFetch()),f.chain,new DockerRunner(IMAGE,command(sum),draw));
    const forged={verify:async(input:unknown,token:string)=>({...await good.verify(input,token),outcomes})};
    await assert.rejects(new AttestationAuthorizer(forged,f.chain,f.verifier.toBase58()).prepare(f.request,TOKEN),e=>e instanceof AttestationError&&e.code==="verification_failed");
  });
}
test("v2 commitment includes the actual harness and explicit acceptance conditions",()=>{
  const policy=JSON.parse(SUM_V2_POLICY);
  assert.equal(policy.harnessSha256,sha256(Buffer.from(SUM_V2_HARNESS)).toString("hex"));
  assert.equal(policy.acceptance.cliExitCode,0);assert.equal(policy.acceptance.containerExitCode,0);
  assert.equal(policy.acceptance.cleanup,"must succeed before returning outcomes");
  assert.equal(policy.acceptance.stdout,"exact JSON.stringify(expected); no extra bytes");
});
for (const [name,stdout,stderr,cli,exit] of [
  ["correct","0.75","",0,0],["rounded","0.8","",0,0], ["quoted",'"0.75"',"",0,0],
  ["newline","0.75\n","",0,0],["stderr","0.75","x",0,0], ["CLI failure","0.75","",1,0],
  ["container failure","0.75","",0,1], ["no exit","0.75","",null,0]
] as const) {
  test("v2 exact output contract: "+name,()=>assert.equal(sumV2OutputPass(stdout,stderr,cli,exit,.75),name==="correct"));
}
