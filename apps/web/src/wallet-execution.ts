/** Wallet approval state flow. Production requires a fresh server-approved action; offline doubles grant no live permission. */
export const LIVE_WALLET_EXECUTION = false;
export type WalletStage = "prepared" | "ready_for_review" | "awaiting_wallet_approval" | "signed_awaiting_broadcast" | "submitted" | "confirming" | "confirmed" | "failed" | "unknown";
export interface ReviewedMessage { wallet:string; reviewId:string; messageBase58:string; expiresAt:string;liveExecution?:boolean }
export interface WalletPorts {
  readonly mode:"disabled"|"offline-test-only"|"approved-devnet";
  wallet():string|null;
  revalidate():Promise<void>;
  sign():Promise<Uint8Array>;
  validate(wire:Uint8Array):Promise<string>;
  broadcast(wire:Uint8Array):Promise<string>;
  confirm(wire:Uint8Array,signature:string):Promise<"confirmed"|"failed"|"unknown">;
}
export class WalletApprovalFlow {
  stage:WalletStage="ready_for_review"; signature:string|null=null;
  #wire:Uint8Array|null=null;
  #broadcastStarted=false;
  private readonly review:ReviewedMessage;
  private readonly ports:WalletPorts;
  private readonly now:()=>number;
  private readonly changed:(stage:WalletStage)=>void;
  constructor(review:ReviewedMessage,ports:WalletPorts,now=()=>Date.now(),changed:(stage:WalletStage)=>void=()=>{}){this.review=review;this.ports=ports;this.now=now;this.changed=changed;}
  private transition(stage:WalletStage){this.stage=stage;this.changed(stage);}
  private fresh(){if(this.ports.mode!=="offline-test-only"&&!(this.ports.mode==="approved-devnet"&&this.review.liveExecution===true))throw new Error("live_execution_disabled");
    if(this.ports.wallet()!==this.review.wallet)throw new Error("wallet_changed");
    if(!Number.isFinite(Date.parse(this.review.expiresAt)) || this.now()>=Date.parse(this.review.expiresAt))throw new Error("review_expired");}
  /** Separate explicit action. A failed/rejected attempt is consumed; obtain fresh review manually. */
  async approve(){if(this.stage!=="ready_for_review")throw new Error("attempt_consumed");this.transition("awaiting_wallet_approval");
    try{this.fresh();await this.ports.revalidate();this.fresh();const wire=await this.ports.sign();this.fresh();
      if(!(wire instanceof Uint8Array)||wire.length>1232)throw new Error("invalid_wire");const copy=Uint8Array.from(wire);
      const signature=await this.ports.validate(Uint8Array.from(copy));this.fresh();this.signature=signature;this.#wire=copy;this.transition("signed_awaiting_broadcast");
    }catch{this.#wire=null;this.signature=null;this.transition("failed");}}
  /** Separate explicit action; all uncertain sends are terminal unknown, with no automatic retry. */
  async broadcast(){if(this.stage!=="signed_awaiting_broadcast"||!this.#wire||!this.signature||this.#broadcastStarted)throw new Error("not_signed");
    this.#broadcastStarted=true;
    try{this.fresh();await this.ports.revalidate();this.fresh();if(await this.ports.validate(Uint8Array.from(this.#wire))!==this.signature)throw new Error("wire_changed");this.fresh();}
    catch{this.transition("failed");this.#wire=null;return;}
    this.transition("submitted");
    try{const signature=await this.ports.broadcast(Uint8Array.from(this.#wire));if(signature!==this.signature)throw new Error("signature_mismatch");
      this.transition("confirming");this.transition(await this.ports.confirm(Uint8Array.from(this.#wire),signature));
    }catch{this.transition("unknown");}finally{if(!["unknown"].includes(this.stage))this.#wire=null;}}
  /** Explicit read-only reconciliation. Never signs, changes bytes or submits again. */
  async reconcile(){if(this.stage!=="unknown"||!this.#wire||!this.signature)throw new Error("confirmation_unavailable");
    if(this.ports.wallet()!==this.review.wallet)throw new Error("wallet_changed");this.transition("confirming");try{this.transition(await this.ports.confirm(Uint8Array.from(this.#wire),this.signature));}catch{this.transition("unknown");}if(!["unknown"].includes(this.stage))this.#wire=null;}
}
/** Real traditional Phantom adapter, sign-only adapter; server authorization is required before requesting Phantom. */
export async function requestPhantomTransaction(wallet:{publicKey:{toBase58():string}|null;request?:(r:object)=>Promise<unknown>},review:ReviewedMessage):Promise<Uint8Array>{
  if(review.liveExecution!==true)throw new Error("live_execution_disabled");
  if(wallet.publicKey?.toBase58()!==review.wallet || typeof wallet.request!=="function")throw new Error("wallet_unavailable");
  // Phantom's documented sign-only request; never signAndSendTransaction or signMessage transaction fallbacks.
  const signed=await wallet.request({method:"signTransaction",params:{message:review.messageBase58}}) as {serialize?:(options?:{requireAllSignatures:boolean;verifySignatures:boolean})=>Uint8Array};
  if(wallet.publicKey?.toBase58()!==review.wallet || typeof signed?.serialize!=="function")throw new Error("wallet_changed");
  const wire=signed.serialize({requireAllSignatures:false,verifySignatures:false});if(!(wire instanceof Uint8Array)||wire.length>1232)throw new Error("invalid_wire");return Uint8Array.from(wire);
}
