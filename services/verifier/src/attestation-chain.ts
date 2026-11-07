import { PublicKey } from "@solana/web3.js";
import { decodeState, type ChainState, type StateReader } from "./chain.js";
import { PROGRAM_ID, key } from "./commitments.js";
import { object, requireValue, VerificationError } from "./errors.js";
import { jsonResponse, type Fetcher } from "./http.js";

export interface AttestationState extends ChainState {
  internship: string; sponsor: string; internshipId: string; milestoneId: string;
}
export interface AttestationStateReader extends StateReader {
  read(milestone: string): Promise<AttestationState>;
}

/** Additive reader: existing ChainState/API stays unchanged; decodeState remains authoritative. */
export class DevnetAttestationReader implements AttestationStateReader {
  constructor(private readonly rpc: string | undefined, private readonly verifier: string | undefined,
    private readonly request: Fetcher = fetch) {}
  async read(address: string): Promise<AttestationState> {
    requireValue(this.rpc && this.verifier, "missing_onchain_state");
    requireValue(this.rpc === "https://api.devnet.solana.com", "invalid_onchain_state");
    try {
      const milestone = key(address);
      // Obtain the parent from a bounded read, then validate all three accounts together.
      const first = await this.accounts([address]);
      const initial = this.data(first[0], 276);
      const parent = new PublicKey(initial.subarray(8, 40)).toBase58();
      const [submission] = PublicKey.findProgramAddressSync([Buffer.from("submission"), milestone.toBuffer()], PROGRAM_ID);
      const all = await this.accounts([address, submission.toBase58(), parent]);
      const state = decodeState(address, all[0], all[1], all[2], this.verifier);
      const m = this.data(all[0], 276), i = this.data(all[2], 49);
      // The RPC-requested parent must be the parent actually validated in the final batch.
      requireValue(new PublicKey(m.subarray(8, 40)).toBase58() === parent, "invalid_onchain_state");
      return { ...state, internship: parent, sponsor: new PublicKey(i.subarray(8, 40)).toBase58(),
        internshipId: i.readBigUInt64LE(40).toString(), milestoneId: m.readBigUInt64LE(232).toString() };
    } catch (error) {
      if (error instanceof VerificationError) throw error;
      throw new VerificationError("invalid_onchain_state");
    }
  }
  private data(value: unknown, size: number): Buffer {
    requireValue(value !== null && value !== undefined, "missing_onchain_state");
    const a = object(value);
    requireValue(Array.isArray(a.data) && a.data[1] === "base64" && typeof a.data[0] === "string", "invalid_onchain_state");
    const data = Buffer.from(a.data[0], "base64");
    requireValue(data.length === size && data.toString("base64") === a.data[0], "invalid_onchain_state");
    return data;
  }
  private async accounts(addresses: string[]): Promise<unknown[]> {
    const response = await this.request(this.rpc!, { method: "POST", redirect: "error",
      headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts",
        params: [addresses, { encoding: "base64", commitment: "confirmed" }] }) });
    requireValue(response.ok, "missing_onchain_state");
    const json = object(await jsonResponse(response, 16_384));
    const result = json.result ? object(json.result) : undefined;
    requireValue(!json.error && Array.isArray(result?.value) && result.value.length === addresses.length, "invalid_onchain_state");
    return result.value;
  }
}
