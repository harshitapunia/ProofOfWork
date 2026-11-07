import { key } from "./commitments.js";
import { jsonResponse, type Fetcher } from "./http.js";
import type { BlockhashObservation, TrustedBlockhashSource } from "./transaction-policy.js";

export const DEVNET_RPC = "https://api.devnet.solana.com";
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export class BlockhashSourceError extends Error {
  constructor(public readonly code: string) { super(code); }
}
/** Fails closed with a safe reason code rather than exposing response bodies or transport details. */
function check(ok: unknown, code = "invalid_rpc_response"): asserts ok {
  if (!ok) throw new BlockhashSourceError(code);
}
/** Requires a JSON object rather than coercing malformed scalar or array responses. */
function obj(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
/** JSON numbers must represent nonnegative integer slots/heights without precision loss. */
function integer(value: unknown): number {
  check(typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  return value;
}
interface Lease { blockhash: string; lastValidBlockHeight: number; slot: number; height: number }

/** Read-only Devnet source; retains a lease so policy consumption cannot silently substitute a new hash. */
export class DevnetBlockhashSource implements TrustedBlockhashSource {
  #lease: Lease | undefined;
  #pending: Promise<BlockhashObservation> | undefined;
  constructor(private readonly request: Fetcher = fetch,
    private readonly now: () => number = () => performance.now(), private readonly timeoutMs = 10_000) {
    check(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10_000, "invalid_timeout");
  }
  /** Coalesces concurrent reads, bounds the entire observation, and returns a caller-owned copy. */
  async read(): Promise<BlockhashObservation> {
    if (!this.#pending) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new BlockhashSourceError("rpc_timeout")); }, this.timeoutMs);
      });
      this.#pending = Promise.race([this.observe(controller.signal), deadline])
        .finally(() => { clearTimeout(timer); controller.abort(); this.#pending = undefined; });
    }
    return { ...await this.#pending };
  }
  /** Verifies cluster, validates the pinned hash and obtains a nonregressing height at its validated slot. */
  private async observe(signal: AbortSignal): Promise<BlockhashObservation> {
    const observedAtMs = this.now();
    check(Number.isFinite(observedAtMs) && observedAtMs >= 0, "invalid_clock");
    check(await this.rpc("getGenesisHash", [], signal) === DEVNET_GENESIS, "wrong_cluster");
    let lease = this.#lease;
    if (!lease) {
      const latest = obj(await this.rpc("getLatestBlockhash", [{ commitment: "confirmed" }], signal));
      const slot = integer(obj(latest.context).slot), value = obj(latest.value);
      check(typeof value.blockhash === "string", "invalid_blockhash");
      try { key(value.blockhash); } catch { throw new BlockhashSourceError("invalid_blockhash"); }
      lease = { blockhash: value.blockhash, lastValidBlockHeight: integer(value.lastValidBlockHeight), slot, height: 0 };
    }
    const valid = obj(await this.rpc("isBlockhashValid", [lease.blockhash,
      { commitment: "confirmed", minContextSlot: lease.slot }], signal));
    const slot = integer(obj(valid.context).slot);
    check(slot >= lease.slot, "inconsistent_rpc_response");
    check(typeof valid.value === "boolean");
    if (!valid.value) { this.#lease = undefined; throw new BlockhashSourceError("expired_blockhash"); }
    const currentBlockHeight = integer(await this.rpc("getBlockHeight",
      [{ commitment: "confirmed", minContextSlot: slot }], signal));
    check(currentBlockHeight >= lease.height, "inconsistent_rpc_response");
    if (currentBlockHeight >= lease.lastValidBlockHeight) {
      this.#lease = undefined; throw new BlockhashSourceError("expired_blockhash");
    }
    const elapsed = this.now() - observedAtMs;
    check(Number.isFinite(elapsed) && elapsed >= 0, "invalid_clock");
    check(!signal.aborted && elapsed < this.timeoutMs, "rpc_timeout");
    this.#lease = { ...lease, slot, height: currentBlockHeight };
    return { rpc: DEVNET_RPC, genesisHash: DEVNET_GENESIS, blockhash: lease.blockhash,
      lastValidBlockHeight: lease.lastValidBlockHeight, currentBlockHeight, observedAtMs, valid: true };
  }
  /** Sends only fixed read methods; requires matching JSON-RPC IDs, bounded bodies and no redirects. */
  private async rpc(method: string, params: unknown[], signal: AbortSignal): Promise<unknown> {
    try {
      check(!signal.aborted, "rpc_timeout");
      const response = await this.request(DEVNET_RPC, { method: "POST", redirect: "error", signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }) });
      check(!signal.aborted, "rpc_timeout");
      if (!response.ok) {
        await response.body?.cancel();
        throw new BlockhashSourceError("rpc_failure");
      }
      let data: Record<string, unknown>;
      try { data = obj(await jsonResponse(response, 16_384)); }
      catch { throw new BlockhashSourceError(signal.aborted ? "rpc_timeout" : "invalid_rpc_response"); }
      check(!signal.aborted, "rpc_timeout");
      check(data.jsonrpc === "2.0" && data.id === method && !("error" in data) && "result" in data);
      return data.result;
    } catch (error) {
      if (signal.aborted) throw new BlockhashSourceError("rpc_timeout");
      if (error instanceof BlockhashSourceError) throw error;
      throw new BlockhashSourceError("rpc_failure");
    }
  }
}
