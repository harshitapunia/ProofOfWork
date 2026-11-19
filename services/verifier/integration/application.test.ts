/** Actual HTTPS + existing handlers/store/decoders. Keys are disposable RAM-only test keys. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { request } from "node:https";
import { createServer as tcpServer } from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { DevnetLifecycleReader } from "@proofwork/lifecycle";
import { SETTLEMENT_DEVNET_GENESIS } from "@proofwork/finance-client";
import { createApplicationServer, applicationOrigin } from "../src/application.js";
import { startApplication } from "../src/application-main.js";
import { WalletSessions, SESSION_LIFETIME_MS } from "../src/wallet-sessions.js";
import { APPLICATION_API_VERSION } from "../src/application-api-contracts.js";
import { walletLedgerFixture } from "../test/wallet-ledger-helpers.js";

const assetsDirectory = fileURLToPath(new URL("../../../../apps/web/dist/", import.meta.url));
const envelope = { apiVersion: APPLICATION_API_VERSION, cluster: "devnet" };
function pair() {
  const keys = generateKeyPairSync("ed25519");
  return { ...keys, wallet: new PublicKey(keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toBase58() };
}
async function certificate() {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = Buffer.from(keys.privateKey.export({ format: "pem", type: "pkcs8" }));
  // Extra anonymous pipe: no private material in argv, environment, logs or files.
  const child = spawn("bash", ["-o", "pipefail", "-c", "cat | openssl req -new -x509 -key /dev/stdin -subj /CN=localhost -days 1 -addext subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: ["pipe", "pipe", "pipe"] });
  const output: Buffer[] = []; child.stdout.on("data", b => output.push(Buffer.from(b))); child.stderr.resume();
  (child.stdin as Writable).end(key);
  const [code] = await once(child, "close"); assert.equal(code, 0, "OpenSSL must create the disposable test certificate");
  return { key, cert: Buffer.concat(output) };
}
let tlsPromise: ReturnType<typeof certificate> | undefined;
async function freePort() {
  const s = tcpServer(); s.listen(0, "127.0.0.1"); await once(s, "listening");
  const port = (s.address() as import("node:net").AddressInfo).port;
  await new Promise<void>(resolve => s.close(() => resolve())); return port;
}
async function fixture(t: TestContext, mode: "fixture" | "disabled" | "missing" = "fixture") {
  const tls = await (tlsPromise ??= certificate()), sponsor = pair(), student = pair(), other = pair();
  const dir = mkdtempSync(join(tmpdir(), "proofwork-https-"));
  const ledger = walletLedgerFixture(dir, sponsor.wallet, student.wallet, other.wallet);
  let now = Date.now(), legacyCalls = 0;
  const calls: string[] = [];
  const chain = { provenance: "offline_fixture" as const, reader: new DevnetLifecycleReader("finalized", async (_url, init) => {
    const m = JSON.parse(init!.body as string); calls.push(m.method); assert(["getGenesisHash", "getMultipleAccounts"].includes(m.method));
    return Response.json({ jsonrpc: "2.0", id: 1, result: m.method === "getGenesisHash" ? SETTLEMENT_DEVNET_GENESIS
      : { context: { slot: 200 }, value: m.params[0].map((a: string) => mode === "missing" ? null : ledger.accounts.get(a) ?? null) } });
  }) };
  // Retry only a test-port allocation collision; no fixed operational address/port is invented.
  let server!: Awaited<ReturnType<typeof createApplicationServer>>, sessions!: WalletSessions, origin = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    origin = "https://localhost:" + await freePort(); sessions = new WalletSessions({ origin, domain: new URL(origin).host, cluster: "devnet" }, () => now);
    server = await createApplicationServer(tls, { assetsDirectory, sessions, store: ledger.s,
      service: { verify: async () => { legacyCalls++; return { legacy: true } as any; } }, ...(mode === "disabled" ? {} : { chain }) });
    try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(Number(new URL(origin).port), "127.0.0.1", () => { server.off("error", reject); resolve(); }); }); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt === 2) { ledger.s.close(); throw error; } }
  }
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); ledger.s.close(); rmSync(dir, { recursive: true, force: true }); });
  const cookies = new Map<string, string>();
  async function send(path: string, input?: unknown, extra: { headers?: Record<string, string>; noOrigin?: boolean; trust?: boolean; method?: string } = {}) {
    const body = input === undefined ? undefined : JSON.stringify(input);
    return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; bytes: Buffer; body: any }>((resolve, reject) => {
      const req = request(new URL(path, origin), { family: 4, servername: "localhost", agent: false, ...(extra.trust === false ? {} : { ca: tls.cert }),
        method: extra.method ?? (body === undefined ? "GET" : "POST"), headers: {
          ...(body === undefined ? {} : { ...(extra.noOrigin ? {} : { origin }), "content-type": "application/json" }),
          ...(cookies.size ? { cookie: [...cookies].map(([k, v]) => k + "=" + v).join("; ") } : {}), ...extra.headers,
        } }, res => {
        const chunks: Buffer[] = []; res.on("data", b => chunks.push(Buffer.from(b))); res.on("error", reject);
        res.on("end", () => {
          for (const cookie of res.headers["set-cookie"] ?? []) {
            assert(cookie.includes("Secure") && cookie.includes("HttpOnly") && cookie.includes("SameSite=Strict") && cookie.includes("Path=/"));
            assert(!cookie.includes("Domain=")); const [part] = cookie.split(";"), at = part!.indexOf("="), name = part!.slice(0, at), value = part!.slice(at + 1);
            if (cookie.includes("Max-Age=0")) cookies.delete(name); else cookies.set(name, value);
          }
          const bytes = Buffer.concat(chunks); const json = String(res.headers["content-type"]).includes("application/json");
          resolve({ status: res.statusCode!, headers: res.headers, bytes, body: json && bytes.length ? JSON.parse(bytes.toString()) : null });
        });
      }); req.on("error", reject); if (body !== undefined) req.write(body); req.end();
    });
  }
  async function login(identity = sponsor) {
    const c = await send("/api/v1/auth/challenge", { ...envelope, wallet: identity.wallet }); assert.equal(c.status, 200);
    const view = c.body.data;
    const proof = { ...envelope, challengeId: view.challengeId, messageBase64: Buffer.from(view.message).toString("base64"), signatureBase64: sign(null, Buffer.from(view.message), identity.privateKey).toString("base64") };
    const verified = await send("/api/v1/auth/verify", proof); assert.equal(verified.status, 200); return { verified, proof };
  }
  return { ...ledger, tls, sponsor, student, other, sessions, origin, server, send, login, cookies, calls, legacyCalls: () => legacyCalls, advance: (ms: number) => { now += ms; } };
}

test("actual HTTPS serves the checked frontend assets and public limited health", async t => {
  const f = await fixture(t);
  for (const [path, file, type] of [["/", "index.html", "text/html"], ["/assets/app.js", "assets/app.js", "text/javascript"], ["/assets/app.css", "assets/app.css", "text/css"], ["/mark.svg", "mark.svg", "image/svg+xml"]]) {
    const r = await f.send(path!); assert.equal(r.status, 200); assert(r.headers["content-type"]!.startsWith(type!));
    assert.deepEqual(r.bytes, readFileSync(join(assetsDirectory, file!))); assert.equal(r.headers["cache-control"], "no-store"); assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert(String(r.headers["content-security-policy"]).includes("frame-ancestors 'none'")); assert(!r.headers["access-control-allow-origin"]);
  }
  const health = await f.send("/api/v1/health"); assert.equal(health.status, 200); assert.equal(health.body.data.authentication, "wallet_signature_single_instance");
  assert.equal(health.body.data.readiness, "limited"); assert.equal(health.body.data.execution, "disabled"); assert.equal(f.legacyCalls(), 0); assert.deepEqual(f.calls, []);
});
test("TLS trust is required rather than disabled by the test client", async t => {
  const f = await fixture(t); await assert.rejects(f.send("/", undefined, { trust: false }), /certificate|self.signed/i);
  assert.equal((await f.send("/")).status, 200);
});
test("real Ed25519 proof over exact server bytes establishes secure-cookie session and all authorized reads", async t => {
  const f = await fixture(t), before = f.base.snapshot(); const login = await f.login();
  assert.equal(login.verified.body.data.wallet, f.sponsor.wallet); assert.equal(login.verified.body.data.origin, f.origin);
  assert(!JSON.stringify(login.verified.body).includes(f.cookies.get("__Host-proofwork_session")!));
  for (const suffix of ["", "/milestone", "/execution"]) {
    const r = await f.send("/api/v1/jobs/" + f.job.jobId + suffix); assert.equal(r.status, 200);
    assert.equal(r.body.provenance, suffix === "/milestone" ? "offline_fixture" : "lifecycle_v5_offline");
    assert.equal(r.body.permissions.signingAuthorization, "not_granted"); assert.equal(r.body.permissions.submissionAuthorized, false);
    if (suffix) assert.equal(r.body.data.rewardPayment, "not_established");
  }
  assert.deepEqual(f.base.snapshot(), before); assert.equal((await f.send("/api/v1/auth/verify", login.proof)).status, 401);
});
test("recorded student can authenticate and read the actual stored job", async t => {
  const f = await fixture(t); await f.login(f.student); assert.equal((await f.send("/api/v1/jobs/" + f.job.jobId)).status, 200);
});
test("unrelated wallet is authenticated but denied all private records without an existence oracle", async t => {
  const f = await fixture(t); await f.login(f.other);
  for (const suffix of ["", "/milestone", "/execution"]) {
    const denied = await f.send("/api/v1/jobs/" + f.job.jobId + suffix), unknown = await f.send("/api/v1/jobs/00000000-0000-0000-0000-000000000000" + suffix);
    assert.equal(denied.status, 404); assert.deepEqual(denied.body.error, unknown.body.error); assert.equal(denied.body.data, null);
  }
  assert.deepEqual(f.calls, []);
});
test("missing session, expiry and real logout revoke access on the same HTTPS server", async t => {
  const f = await fixture(t), path = "/api/v1/jobs/" + f.job.jobId;
  assert.equal((await f.send(path)).status, 401); await f.login(); f.advance(SESSION_LIFETIME_MS);
  assert.equal((await f.send(path)).status, 401); await f.login();
  const out = await f.send("/api/v1/auth/logout", envelope); assert.equal(out.status, 200); assert(out.headers["set-cookie"]![0]!.includes("Max-Age=0"));
  assert.equal(f.cookies.has("__Host-proofwork_session"), false); assert.equal((await f.send(path)).status, 401);
});
test("wrong Host, Origin, forwarded context and unsafe static paths never bypass existing checks", async t => {
  const f = await fixture(t);
  for (const headers of ([{ host: "wrong.example.test" }, { origin: "https://wrong.example.test" }, { "x-forwarded-host": new URL(f.origin).host }] as Record<string, string>[]))
    assert.equal((await f.send("/", undefined, { headers })).status, 400);
  for (const path of ["/.env", "/application-main.ts", "/assets/../.env", "/unknown", "/api/v1/jobs"]) assert.equal((await f.send(path)).status, 404);
  assert.equal((await f.send("/", envelope)).status, 405); assert.equal((await f.send("/api/v1/auth/challenge", { ...envelope, wallet: f.sponsor.wallet }, { headers: { origin: "https://wrong.example.test" } })).status, 400);
});
for (const mode of ["disabled", "missing"] as const) test("missing chain data is unavailable, never a fabricated milestone: " + mode, async t => {
  const f = await fixture(t, mode); await f.login();
  assert.equal((await f.send("/api/v1/jobs/" + f.job.jobId)).status, 200);
  const r = await f.send("/api/v1/jobs/" + f.job.jobId + "/milestone"); assert.equal(r.status, 503); assert.equal(r.body.data, null);
  assert.equal(r.body.error.code, mode === "disabled" ? "chain_reader_unavailable" : "chain_state_unavailable");
});
test("closed backend store yields sanitized unavailable data", async t => {
  const f = await fixture(t); await f.login(); f.s.close(); const r = await f.send("/api/v1/jobs/" + f.job.jobId);
  assert.equal(r.status, 503); assert.equal(r.body.data, null); assert(!r.bytes.toString().includes("ledger.sqlite"));
});
test("legacy verify retains its independent bearer authentication and browser-origin rejection", async t => {
  const f = await fixture(t);
  assert.equal((await f.send("/verify", {}, { noOrigin: true })).status, 401);
  assert.equal((await f.send("/verify", {}, { headers: { authorization: "Bearer test-github-token" } })).status, 400);
  const valid = await f.send("/verify", {}, { noOrigin: true, headers: { authorization: "Bearer test-github-token" } });
  assert.equal(valid.status, 200); assert.equal(valid.body.legacy, true); assert.equal(f.legacyCalls(), 1);
});
test("application requires explicit HTTPS loopback configuration and does not silently create a DB", async t => {
  for (const value of ["http://localhost:8787", "https://example.test:8787", "https://localhost", "https://localhost:8787/path", "https://user:pass@localhost:8787"])
    assert.throws(() => applicationOrigin(value));
  await assert.rejects(startApplication({}), /configuration_required/);
  const dir = mkdtempSync(join(tmpdir(), "proofwork-missing-db-")), db = join(dir, "absent.sqlite");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(startApplication({ APP_ORIGIN: "https://localhost:" + await freePort(), APP_TLS_CERT_FILE: join(dir, "unused.crt"), APP_TLS_KEY_FILE: join(dir, "unused.key"), APP_LIFECYCLE_DB: db }), { code: "ENOENT" });
  assert.equal(existsSync(db), false);
  await assert.rejects(createApplicationServer({}, {} as any), /tls_files_required/);
});

test("a wrong Ed25519 proof is rejected and cannot replay its consumed challenge over HTTPS", async t => {
  const f = await fixture(t), c = await f.send("/api/v1/auth/challenge", { ...envelope, wallet: f.sponsor.wallet });
  const view = c.body.data;
  const proof = { ...envelope, challengeId: view.challengeId, messageBase64: Buffer.from(view.message).toString("base64"), signatureBase64: sign(null, Buffer.from(view.message), f.other.privateKey).toString("base64") };
  assert.equal((await f.send("/api/v1/auth/verify", proof)).status, 401);
  proof.signatureBase64 = sign(null, Buffer.from(view.message), f.sponsor.privateKey).toString("base64");
  assert.equal((await f.send("/api/v1/auth/verify", proof)).status, 401);
  assert.equal(f.cookies.has("__Host-proofwork_session"), false);
});
