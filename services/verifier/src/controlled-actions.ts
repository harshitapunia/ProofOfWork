/** Operator-approved Devnet effects. No approval file is created and no signer is held here. */
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { LifecycleStore } from "@proofwork/lifecycle";
import {
  PROGRAM_ID,
  DEMO_MINT,
  SETTLEMENT_DEVNET_GENESIS,
  SETTLEMENT_DEVNET_RPC,
} from "@proofwork/finance-client";
import { WalletAuthError } from "./wallet-sessions.js";
import { jsonResponse } from "./http.js";
const ARTIFACT =
  "1711e2dbbd2f0129f34be5d70e3e48867c42a849b2beea7d36cfbddaf2ed64e1";
function check(v: unknown, code = "action_not_approved"): asserts v {
  if (!v) throw new WalletAuthError(code, 403);
}
function exact(v: any, keys: string[]) {
  check(
    v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      JSON.stringify(Object.keys(v).sort()) === JSON.stringify(keys.sort())
  );
}
function key(v: unknown): asserts v is string {
  check(typeof v === "string");
  try {
    const k = new PublicKey(v);
    check(
      k.toBase58() === v &&
        !k.equals(PublicKey.default) &&
        PublicKey.isOnCurve(k.toBytes())
    );
  } catch {
    throw new WalletAuthError("action_not_approved", 403);
  }
}
function bounded(v: any) {
  check(Number.isSafeInteger(v) && v >= 0);
}
export const messageDigest = (v: Uint8Array) =>
  createHash("sha256").update(v).digest("hex");
