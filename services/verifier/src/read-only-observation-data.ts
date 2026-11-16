import { assertOwnDataFields } from "@proofwork/lifecycle";
export class OfflineReadError extends Error {constructor(public readonly code:string){super(code);}}
export function check(value:unknown,code="invalid_offline_read_data"):asserts value {if(!value)throw new OfflineReadError(code);}
export function record(value:unknown,keys:readonly string[]):Record<string,any>{
 try{
  check(value!==null && typeof value==="object" && [Object.prototype,null].includes(Object.getPrototypeOf(value)));
  assertOwnDataFields(value,keys);return Object.fromEntries(keys.map(k=>[k,Object.getOwnPropertyDescriptor(value,k)!.value]));
 }catch{throw new OfflineReadError("invalid_offline_read_data");}
}
export function tag(value:unknown,key:string):unknown {
 try{const d=Object.getOwnPropertyDescriptor(value,key);check(d&&Object.hasOwn(d,"value"));return d.value;}catch{throw new OfflineReadError("invalid_offline_read_data");}
}
export function list(value:unknown,max:number):unknown[]{
 check(Array.isArray(value)&&value.length<=max&&Reflect.ownKeys(value).length===value.length+1);
 const copy:unknown[]=[];for(let n=0;n<value.length;n++){
  const d=Object.getOwnPropertyDescriptor(value,String(n));check(d&&d.enumerable&&Object.hasOwn(d,"value"));copy.push(d.value);
 }return copy;
}
export function freeze<T>(value:T):T{
 if(value!==null&&typeof value==="object"){for(const v of Object.values(value))freeze(v);Object.freeze(value);}return value;
}
export const rank=(value:unknown)=>value==="processed"?1:value==="confirmed"?2:value==="finalized"?3:0;
