import { applicationReply, applicationRequestId } from "./application-api-contracts.js";
/** Explicit local HTTPS composition. No default CLI activation, proxy or transaction capability. */
import { readFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { createServer, type ServerOptions } from "node:https";
import type { RequestListener } from "node:http";
import { LifecycleStore } from "@proofwork/lifecycle";
import { createVerifierHandler } from "./server.js";
import { WalletSessions } from "./wallet-sessions.js";
import { WalletApplicationHttp } from "./wallet-application-http.js";
import type { ApplicationChainSource } from "./application-queries.js";
import type { VerifierService } from "./service.js";

export interface ApplicationOptions {
  readonly assetsDirectory: string;
  readonly sessions: WalletSessions;
  readonly store: LifecycleStore;
  readonly service: Pick<VerifierService, "verify">;
  readonly chain?: ApplicationChainSource;
}
export function applicationOrigin(value: string): URL {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.origin !== value || !["localhost", "127.0.0.1"].includes(u.hostname)
    || !Number.isInteger(Number(u.port)) || Number(u.port) < 1024 || Number(u.port) > 65535)
    throw new Error("invalid_application_origin");
  return u;
}
/** Loads only four known production assets; never serves arbitrary files, config or test artifacts. */
export async function createApplicationHandler(options: ApplicationOptions): Promise<RequestListener> {
  const { sessions, store, service, chain } = options;
  applicationOrigin(sessions.origin);
  if (!isAbsolute(options.assetsDirectory)) throw new Error("invalid_asset_directory");
  const files = [
    ["/", "index.html", "text/html; charset=utf-8"],
    ["/assets/app.js", "assets/app.js", "text/javascript; charset=utf-8"],
    ["/assets/app.css", "assets/app.css", "text/css; charset=utf-8"],
    ["/mark.svg", "mark.svg", "image/svg+xml"],
  ] as const;
  const assets = new Map<string, { bytes: Buffer; type: string }>();
  for (const [url, file, type] of files) assets.set(url, { bytes: await readFile(resolve(options.assetsDirectory, file)), type });
  assets.set("/index.html", assets.get("/")!);
  const api = createVerifierHandler(service, new WalletApplicationHttp(sessions, { store, timeoutMs: 5000, ...(chain ? { chain } : {}) }));
  return (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const duplicates = (name: string) => request.rawHeaders.filter((_, i) => i % 2 === 0 && request.rawHeaders[i]!.toLowerCase() === name).length > 1;
    if (request.headers.host !== sessions.domain || ["host", "origin", "cookie", "authorization"].some(duplicates)
      || (request.headers.origin !== undefined && request.headers.origin !== sessions.origin)
      || request.headers.forwarded || request.headers["x-forwarded-host"] || request.headers["x-forwarded-proto"]) {
      response.setHeader("connection", "close"); response.once("finish", () => request.destroy());
      response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify(applicationReply(applicationRequestId(), "unknown", null, 400, null, "none", "invalid_request").body)); return;
    }
    const path = request.url ?? "";
    if (path.startsWith("/api/") || path === "/verify") {
      // Same real handler as the existing HTTP server; no loopback proxy, bypass or second listener.
      void Promise.resolve(api(request, response)).catch(() => {
        if (!response.headersSent) response.writeHead(503, { "content-type": "application/json" }).end('{"error":"application_unavailable"}');
        else response.destroy();
      });
      return;
    }
    const asset = assets.get(path);
    if (!asset) { response.writeHead(404, { "content-type": "text/plain" }).end("Not found"); return; }
    if (request.method !== "GET" && request.method !== "HEAD") { response.setHeader("allow", "GET, HEAD"); response.setHeader("connection", "close"); response.once("finish", () => request.destroy()); response.writeHead(405).end(); return; }
    response.writeHead(200, { "content-type": asset.type, "content-length": asset.bytes.length });
    response.end(request.method === "HEAD" ? undefined : asset.bytes);
  };
}
export async function createApplicationServer(tls: Pick<ServerOptions, "key" | "cert">, options: ApplicationOptions) {
  if (!tls.key || !tls.cert) throw new Error("tls_files_required");
  const server = createServer({ key: tls.key, cert: tls.cert, minVersion: "TLSv1.2" }, await createApplicationHandler(options));
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  return server;
}
