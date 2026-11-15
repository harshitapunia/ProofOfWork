import { parentPort, workerData } from "node:worker_threads";
import { LifecycleStore } from "../src/storage.js";
const { path, sponsor, gate, count } = workerData as { path:string;sponsor:string;gate:SharedArrayBuffer;count:number };
const store=new LifecycleStore(path,5000);
parentPort!.postMessage("ready");
const rounds=new Int32Array(gate);
for(let n=0;n<count;n++){
  while(Atomics.load(rounds,0) <= n)Atomics.wait(rounds,0,n);
  parentPort!.postMessage(store.reserveInternship(sponsor).value.toString());
}
store.close();
