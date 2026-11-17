import type { WalletApplicationHttp } from "./wallet-application-http.js";
import { applicationHealth, applicationReply, applicationRequestId } from "./application-api-contracts.js";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { GitHub } from "./github.js";
import { DevnetReader } from "./chain.js";
import { DockerRunner } from "./runner.js";
import { VerifierService } from "./service.js";

export function createVerifierServer(service: Pick<VerifierService, "verify">, application?: WalletApplicationHttp) {
const server = createServer(async (request, response) => {
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (application && await application.handle(request, response)) return;
  // Default composition registers only public health; no wallet adapter is activated by the CLI.
  if (request.url?.startsWith("/api/")) {
    const reply = request.url !== "/api/v1/health"
      ? applicationReply(applicationRequestId(), "unknown", null, 404, null, "none", "route_not_registered")
      : request.headers.origin ? applicationReply(applicationRequestId(), "health", null, 400, null, "none", "invalid_request")
      : request.method !== "GET" ? applicationReply(applicationRequestId(), "health", null, 405, null, "none", "method_not_allowed")
      : applicationHealth();
    if (reply.statusCode === 405) response.setHeader("allow", "GET");
    response.writeHead(reply.statusCode).end(JSON.stringify(reply.body)); return;
  }
  if (request.method !== "POST" || request.url !== "/verify" || request.headers.origin
      || request.headers["content-type"] !== "application/json") {
    response.writeHead(400).end('{"error":"invalid_request"}'); return;
  }
  const auth = request.headers.authorization;
  if (!auth?.startsWith("Bearer ") || auth.length > 1031) {
    response.writeHead(401).end('{"error":"github_user_authentication_required"}'); return;
  }
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > 32_768) { response.writeHead(413).end('{"error":"request_too_large"}'); return; }
      chunks.push(Buffer.from(chunk));
    }
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const result = await service.verify(input, auth.slice(7));
    response.writeHead(200).end(JSON.stringify(result));
  } catch { response.writeHead(400).end('{"error":"invalid_request"}'); }
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const service = new VerifierService(new GitHub(),
    new DevnetReader(process.env.SOLANA_RPC_URL, process.env.VERIFIER_PUBLIC_KEY),
    new DockerRunner(process.env.TRUSTED_RUNNER_IMAGE));
  const port = Number(process.env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("invalid_port");
  createVerifierServer(service).listen(port, "127.0.0.1");
}
