/** Owned child fixture: ephemeral test keys are generated only in memory, then lost on kill. */
import { writeSync } from "node:fs";
import { LifecycleStore } from "@proofwork/lifecycle";
import { DurableOfflineCoordinator } from "../src/durable-offline-coordinator.js";
import { signingFixture } from "./signing-helpers.js";
import { TOKEN } from "./helpers.js";
const [path, phase] = process.argv.slice(2) as [string, string];
const f = await signingFixture();
function freeze(): never {
  writeSync(4, JSON.stringify({ verifier: f.config.verifier, feePayer: f.config.feePayer,
    verifierSignatures: f.verifier.signatures.length, payerSignatures: f.payer.signatures.length }) + "\n");
  process.kill(process.pid, "SIGSTOP");
  throw Error("owned_child_must_not_resume");
}
if (phase === "before-signing") f.verifier.before(async () => { freeze(); });
if (phase === "during-signing") f.verifier.after(async () => { freeze(); });
if (phase === "after-signatures") f.payer.after(async () => { freeze(); });
const store = new LifecycleStore(path);
const coordinator = new DurableOfflineCoordinator(store, f.service, f.chain, f.config, "child_worker",
  f.source, f.now, { mode: "offline-mock" }, f.simulator());
await coordinator.coordinate("child_request", f.request, TOKEN);
freeze();
