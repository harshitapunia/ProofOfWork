import { DEVNET_RPC } from "./devnet-blockhash.js";
import { ExecutionError, type ExecutionTransport } from "./devnet-execution.js";
import { jsonResponse, type Fetcher } from "./http.js";

/** Read-only preparation adapter. Submission is hard-disabled until separately reviewed and approved. */
export class DisabledDevnetExecutionRpc implements ExecutionTransport {
  readonly mode = "disabled" as const;
  readonly rpc = DEVNET_RPC;
  constructor(private readonly request: Fetcher = fetch) {}
  private object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ExecutionError("rpc_failure");
    return value as Record<string, unknown>;
  }
  async #call(method: "getGenesisHash" | "getFeeForMessage" | "isBlockhashValid" | "getSignatureStatuses", params: unknown[]): Promise<unknown> {
    if (!["getGenesisHash", "getFeeForMessage", "isBlockhashValid", "getSignatureStatuses"].includes(method))
      throw new ExecutionError("rpc_failure");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([(async () => {
        const response = await this.request(DEVNET_RPC, { method: "POST", redirect: "error", signal: controller.signal,
          headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }) });
        if (!response.ok) { await response.body?.cancel(); throw new ExecutionError("rpc_failure"); }
        const body = this.object(await jsonResponse(response, 16_384));
        if (!body || body.jsonrpc !== "2.0" || body.id !== method || "error" in body || !("result" in body))
          throw new ExecutionError("rpc_failure");
        return body.result;
      })(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new ExecutionError("rpc_failure")); }, 10_000);
      })]);
    } catch { throw new ExecutionError("rpc_failure"); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  async genesis(): Promise<string> {
    const result = await this.#call("getGenesisHash", []);
    if (typeof result !== "string") throw new ExecutionError("rpc_failure");
    return result;
  }
  async fee(message: Uint8Array): Promise<number | null> {
    const result = this.object(await this.#call("getFeeForMessage", [Buffer.from(message).toString("base64"), { commitment: "confirmed" }]));
    if (!Number.isSafeInteger(this.object(result.context).slot) || Number(this.object(result.context).slot) < 0
      || !(result.value === null || (Number.isSafeInteger(result.value) && Number(result.value) >= 0))) throw new ExecutionError("rpc_failure");
    return result.value as number | null;
  }
  async valid(blockhash: string): Promise<boolean> {
    const result = this.object(await this.#call("isBlockhashValid", [blockhash, { commitment: "confirmed" }]));
    if (!Number.isSafeInteger(this.object(result.context).slot) || Number(this.object(result.context).slot) < 0 || typeof result.value !== "boolean") throw new ExecutionError("rpc_failure");
    return result.value;
  }
  async submit(_wire: Uint8Array): Promise<string> {
    // Future approval must retain preflight, confirmed commitment and maxRetries: 0; never auto-resign.
    throw new ExecutionError("live_execution_disabled");
  }
  async status(signature: string): Promise<"confirmed" | "failed" | "unknown"> {
    const result = this.object(await this.#call("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]));
    if (!Number.isSafeInteger(this.object(result.context).slot) || Number(this.object(result.context).slot) < 0
      || !Array.isArray(result.value) || result.value.length !== 1) throw new ExecutionError("rpc_failure");
    const status = result.value[0];
    if (status === null) return "unknown";
    const value = this.object(status);
    if (!("err" in value) || !Number.isSafeInteger(value.slot) || Number(value.slot) < 0
      || Number(value.slot) > Number(this.object(result.context).slot)
      || !(value.confirmations === null || (Number.isSafeInteger(value.confirmations) && Number(value.confirmations) >= 0))
      || !["processed", "confirmed", "finalized"].includes(String(value.confirmationStatus))) throw new ExecutionError("rpc_failure");
    if (value.err !== null) return "failed";
    return value.confirmationStatus === "confirmed" || value.confirmationStatus === "finalized" ? "confirmed" : "unknown";
  }
}
