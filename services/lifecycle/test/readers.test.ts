import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, SETTLEMENT_DEVNET_RPC, SETTLEMENT_DEVNET_GENESIS, deriveMilestone } from "@proofwork/finance-client";
import { decodeInternship, decodeMilestone, decodeSubmission, decodeCompletionRecord,
  DevnetLifecycleReader, LifecycleError, STATUSES } from "../src/index.js";

interface Raw { address: string; hex: string }
interface Case { id: string; status: number; internship: Raw; milestone: Raw;
  submission: Raw | null; completion: Raw | null; negativeTimestampHex: string }
const fixture = JSON.parse(readFileSync(new URL("../../test/rust-layouts.json", import.meta.url), "utf8")) as { programId: string; cases: Case[] };
const account = (r: Raw | null) => r === null ? null : { owner: PROGRAM_ID, executable: false, data: [Buffer.from(r.hex, "hex").toString("base64"), "base64"] };
const chosen = (n: number, max = false) => fixture.cases.find(c => c.status === n && (max ? c.id !== "0" : c.id === "0"))!;
const invalid = (code = "invalid_account") => (e: unknown) => e instanceof LifecycleError && e.code === code;
function decode(c: Case) {
  const i = decodeInternship(c.internship.address, account(c.internship));
  const m = decodeMilestone(c.milestone.address, account(c.milestone), i);
  const s = c.submission ? decodeSubmission(c.submission.address, account(c.submission), m) : undefined;
  const completion = c.completion ? decodeCompletionRecord(c.completion.address, account(c.completion), m, s!) : undefined;
  return { i, m, s, completion };
}
for (const c of fixture.cases) {
  test("compiled Rust account layout " + c.id + "/" + STATUSES[c.status], () => {
    const { i, m, s, completion } = decode(c);
    assert.equal(i.internshipId, BigInt(c.id)); assert.equal(m.milestoneId, BigInt(c.id));
    assert.equal(m.rewardAmount, 0xffffffffffffffffn);
    assert.equal(m.assignBy, 0x7fffffffffffffffn - 100n); assert.equal(m.submitBy, 0x7fffffffffffffffn);
    assert.equal(m.status, STATUSES[c.status]);
    if (s) assert.equal(s.submittedAt, 0x7fffffffffffffffn - 50n);
    if (completion) assert.equal(completion.settledAt, 0x7fffffffffffffffn);
    assert.ok(Object.isFrozen(i) && Object.isFrozen(m));
    assert.equal(fixture.programId, PROGRAM_ID);
    assert.throws(() => decodeMilestone(c.milestone.address, account({ ...c.milestone, hex: c.negativeTimestampHex }), i), invalid());
  });
}
const settled = chosen(5);
const methods = [
  {name:"Internship",raw:settled.internship,run:(v:unknown,at=settled.internship.address)=>decodeInternship(at,v)},
  {name:"Milestone",raw:settled.milestone,run:(v:unknown,at=settled.milestone.address)=>decodeMilestone(at,v,decode(settled).i)},
  {name:"Submission",raw:settled.submission!,run:(v:unknown,at=settled.submission!.address)=>decodeSubmission(at,v,decode(settled).m)},
  {name:"CompletionRecord",raw:settled.completion!,run:(v:unknown,at=settled.completion!.address)=>{const x=decode(settled);return decodeCompletionRecord(at,v,x.m,x.s!);}},
];
for (const method of methods) {
  for (const name of ["discriminator","owner","truncated","oversized","base64","encoding","executable","missing","extra data encoding","uninitialized","wrong address"]) {
    test(method.name + " rejects " + name, () => {
      const a = structuredClone(account(method.raw))!;
      const data = Buffer.from(method.raw.hex, "hex");
      let value: unknown = a, at = method.raw.address;
      if (name === "discriminator") data[0] = data[0]! ^ 1;
      if (name === "owner") a.owner = PublicKey.default.toBase58();
      if (name === "truncated") a.data[0] = data.subarray(0,-1).toString("base64");
      if (name === "oversized") a.data[0] = Buffer.concat([data,Buffer.alloc(1)]).toString("base64");
      if (name === "base64") a.data[0] = "!" + a.data[0]!.slice(1);
      if (name === "encoding") a.data[1] = "jsonParsed";
      if (name === "executable") a.executable = true;
      if (name === "missing") value = null;
      if (name === "extra data encoding") a.data.push("extra");
      if (name === "uninitialized") data.fill(0);
      if (name === "wrong address") at = PublicKey.default.toBase58();
      if (["discriminator","uninitialized"].includes(name)) a.data[0] = data.toString("base64");
      assert.throws(()=>method.run(value,at), invalid(name === "missing" ? "missing_account" : "invalid_account"));
    });
  }
}
for (const [name,offset] of [["parent",8],["sponsor",40],["student",72],["verifier",104],["mint",136],["submission",168],
  ["requirements",200],["ID",232],["reward",240],["assign deadline",248],["submit deadline",256],
  ["verification time",264],["status",272],["bump",273],["vault bump",274],["authority bump",275]] as const) {
  test("milestone binding/invariant rejects " + name, () => {
    const c = chosen(5), d = Buffer.from(c.milestone.hex,"hex");
    if ([200,240,248,256,264].includes(offset)) d.fill(0,offset,offset+(offset===200?32:8));
    else if (offset===272) d[offset]=255;
    else d[offset]=d[offset]!^1;
    assert.throws(()=>decodeMilestone(c.milestone.address,account({...c.milestone,hex:d.toString("hex")}),decode(c).i),invalid());
  });
}
for (const [kind,offsets] of [["internship",[8,40,48]],["submission",[8,40,72,104,112]],
  ["completion",[8,40,72,104,136,168,200,232,240,248]]] as const) {
  for (const offset of offsets) {
    test(kind + " rejects field mutation at " + offset, () => {
      const c=structuredClone(settled), raw=kind==="internship"?c.internship:kind==="submission"?c.submission!:c.completion!;
      const d=Buffer.from(raw.hex,"hex");
      if ((kind==="completion"&&[232,240].includes(offset)) || (kind==="submission"&&[72,104].includes(offset))) d.fill(0,offset,offset+(offset===72?32:8));
      else d[offset]=d[offset]!^1;
      raw.hex=d.toString("hex");
      assert.throws(()=>decode(c),invalid());
    });
  }
}
test("unbranded/serialized parents and foreign milestone submission are rejected",()=>{
  const x=decode(settled),other=decode(chosen(5,true));
  assert.throws(()=>decodeMilestone(settled.milestone.address,account(settled.milestone),{...x.i}),invalid());
  assert.throws(()=>decodeSubmission(settled.submission!.address,account(settled.submission),{...x.m}),invalid());
  assert.throws(()=>decodeCompletionRecord(settled.completion!.address,account(settled.completion),x.m,other.s!),invalid());
});
test("Submitted layout agrees with unchanged verifier reader",async()=>{
  const c=chosen(3,true),x=decode(c);
  const {decodeState}=await import(new URL("../../../../services/verifier/dist/src/chain.js",import.meta.url).href);
  const old=decodeState(c.milestone.address,account(c.milestone),account(c.submission),account(c.internship),x.m.verifier);
  for(const field of ["student","verifier","requirementsHash"] as const) assert.equal(old[field],x.m[field]);
  assert.equal(old.evidenceHash,x.s!.evidenceHash);assert.equal(old.submission,x.s!.address);
});
function rpc(c:Case, patch: (method:string,result:unknown)=>unknown = (_m,r)=>r): typeof fetch {
  return async(url,init)=>{
    assert.equal(url,SETTLEMENT_DEVNET_RPC);assert.equal(init?.redirect,"error");assert.ok(init?.signal instanceof AbortSignal);
    const q=JSON.parse(String(init?.body));assert.equal(q.id,1);
    let result:unknown=SETTLEMENT_DEVNET_GENESIS;
    if(q.method==="getMultipleAccounts"){
      assert.equal(q.params[1].encoding,"base64");assert.ok(["confirmed","finalized"].includes(q.params[1].commitment));
      const all=new Map([c.internship,c.milestone,c.submission,c.completion].filter((x):x is Raw=>x!==null).map(x=>[x.address,account(x)]));
      result={context:{slot:42},value:q.params[0].map((at:string)=>all.get(at)??null)};
    }
    const value=patch(q.method,result);
    return value instanceof Response ? value : Response.json({jsonrpc:"2.0",id:1,result:value});
  };
}
for(const c of fixture.cases){
  test("fixed-Devnet batch reader status "+c.id+"/"+c.status,async()=>{
    const x=decode(c),reader=new DevnetLifecycleReader("finalized",rpc(c));
    const view=await reader.readMilestone(x.i.sponsor,x.i.internshipId,x.m.milestoneId);
    assert.deepEqual(view.milestone,x.m);assert.deepEqual(view.completion,x.completion);
    assert.equal(view.commitment,"finalized");assert.equal(view.slot,42);
    assert.deepEqual((await reader.readInternship(x.i.sponsor,x.i.internshipId)).internship,x.i);
  });
}
for(const name of ["missing account","missing context","short batch","invalid slot","error envelope","wrong ID","invalid JSON","HTTP 503","wrong genesis","network timeout"]){
  test("RPC fails predictably: "+name,async()=>{
    const c=chosen(5),x=decode(c);
    const request=rpc(c,(method,result)=>{
      if(name==="wrong genesis" && method==="getGenesisHash")return "wrong";
      if(method!=="getMultipleAccounts")return result;
      const a=result as {context:{slot:number};value:unknown[]};
      if(name==="missing account")a.value[0]=null;
      if(name==="missing context")return {value:a.value};
      if(name==="short batch")a.value.pop();
      if(name==="invalid slot")a.context.slot=Number.MAX_SAFE_INTEGER+1;
      if(name==="error envelope")return Response.json({jsonrpc:"2.0",id:1,error:{message:"private test sentinel"}});
      if(name==="wrong ID")return Response.json({jsonrpc:"2.0",id:2,result:a});
      if(name==="invalid JSON")return new Response("{");
      if(name==="HTTP 503")return new Response("",{status:503});
      if(name==="network timeout")throw new DOMException("private test sentinel","TimeoutError");
      return a;
    });
    const reader=new DevnetLifecycleReader("confirmed",request);
    await assert.rejects(reader.readMilestone(x.i.sponsor,x.i.internshipId,x.m.milestoneId),
      invalid(name==="missing account"?"missing_account":name==="wrong genesis"?"wrong_cluster":"rpc_failure"));
  });
}
test("RPC cannot select Mainnet/custom endpoint or unsupported commitment",()=>{
  assert.throws(()=>new DevnetLifecycleReader("processed" as never),invalid("invalid_rpc"));
  assert.throws(()=>new DevnetLifecycleReader("https://api.mainnet-beta.solana.com" as never),invalid("invalid_rpc"));
});
test("incorrect lifecycle links cannot be created by changing scope IDs",()=>{
  const x=decode(settled),wrong=deriveMilestone(x.i.address,1n)[0].toBase58();
  assert.throws(()=>decodeMilestone(wrong,account(settled.milestone),x.i),invalid());
});
