import { PublicKey } from "@solana/web3.js";
import type { LifecycleStore, JobBindings } from "../src/index.js";
import { INTENT_FORMAT } from "../src/index.js";
import { bindings } from "./job-helpers.js";
export function ready(store: Pick<LifecycleStore, "jobs">, b: JobBindings = bindings(), worker = "worker") {
  const j = store.jobs.createOrGetJob("job_" + b.milestone, b);
  const c = store.jobs.claimJob(j.jobId, j.identity, j.revision, worker);
  let job = store.jobs.transitionJob(c.claim, c.job.revision, "verification_running");
  job = store.jobs.transitionJob(c.claim, job.revision, "verification_completed");
  job = store.jobs.transitionJob(c.claim, job.revision, "authorization_pending");
  return { job, claim: c.claim };
}
export const metadata = () => ({ messageDigest: "ab".repeat(32), format: INTENT_FORMAT,
  blockhash: new PublicKey(Buffer.alloc(32, 177)).toBase58(),
  lastValidBlockHeight: "200", observedBlockHeight: "100" });
