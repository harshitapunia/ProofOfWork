import {ControlledAttestation} from "./controlled-attestation.js";
import {DevnetAttestationReader} from "./attestation-chain.js";
import {ControlledActions,approvalFile} from "./controlled-actions.js";
import {WorkflowVerification,admittedContributor} from "./workflow-verification.js";
import { WorkflowStateReader } from "./workflow-state.js";
import { WalletExecutionReviewer } from "./devnet-wallet-review.js";
/** Deliberate loopback-only application CLI. The legacy verifier CLI remains unchanged. */
import { readFile, lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { LifecycleStore, DevnetLifecycleReader } from "@proofwork/lifecycle";
import { createApplicationServer, applicationOrigin } from "./application.js";
import { WalletSessions } from "./wallet-sessions.js";
import { VerifierService } from "./service.js";
import { GitHub } from "./github.js";
import { DevnetReader } from "./chain.js";
import { DockerRunner } from "./runner.js";

/** Close only after accepted background work has recorded completion or recovery. */
export async function closeApplicationStore(store:Pick<LifecycleStore,"close">,verification?:Pick<WorkflowVerification,"drain">):Promise<void>{
  try{await verification?.drain();}finally{store.close();}
}
export async function startApplication(env: NodeJS.ProcessEnv = process.env) {
  const admission=admittedContributor(env);
  if(admission&&!env.APP_DEVNET_APPROVAL_FILE)throw new Error("live_verifier_dispatch_disabled");
  const required = (name: string) => { const value = env[name]; if (!value) throw new Error("application_configuration_required"); return value; };
  const origin = applicationOrigin(required("APP_ORIGIN"));
  const certFile = required("APP_TLS_CERT_FILE"), keyFile = required("APP_TLS_KEY_FILE"), db = required("APP_LIFECYCLE_DB");
  if (![certFile, keyFile, db].every(isAbsolute)) throw new Error("absolute_local_paths_required");
  const existing = await lstat(db);
  if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("existing_lifecycle_database_required");
  const chainMode = env.APP_CHAIN_READS ?? "off";
  if (!["off", "devnet"].includes(chainMode)) throw new Error("invalid_chain_mode");
  const [cert, key] = await Promise.all([readFile(certFile), readFile(keyFile)]);
  const store = new LifecycleStore(db);
  try {
    const sessions = new WalletSessions({ origin: origin.origin, domain: origin.host, cluster: "devnet" });
    const service = new VerifierService(new GitHub(), new DevnetReader(env.SOLANA_RPC_URL, env.VERIFIER_PUBLIC_KEY), new DockerRunner(env.TRUSTED_RUNNER_IMAGE));
    if(admission&&chainMode!=="devnet")throw new Error("verification_requires_devnet_reads");
    const workflowState=chainMode==="devnet"?new WorkflowStateReader():undefined;
    // The controlled verifier still needs a scoped operator approval and admitted contributor.
    // Composition alone does not authorize dispatch or signing.
    const actions=env.APP_DEVNET_APPROVAL_FILE?new ControlledActions(store,approvalFile(env.APP_DEVNET_APPROVAL_FILE)):undefined;
    const workflowVerification:WorkflowVerification|ControlledAttestation|undefined=admission&&actions&&workflowState?new ControlledAttestation(workflowState,store,service,new DevnetAttestationReader(env.SOLANA_RPC_URL,env.VERIFIER_PUBLIC_KEY),actions,admission):undefined;
    const server = await createApplicationServer({ cert, key }, {
      assetsDirectory: env.APP_WEB_DIST ?? fileURLToPath(new URL("../../../../apps/web/dist/", import.meta.url)), sessions, store, service,
      ...(chainMode === "devnet" ? { workflowState: workflowState!, ...(workflowVerification?{workflowVerification}:{}), walletReview: new WalletExecutionReviewer(undefined,undefined,undefined,actions), chain: { reader: new DevnetLifecycleReader("confirmed"), provenance: "unverified_devnet_rpc" as const } } : {}),
    });
    server.once("close", () => { void closeApplicationStore(store,workflowVerification).catch(()=>{console.error("application_shutdown_failed");process.exitCode=1;}); });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject); server.listen(Number(origin.port), "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    return { server, origin: origin.origin };
  } catch (error) { store.close(); throw error; }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startApplication().then(({ server, origin }) => {
    console.log("ProofOfWork local application (actions require separate operator approval): " + origin);
    const stop = () => { server.close(); server.closeIdleConnections(); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    server.on("error", () => { console.error("application_server_error"); stop(); process.exitCode = 1; });
  }).catch(() => {
    // Never print TLS material, environment values, upstream errors or database paths.
    console.error("application_start_failed: configure APP_ORIGIN, trusted TLS files, an existing lifecycle DB and built frontend. See docs/LOCAL_APPLICATION.md.");
    process.exitCode = 1;
  });
}
