import { LifecycleStore } from "../src/storage.js";
import { DatabaseSync } from "node:sqlite";
const [path,sponsor,mode]=process.argv.slice(2) as [string,string,string];
if(mode==="uncommitted"){
 const db=new DatabaseSync(path);db.exec("BEGIN IMMEDIATE");
 db.prepare("UPDATE counters SET next=? WHERE kind='internship' AND scope=?").run("00000000000000000999",sponsor);
 process.send!({ready:true});
}else{
 const store=new LifecycleStore(path);const r=store.reserveInternship(sponsor);
 process.send!({ready:true,id:r.id,value:r.value.toString()});
}
process.on("message",()=>{});
