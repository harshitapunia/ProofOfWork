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

export async function startApplication(env: NodeJS.ProcessEnv = process.env) {
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
    const server = await createApplicationServer({ cert, key }, {
      assetsDirectory: env.APP_WEB_DIST ?? fileURLToPath(new URL("../../../../apps/web/dist/", import.meta.url)), sessions, store, service,
      ...(chainMode === "devnet" ? { walletReview: new WalletExecutionReviewer(), chain: { reader: new DevnetLifecycleReader("confirmed"), provenance: "unverified_devnet_rpc" as const } } : {}),
    });
    server.once("close", () => store.close());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject); server.listen(Number(origin.port), "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    return { server, origin: origin.origin };
  } catch (error) { store.close(); throw error; }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startApplication().then(({ server, origin }) => {
    console.log("ProofOfWork local read-only application: " + origin);
    const stop = () => { server.close(); server.closeIdleConnections(); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    server.on("error", () => { console.error("application_server_error"); stop(); process.exitCode = 1; });
  }).catch(() => {
    // Never print TLS material, environment values, upstream errors or database paths.
    console.error("application_start_failed: configure APP_ORIGIN, trusted TLS files, an existing lifecycle DB and built frontend. See docs/LOCAL_APPLICATION.md.");
    process.exitCode = 1;
  });
}
