import { DatabaseSync } from "node:sqlite";
import { writeSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { LifecycleStore, type TransactionIntents } from "@proofwork/lifecycle";
import { OfflineTransactionPreparer } from "../src/offline-intent-preparer.js";
import { DevnetAttestationReader } from "../src/attestation-chain.js";
import { fixture } from "./helpers.js";
const [path, mode] = process.argv.slice(2) as [string, string];
function freeze(): never {
  writeSync(4, "checkpoint\n");
  process.kill(process.pid, "SIGSTOP"); // Exact owned-child checkpoint; no timers can advance it.
  throw Error("crash_fixture_must_not_resume");
}
const store = new LifecycleStore(path), job = store.jobs.listRecoveryRequired().entries[0]!.job;
const claim = { jobId: job.jobId, identity: job.identity, workerId: job.workerId!, generation: job.generation };
const module = await import(new URL("../../../../services/lifecycle/dist/src/transaction-intents.js", import.meta.url).href);
const db = new DatabaseSync(path); db.exec("PRAGMA foreign_keys=ON; PRAGMA synchronous=EXTRA; PRAGMA trusted_schema=OFF");
let writes = 0;
const intents: TransactionIntents = module.createTransactionIntents((fn: (db: DatabaseSync) => unknown, write = true) => {
  db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
  if (write && ++writes === 2 && mode === "after-digest") freeze();
  const value = fn(db);
  if (write && writes === 2 && mode === "during-record") freeze();
  db.exec("COMMIT"); return value;
});
// Test-only fault instrumentation supplies the real factory/fencing implementation.
const wrapped = { jobs: store.jobs, transactionIntents: intents } as unknown as LifecycleStore;
const f = fixture(), reader = new DevnetAttestationReader("https://api.devnet.solana.com", f.verifier.toBase58(), f.rpc);
const preparer = new OfflineTransactionPreparer(wrapped, { read: async id => {
  if (mode === "during-preparation") freeze();
  return reader.read(id);
} }, { read: async () => ({ rpc: "https://api.devnet.solana.com", genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  blockhash: new PublicKey(Buffer.alloc(32, 177)).toBase58(), lastValidBlockHeight: 200,
  currentBlockHeight: 100, observedAtMs: 0, valid: true }) },
{ verifier: job.bindings.verifier, feePayer: job.bindings.sponsor, maxAgeMs: 5000, minRemainingBlockHeights: 10 }, () => 0);
await preparer.prepare({ claim, jobRevision: job.revision, requestId: "child_preparation" });
freeze();
