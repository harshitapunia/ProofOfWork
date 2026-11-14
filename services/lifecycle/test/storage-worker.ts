import { parentPort, workerData } from "node:worker_threads";
import { LifecycleStore } from "../src/storage.js";
const { path, sponsor, gate, count } = workerData as { path:string;sponsor:string;gate:SharedArrayBuffer;count:number };
const store=new LifecycleStore(path,5000);
parentPort!.postMessage("ready");
Atomics.wait(new Int32Array(gate),0,0);
const ids=[];
for(let n=0;n<count;n++)ids.push(store.reserveInternship(sponsor).value.toString());
store.close();parentPort!.postMessage(ids);
