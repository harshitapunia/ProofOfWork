import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { PROGRAM_ID, SETTLEMENT_DEVNET_GENESIS } from "@proofwork/finance-client";
import { LifecycleStore, decodeInternship, decodeMilestone, type JobBindings, LifecycleError } from "../src/index.js";
export function bindings(max=false):JobBindings {
 const fixture=JSON.parse(readFileSync(new URL("../../test/rust-layouts.json",import.meta.url),"utf8"));
 const c=fixture.cases.find((v:{status:number;id:string})=>v.status===3&&(max?v.id!=="0":v.id==="0"));
 const a=(x:{hex:string})=>({owner:PROGRAM_ID,executable:false,data:[Buffer.from(x.hex,"hex").toString("base64"),"base64"]});
 const i=decodeInternship(c.internship.address,a(c.internship));
 const m=decodeMilestone(c.milestone.address,a(c.milestone),i);
 return {cluster:"devnet",genesisHash:SETTLEMENT_DEVNET_GENESIS,programId:PROGRAM_ID,sponsor:i.sponsor,
  internshipId:i.internshipId.toString(),internship:i.address,milestoneId:m.milestoneId.toString(),milestone:m.address,
  submission:m.submission,student:m.student,verifier:m.verifier,requirementsHash:m.requirementsHash,evidenceHash:"09".repeat(32),
  repositoryId:"1001",contributorId:"2002",commit:"cd".repeat(20),verificationSpecHash:m.requirementsHash};
}
export const error=(code:string)=>(e:unknown)=>e instanceof LifecycleError&&e.code===code;
export function temp(t:TestContext){
 const dir=mkdtempSync(join(tmpdir(),"pow-jobs-")),path=join(dir,"local.sqlite"),close:(()=>void)[]=[];
 t.after(()=>{for(const fn of close.reverse())try{fn();}catch{}rmSync(dir,{recursive:true,force:true});});
 return {path,dir,store(){const s=new LifecycleStore(path,5000);close.push(()=>s.close());return s;},
  raw(){const d=new DatabaseSync(path);close.push(()=>d.close());return d;}};
}
