import { PublicKey } from "@solana/web3.js";
import { LifecycleStore } from "@proofwork/lifecycle";
import { DurableOfflineCoordinator } from "../src/durable-offline-coordinator.js";
import { DevnetAttestationReader } from "../src/attestation-chain.js";
import { VerifierService } from "../src/service.js";
import { GitHub } from "../src/github.js";
import { CASES } from "../src/manifest.js";
import { fixture, githubFetch, TOKEN } from "./helpers.js";
const [path, mode] = process.argv.slice(2) as [string, string];
const f = fixture(), store = new LifecycleStore(path);
const chain = new DevnetAttestationReader("https://api.devnet.solana.com", f.verifier.toBase58(), f.rpc);
const service = new VerifierService(new GitHub(githubFetch()), chain,
  { run: async () => CASES.map(c => ({ id: c.id, passed: true })) });
const hold = async () => {
  process.send!({ ready: true });
  await new Promise<void>(() => { process.on("message", () => {}); });
};
const coordinator = new DurableOfflineCoordinator(store, service, chain,
  { verifier: f.verifier.toBase58(), feePayer: new PublicKey(f.i.subarray(8, 40)).toBase58(),
    maxAgeMs: 5000, minRemainingBlockHeights: 10 }, "child_worker", { read: async () => {
      if (mode === "before-intent") await hold();
      return { rpc: "https://api.devnet.solana.com", genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
        blockhash: new PublicKey(Buffer.alloc(32, 177)).toBase58(), lastValidBlockHeight: 200,
        currentBlockHeight: 100, observedAtMs: 0, valid: true };
    } }, () => 0, { mode: "offline-mock", gate: mode === "during-intent" ? { wait: hold } : undefined });
await coordinator.coordinate("child_request", f.request, TOKEN);
await hold(); // Recorded receipt committed; simulate lost acknowledgment by killing this process.