/** Canonical public commitment; caller supplies validated scope, never a purported approval. */
export function scopeDigest(v: unknown): string {
  const canonical = (x: any): any =>
    Array.isArray(x)
      ? x.map(canonical)
      : x && typeof x === "object"
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, canonical(x[k])])
        )
      : typeof x === "bigint"
      ? x.toString()
      : x;
  return messageDigest(Buffer.from(JSON.stringify(canonical(v))));
}
export interface ActionApproval {
  id: string;
  operationKey: string;
  scopeDigest: string;
  wallet: string;
  additionalSigner: string | null;
  expiresAt: string;
  maxFeeLamports: number;
  maxRentLamports: number;
}
export interface RehearsalApproval {
  version: "proofwork-controlled-devnet-v1";
  programId: string;
  mint: string;
  genesis: string;
  artifactSha256: string;
  upgradeAuthority: string | null;
  actions: ActionApproval[];
}
/** Reload on every boundary for revocation. Only a private, owner-controlled regular file is accepted. */
export function approvalFile(path: string): () => Promise<RehearsalApproval> {
  check(isAbsolute(path));
  return async () => {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const st = await handle.stat();
      check(
        st.isFile() &&
          (st.mode & 0o077) === 0 &&
          st.size > 0 &&
          st.size <= 32768 &&
          (!process.getuid || st.uid === process.getuid())
      );
      const bytes = await handle.readFile();
      check(bytes.length <= 32768);
      return parseApproval(JSON.parse(bytes.toString("utf8")));
    } catch {
      throw new WalletAuthError("action_not_approved", 403);
    } finally {
      await handle?.close();
    }
  };
}
export function parseApproval(v: unknown): RehearsalApproval {
  const a = v as RehearsalApproval;
  exact(a, [
    "version",
    "programId",
    "mint",
    "genesis",
    "artifactSha256",
    "upgradeAuthority",
    "actions",
  ]);
  check(
    a.version === "proofwork-controlled-devnet-v1" &&
      a.programId === PROGRAM_ID &&
      a.mint === DEMO_MINT &&
      a.genesis === SETTLEMENT_DEVNET_GENESIS &&
      a.artifactSha256 === ARTIFACT
  );
  if (a.upgradeAuthority !== null) key(a.upgradeAuthority);
  check(
    Array.isArray(a.actions) && a.actions.length > 0 && a.actions.length <= 16
  );
  const ids = new Set(),
    ops = new Set();
  for (const x of a.actions) {
    exact(x, [
      "id",
      "operationKey",
      "scopeDigest",
      "wallet",
      "additionalSigner",
      "expiresAt",
      "maxFeeLamports",
      "maxRentLamports",
    ]);
    check(
      typeof x.id === "string" &&
        /^[A-Za-z0-9_-]{1,80}$/.test(x.id) &&
        typeof x.operationKey === "string" &&
        x.operationKey.length > 0 &&
        x.operationKey.length <= 256 &&
        /^[a-f0-9]{64}$/.test(x.scopeDigest)
    );
    key(x.wallet);
    if (x.additionalSigner !== null) {
      key(x.additionalSigner);
      check(x.additionalSigner !== x.wallet);
    }
    check(
      typeof x.expiresAt === "string" &&
        Number.isFinite(Date.parse(x.expiresAt)) &&
        new Date(x.expiresAt).toISOString() === x.expiresAt
    );
    bounded(x.maxFeeLamports);
    bounded(x.maxRentLamports);
    check(!ids.has(x.id) && !ops.has(x.operationKey));
    ids.add(x.id);
    ops.add(x.operationKey);
  }
  return structuredClone(a);
}
export interface ApprovedScope {
  operationKey: string;
  scopeDigest: string;
  wallet: string;
  additionalSigner: string | null;
  fee: number;
  rent: number;
}
export class ControlledActions {
  constructor(
    private readonly store: LifecycleStore,
    private readonly approvals: () => Promise<RehearsalApproval>,
    private readonly request: typeof fetch = fetch,
    private readonly now = () => Date.now()
  ) {}
  async configuration() {
    return parseApproval(await this.approvals());
  }
  async approval(scope: ApprovedScope): Promise<ActionApproval> {
    const a = (await this.configuration()).actions.find(
      (a) => a.operationKey === scope.operationKey
    );
    check(
      a &&
        a.scopeDigest === scope.scopeDigest &&
        a.wallet === scope.wallet &&
        a.additionalSigner === scope.additionalSigner
    );
    check(this.now() < Date.parse(a.expiresAt));
    bounded(scope.fee);
    bounded(scope.rent);
    check(scope.fee <= a.maxFeeLamports && scope.rent <= a.maxRentLamports);
    return Object.freeze(a);
  }
  async eligible(scope: ApprovedScope) {
    try {
      await this.approval(scope);
      return !this.store.applicationTransactions.getForOperation(
        scope.operationKey
      );
    } catch {
      return false;
    }
  }
  /** Reserve BEFORE the browser is allowed to ask Phantom. No replacement message or automatic retry. */
  async reserve(
    id: string,
    scope: ApprovedScope,
    message: Uint8Array,
    assertActive = () => {}
  ) {
    const a = await this.approval(scope);
    check(this.now()<Date.parse(a.expiresAt));assertActive();
    return this.store.applicationTransactions.reserve({
      id,
      operationKey: scope.operationKey,
      wallet: scope.wallet,
      approvalId: a.id,
      scopeDigest: scope.scopeDigest,
      messageDigest: messageDigest(message),
      context: "{}",
    });
  }
  async current(id: string, scope: ApprovedScope, message: Uint8Array) {
    const a = await this.approval(scope),
      record = this.store.applicationTransactions.get(id);
    check(
      record &&
        record.operationKey === scope.operationKey &&
        record.scopeDigest === scope.scopeDigest &&
        record.wallet === scope.wallet &&
        record.approvalId === a.id &&
        record.messageDigest === messageDigest(message),
      "attempt_unavailable"
    );
    return record;
  }
  async signed(
    id: string,
    scope: ApprovedScope,
    message: Uint8Array,
    signature: string
  ) {
    const record = await this.current(id, scope, message);
    if (record.state === "signing_reserved")
      return this.store.applicationTransactions.transition(
        id,
        record.revision,
        "signed",
        signature
      );
    check(
      record.state === "signed" && record.signature === signature,
      "attempt_consumed"
    );
    return record;
  }
  /** One RPC invocation. A timeout, error or wrong returned signature consumes the send reservation. */
  async send(
    id: string,
    scope: ApprovedScope,
    message: Uint8Array,
    wire: Uint8Array,
    signature: string,
    assertActive = () => {}
  ) {
    const record = await this.signed(id, scope, message, signature);
    check(!record.sendReserved, "attempt_consumed");
    const approval=await this.approval(scope);check(approval.id===record.approvalId,"approval_replaced");check(this.now()<Date.parse(approval.expiresAt));assertActive();
    this.store.applicationTransactions.transition(
      id,
      record.revision,
      "send_reserved"
    );
    const finish=(accepted:boolean)=>{
      const latest=this.store.applicationTransactions.get(id);
      check(latest&&latest.signature===signature&&latest.sendReserved&&latest.approvalId===record.approvalId,"transaction_substitution");
      if(latest.state==="send_reserved")this.store.applicationTransactions.transition(id,latest.revision,accepted?"submitted":"unknown");
      else check(["submitted","unknown","confirmed","failed"].includes(latest.state),"attempt_consumed");
      const state=latest.state==="confirmed"||latest.state==="failed"||latest.state==="submitted"||latest.state==="send_reserved"&&accepted?"submitted" as const:"unknown" as const;
      return {kind:"wallet_execution_submission" as const,state,signature,retryAuthorized:false as const};
    };
    let accepted=false;
    try {
      const response = await this.request(SETTLEMENT_DEVNET_RPC, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "controlled-send",
          method: "sendTransaction",
          params: [
            Buffer.from(wire).toString("base64"),
            {
              encoding: "base64",
              skipPreflight: false,
              preflightCommitment: "confirmed",
              maxRetries: 0,
            },
          ],
        }),
      });
      check(response.ok, "submission_uncertain");
      const result: any = await jsonResponse(response, 8192);
      check(
        result?.jsonrpc === "2.0" &&
          result.id === "controlled-send" &&
          !Object.hasOwn(result, "error") &&
          result.result === signature,
        "submission_uncertain"
      );
      accepted=true;
    } catch { /* A transport error never releases the send fence. */ }
    return finish(accepted);
  }

  lookup(operationKey:string,wallet:string){check(typeof operationKey==="string"&&operationKey.length>0&&operationKey.length<=256);const record=this.store.applicationTransactions.getForOperation(operationKey);check(record&&record.wallet===wallet,"attempt_unavailable");return record;}
  recordConfirmation(
    id: string,
    signature: string,
    state: "confirmed" | "failed" | "unknown"
  ) {
    const record = this.store.applicationTransactions.get(id);
    check(record,"attempt_unavailable");
    check(
      record.signature === signature && record.sendReserved,
      "transaction_substitution"
    );
    if (record.state === state) return state;
    if((record.state==="confirmed"||record.state==="failed")&&state==="unknown")return record.state;
    check(
      record.state !== "confirmed" && record.state !== "failed",
      "attempt_consumed"
    );
    return this.store.applicationTransactions.transition(
      id,
      record.revision,
      state,
      signature
    ).state as "confirmed"|"failed"|"unknown";
  }
}
