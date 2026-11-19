/** Disposable in-memory signing keys only; real Ed25519 verification, no wallets/RPC writes. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { once } from "node:events";
import { PublicKey } from "@solana/web3.js";
import { DevnetLifecycleReader } from "@proofwork/lifecycle";
import { SETTLEMENT_DEVNET_GENESIS } from "@proofwork/finance-client";
import { WalletSessions, WalletAuthError, CHALLENGE_LIFETIME_MS, SESSION_LIFETIME_MS, SESSION_COOKIE, CHALLENGE_COOKIE,
  readSessionCookie, sessionCookie } from "../src/wallet-sessions.js";
import { WalletApplicationHttp } from "../src/wallet-application-http.js";
import { createVerifierServer } from "../src/server.js";
import { APPLICATION_API_VERSION, type WalletChallengeView } from "../src/application-api-contracts.js";
import { walletLedgerFixture } from "./wallet-ledger-helpers.js";
const ORIGIN = "https://application.example.test", DOMAIN = "application.example.test"; // Test-only, not configuration.
function pair() { const p = generateKeyPairSync("ed25519"); return { ...p, wallet: new PublicKey(p.publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toBase58() }; }
function authFixture() {
  let now = 1_800_000_000_000; const sessions = new WalletSessions({ origin: ORIGIN, domain: DOMAIN, cluster: "devnet" }, () => now);
  const p = pair(), input = { apiVersion: APPLICATION_API_VERSION, cluster: "devnet", wallet: p.wallet };
  let requester: string | undefined;
  const issue = () => { const c = sessions.issue(input, ORIGIN, requester); requester = c.requesterToken; return c.view; };
  const verify = (proof: unknown, origin = ORIGIN) => sessions.verify(proof, origin, requester);
  const proof = (c: WalletChallengeView, signer = p) => ({ apiVersion: APPLICATION_API_VERSION, cluster: "devnet", challengeId: c.challengeId,
    messageBase64: Buffer.from(c.message).toString("base64"), signatureBase64: sign(null, Buffer.from(c.message), signer.privateKey).toString("base64") });
  const login = () => verify(proof(issue()));
  return { sessions, p, input, issue, proof, verify, requester: () => requester, login, advance: (ms: number) => { now += ms; } };
}
function error(fn: () => unknown, code: string, status?: number) {
  assert.throws(fn, e => e instanceof WalletAuthError && e.code === code && (status === undefined || e.status === status));
}
test("actual disposable Ed25519 signature establishes wallet ownership with SIWS context and no authority", () => {
  const f = authFixture(), c = f.issue(), s = f.verify(f.proof(c), ORIGIN);
  assert.equal(c.signInInput.chainId, "solana:devnet"); assert.equal(c.signInInput.domain, DOMAIN); assert.equal(c.signInInput.uri, ORIGIN);
  assert.match(c.challengeId, /^[a-f0-9]{64}$/); assert.equal(c.signInInput.nonce, c.challengeId);
  assert(c.message.includes("ProofOfWork for read-only")); assert(c.message.includes("No transaction or payment is authorized."));
  assert.equal(f.sessions.resolve(s.token)!.wallet, f.p.wallet); assert.equal(s.view.authenticationMethod, "siws-raw-ed25519");
  assert(!JSON.stringify(s.view).includes(s.token)); assert(!JSON.stringify(s.view).includes("role")); assert(Object.isFrozen(s.view));
});
test("server-generated challenge bytes use the exact SIWS field ordering and timestamps", () => {
  const f = authFixture(), c = f.issue(), i = c.signInInput;
  assert.equal(c.message, `${DOMAIN} wants you to sign in with your Solana account:\n${f.p.wallet}\n\n${i.statement}\n\nURI: ${ORIGIN}\nVersion: 1\nChain ID: solana:devnet\nNonce: ${i.nonce}\nIssued At: ${i.issuedAt}\nExpiration Time: ${i.expirationTime}\nRequest ID: ${i.requestId}`);
  assert.equal(Date.parse(c.expiresAt) - Date.parse(c.issuedAt), CHALLENGE_LIFETIME_MS);
});
test("wrong wallet cryptographic signature fails and consumes the challenge", () => {
  const f = authFixture(), c = f.issue(); error(() => f.verify(f.proof(c, pair()), ORIGIN), "authentication_failed", 401);
  error(() => f.verify(f.proof(c), ORIGIN), "authentication_failed", 401);
});
for (const changed of ["domain", "cluster", "nonce", "purpose", "newline", "wallet", "issuedAt", "expiry"] as const)
  test("altered SIWS " + changed + " bytes cannot authenticate even with a valid signature over the changed text", () => {
    const f = authFixture(), c = f.issue();
    const m = changed === "domain" ? c.message.replace(DOMAIN, "other.example.test")
      : changed === "cluster" ? c.message.replace("solana:devnet", "unsupported")
      : changed === "nonce" ? c.message.replace("Nonce: " + c.challengeId, "Nonce: ")
      : changed === "purpose" ? c.message.replace("read-only", "administrator")
      : changed === "newline" ? c.message.replaceAll("\n", "\r\n")
      : changed === "wallet" ? c.message.replace(f.p.wallet, pair().wallet)
      : changed === "issuedAt" ? c.message.replace(c.issuedAt, "2000-01-01T00:00:00.000Z")
      : c.message.replace(c.expiresAt, "2099-01-01T00:00:00.000Z");
    error(() => f.verify({ ...f.proof(c), messageBase64: Buffer.from(m).toString("base64"), signatureBase64: sign(null, Buffer.from(m), f.p.privateKey).toString("base64") }, ORIGIN), "authentication_failed", 401);
  });
test("challenge expiration rejects at the exact deadline", () => { const f = authFixture(), c = f.issue(); f.advance(CHALLENGE_LIFETIME_MS); error(() => f.verify(f.proof(c), ORIGIN), "authentication_failed", 401); });
test("single-use nonce and concurrent duplicate login permit exactly one session", async () => {
  const f = authFixture(), proof = f.proof(f.issue());
  const results = await Promise.allSettled([Promise.resolve().then(() => f.verify(proof, ORIGIN)), Promise.resolve().then(() => f.verify(proof, ORIGIN))]);
  assert.equal(results.filter(x => x.status === "fulfilled").length, 1); assert.equal(results.filter(x => x.status === "rejected").length, 1);
  error(() => f.verify(proof, ORIGIN), "authentication_failed", 401);
});
test("client-invented challenge cannot establish a session", () => { const f = authFixture(), c = f.issue(); error(() => f.verify({ ...f.proof(c), challengeId: "ab".repeat(32) }, ORIGIN), "authentication_failed", 401); });
for (const patch of [{ cluster: "unsupported" }, { wallet: "bad" }, { role: "operator" }, { approved: true }, { nonce: "client_nonce" }, { domain: "other.example.test" }, { apiVersion: "unknown" }])
  test("challenge input rejects " + Object.keys(patch)[0], () => { const f = authFixture(); error(() => f.sessions.issue({ ...f.input, ...patch }, ORIGIN), "invalid_request", 400); });
for (const signature of ["", "a".repeat(88), "not base64", Buffer.alloc(64).toString("base64"), Buffer.alloc(63).toString("base64"), Buffer.alloc(65).toString("base64")])
  test("malformed/wrong signature is rejected, length " + signature.length, () => { const f = authFixture(), c = f.issue(); error(() => f.verify({ ...f.proof(c), signatureBase64: signature }, ORIGIN), "authentication_failed", 401); });
test("noncanonical signature/message encoding and transaction-shaped bytes reject", () => {
  const f = authFixture(); for (const messageBase64 of ["not_base64!", "AA==", Buffer.from("transaction payload").toString("base64")]) {
    const c = f.issue(); error(() => f.verify({ ...f.proof(c), messageBase64 }, ORIGIN), "authentication_failed", 401);
  }
});
test("weak/default/small-order wallet keys cannot obtain challenges", () => {
  const f = authFixture(); for (const bytes of [Buffer.alloc(32), Buffer.concat([Buffer.from([1]), Buffer.alloc(31)])]) error(() => f.sessions.issue({ ...f.input, wallet: new PublicKey(bytes).toBase58() }, ORIGIN), "invalid_request", 400);
});
test("wrong request origin cannot issue or verify a challenge", () => {
  const f = authFixture(), c = f.issue(); error(() => f.sessions.issue(f.input, "https://other.example.test"), "invalid_request", 400);
  error(() => f.verify(f.proof(c), "https://other.example.test"), "invalid_request", 400); assert(f.verify(f.proof(c), ORIGIN));
});
for (const patch of [{ origin: "http://localhost" }, { domain: "wrong.example.test" }, { origin: ORIGIN + "/path" }, { cluster: "unsupported" }, { approved: true }])
  test("configuration has no insecure origin/domain/cluster or approval bypass: " + Object.keys(patch)[0], () => {
    assert.throws(() => new WalletSessions({ origin: ORIGIN, domain: DOMAIN, cluster: "devnet", ...patch } as any), WalletAuthError);
  });
test("strict own-data validation rejects getters without evaluating them", () => {
  const f = authFixture(); let n = 0; const input = { ...f.input }; Object.defineProperty(input, "wallet", { enumerable: true, get() { n++; return f.p.wallet; } });
  error(() => f.sessions.issue(input, ORIGIN), "invalid_request", 400); assert.equal(n, 0);
});
test("sessions expire exactly, revoke immediately and cannot be guessed or used after restart", () => {
  const f = authFixture(), s = f.login(); assert.equal(Date.parse(s.view.expiresAt) - Date.parse(s.view.authenticatedAt), SESSION_LIFETIME_MS);
  for (const guess of [undefined, "", "A".repeat(43), s.token.slice(1), s.view.sessionId]) assert.equal(f.sessions.resolve(guess), null);
  assert.equal(new WalletSessions({ origin: ORIGIN, domain: DOMAIN, cluster: "devnet" }).resolve(s.token), null);
  f.sessions.revoke(s.token); assert.equal(f.sessions.resolve(s.token), null);
  const next = f.login(); f.advance(SESSION_LIFETIME_MS); assert.equal(f.sessions.resolve(next.token), null);
});
test("rollback of the server clock invalidates challenges and sessions", () => {
  const f = authFixture(), s = f.login(), c = f.issue(); f.advance(-1);
  error(() => f.sessions.resolve(s.token), "authentication_unavailable", 503); f.advance(1);
  assert.equal(f.sessions.resolve(s.token), null); error(() => f.verify(f.proof(c), ORIGIN), "authentication_failed", 401);
});
test("challenge allocation and verification attempts are bounded without live-entry eviction", () => {
  const f = authFixture(); const c = f.issue(); for (let i = 0; i < 3; i++) f.issue(); error(f.issue, "authentication_capacity", 503);
  for (let i = 5; i < 60; i++) assert.throws(() => f.sessions.issue({ ...f.input, wallet: "bad" }, ORIGIN));
  error(f.issue, "authentication_rate_limited", 429);
  assert(f.verify(f.proof(c), ORIGIN));
  for (let i = 1; i < 120; i++) assert.throws(() => f.verify({ ...f.proof(c), challengeId: "ab".repeat(32) }, ORIGIN));
  error(() => f.verify(f.proof(c), ORIGIN), "authentication_rate_limited", 429);
});
test("session capacity is bounded and expiry frees capacity without persisting authority", () => {
  const f = authFixture(); let first = "";
  for (let i = 0; i < 256; i++) { if (i > 0 && i % 60 === 0) f.advance(60_000); const s = f.login(); if (i === 0) first = s.token; }
  assert(f.sessions.resolve(first)); error(f.login, "authentication_capacity", 503); f.advance(60_000); assert.equal(f.sessions.resolve(first), null); assert(f.login());
});
test("secure cookie transport is strict and duplicate cookies cannot shadow a session", () => {
  const f = authFixture(), s = f.login(), cookie = sessionCookie(s.token);
  for (const flag of ["__Host-", "Path=/", "Secure", "HttpOnly", "SameSite=Strict", "Max-Age=300"]) assert(cookie.includes(flag));
  assert(!cookie.includes("Domain=")); assert.equal(readSessionCookie(cookie), s.token);
  assert.equal(readSessionCookie(`${SESSION_COOKIE}=${s.token}; ${SESSION_COOKIE}=${s.token}`), undefined);
  assert.equal(readSessionCookie("x".repeat(2049)), undefined); assert(sessionCookie("", true).includes("Max-Age=0"));
});
test("anonymous requester reservations cannot exhaust another wallet owner's four-challenge allowance", () => {
  const f = authFixture(); let attacker: string | undefined;
  for (let i = 0; i < 4; i++) attacker = f.sessions.issue(f.input, ORIGIN, attacker).requesterToken;
  error(() => f.sessions.issue(f.input, ORIGIN, attacker), "authentication_capacity", 503);
  const owner = f.issue(); for (let i = 0; i < 3; i++) f.issue(); error(f.issue, "authentication_capacity", 503);
  assert(f.verify(f.proof(owner))); assert.notEqual(f.requester(), attacker);
});
test("missing, invented or other requester cookies cannot consume a valid login proof", () => {
  const f = authFixture(), c = f.issue(), proof = f.proof(c), other = f.sessions.issue(f.input, ORIGIN).requesterToken;
  for (const requester of [undefined, "A".repeat(43), other]) error(() => f.sessions.verify(proof, ORIGIN, requester), "authentication_failed", 401);
  assert(f.verify(proof));
});

async function httpFixture(t: TestContext, available = true) {
  const auth = authFixture(), student = pair(), other = pair(), dir = mkdtempSync(join(tmpdir(), "pow-wallet-http-"));
  const { s, job, otherJob, accounts } = walletLedgerFixture(dir, auth.p.wallet, student.wallet, other.wallet);
  let hook = async (_method: string) => {}; const calls: string[] = [];
  const chain = { provenance: "offline_fixture" as const, reader: new DevnetLifecycleReader("finalized", async (_url, init) => {
    const msg = JSON.parse(init!.body as string); calls.push(msg.method); await hook(msg.method);
    assert(["getGenesisHash", "getMultipleAccounts"].includes(msg.method));
    return Response.json({ jsonrpc: "2.0", id: 1, result: msg.method === "getGenesisHash" ? SETTLEMENT_DEVNET_GENESIS : { context: { slot: 200 }, value: msg.params[0].map((p: string) => accounts.get(p) ?? null) } });
  }) };
  const app = new WalletApplicationHttp(auth.sessions, available ? { store: s, timeoutMs: 500, chain } : undefined);
  let verifyCalls = 0;
  const server = createVerifierServer({ verify: async () => { verifyCalls++; return { legacy: true } as any; } }, app);
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const port = (server.address() as any).port;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); s.close(); rmSync(dir, { recursive: true, force: true }); });
  function send(path: string, options: { method?: string; cookie?: string; headers?: Record<string, string>; input?: unknown; raw?: string } = {}) {
    const text = options.raw ?? (options.input === undefined ? undefined : JSON.stringify(options.input));
    return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: any }>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port, path, method: options.method ?? "GET", headers: { host: DOMAIN, ...(options.cookie ? { cookie: options.cookie } : {}), ...(text === undefined ? {} : { "content-type": "application/json" }), ...options.headers } }, res => {
        const chunks: Buffer[] = []; res.on("data", c => chunks.push(c)); res.on("end", () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode!, headers: res.headers, body: text ? JSON.parse(text) : null }); });
      }); req.on("error", reject); if (text !== undefined) req.write(text); req.end();
    });
  }
  const post = (path: string, input: unknown, cookie?: string) => send(path, { method: "POST", input, cookie, headers: { origin: ORIGIN } });
  const login = async (p = auth.p) => {
    const c = await post("/api/v1/auth/challenge", { ...auth.input, wallet: p.wallet }); assert.equal(c.status, 200);
    const proof = { apiVersion: APPLICATION_API_VERSION, cluster: "devnet", challengeId: c.body.data.challengeId,
      messageBase64: Buffer.from(c.body.data.message).toString("base64"), signatureBase64: sign(null, Buffer.from(c.body.data.message), p.privateKey).toString("base64") };
    const requesterCookie = c.headers["set-cookie"]![0]!.split(";")[0]!;
    const result = await post("/api/v1/auth/verify", proof, requesterCookie); assert.equal(result.status, 200);
    const cookie = result.headers["set-cookie"]![0]!.split(";")[0]!;
    assert(!JSON.stringify(result.body).includes(cookie.split("=")[1]!));
    return { cookie, requesterCookie, proof, result };
  };
  const path = (resource = "job", id = job.jobId) => "/api/v1/jobs/" + id + (resource === "job" ? "" : "/" + resource);
  return { ...auth, student, other, job, otherJob, s, accounts, chain, calls, app, server, port, send, post, login, path, verifyCalls: () => verifyCalls, hook: (fn: typeof hook) => { hook = fn; } };
}
for (const role of ["sponsor", "student"] as const) for (const resource of ["job", "milestone", "execution"])
  test("HTTP actual wallet login authorizes only related " + role + " " + resource + " read", async t => {
    const f = await httpFixture(t), login = await f.login(role === "sponsor" ? f.p : f.student), r = await f.send(f.path(resource), { cookie: login.cookie });
    assert.equal(r.status, 200); assert.equal(r.body.apiVersion, APPLICATION_API_VERSION);
    assert.equal(r.body.permissions.signingAuthorization, "not_granted");
    for (const [k, v] of Object.entries(r.body.permissions)) if (k !== "signingAuthorization") assert.equal(v, false);
    assert.equal(r.headers["cache-control"], "no-store"); assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert(!r.headers["access-control-allow-origin"]); assert(!JSON.stringify(r.body).includes("wireBase64"));
  });
test("HTTP unauthenticated, guessed and GitHub bearer credentials cannot read resources", async t => {
  const f = await httpFixture(t);
  for (const options of [{}, { cookie: SESSION_COOKIE + "=" + "A".repeat(43) }, { headers: { authorization: "Bearer github_example_not_a_wallet_session" } }]) assert.equal((await f.send(f.path(), options)).status, 401);
});
test("HTTP different wallets, unknown jobs and role injection cannot enumerate resources", async t => {
  const f = await httpFixture(t), login = await f.login(f.other);
  for (const resource of ["job", "milestone", "execution"]) {
    const r = await f.send(f.path(resource), { cookie: login.cookie }), unknown = await f.send(f.path(resource, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), { cookie: login.cookie });
    assert.equal(r.status, 404); assert.deepEqual(r.body.error, unknown.body.error); assert.equal(r.body.data, null);
  }
  assert.deepEqual(f.calls, []);
  assert.equal((await f.post("/api/v1/auth/challenge", { ...f.input, role: "operator" })).status, 400);
  assert.equal((await f.send("/api/v1/operator", { cookie: login.cookie })).status, 404);
});
test("HTTP concurrent reads remain request scoped across users while awaiting RPC", async t => {
  const f = await httpFixture(t), a = await f.login(), b = await f.login(f.other);
  let release!: () => void, started!: () => void; const ready = new Promise<void>(r => { started = r; }), hold = new Promise<void>(r => { release = r; });
  f.hook(async method => { if (method === "getMultipleAccounts") { started(); await hold; } });
  const pending = f.send(f.path("milestone"), { cookie: a.cookie }); await ready;
  assert.equal((await f.send(f.path("job", f.otherJob.jobId), { cookie: b.cookie })).status, 200);
  assert.equal((await f.send(f.path(), { cookie: b.cookie })).status, 404);
  assert.equal((await f.send(f.path("job", f.otherJob.jobId), { cookie: a.cookie })).status, 404);
  release(); assert.equal((await pending).status, 200);
});
test("HTTP logout, expiry and revocation during awaited RPC suppress private results", async t => {
  const f = await httpFixture(t), a = await f.login();
  f.hook(async method => { if (method === "getMultipleAccounts") f.sessions.revoke(readSessionCookie(a.cookie)); });
  assert.equal((await f.send(f.path("milestone"), { cookie: a.cookie })).status, 401);
  const b = await f.login(), logout = await f.post("/api/v1/auth/logout", { apiVersion: APPLICATION_API_VERSION, cluster: "devnet" }, b.cookie);
  assert.equal(logout.status, 200);
  assert(logout.headers["set-cookie"]?.some(cookie => cookie.startsWith(SESSION_COOKIE + "=;") && cookie.includes("Max-Age=0")));
  assert.equal((await f.send(f.path(), { cookie: b.cookie })).status, 401);
  const c = await f.login(); f.advance(SESSION_LIFETIME_MS); assert.equal((await f.send(f.path(), { cookie: c.cookie })).status, 401);
});
test("HTTP changed job state after RPC yields resource_changed without mutation/retry", async t => {
  const f = await httpFixture(t), a = await f.login(); f.hook(async method => { if (method === "getMultipleAccounts") f.s.jobs.claimJob(f.job.jobId, f.job.identity, 0, "test_worker"); });
  const r = await f.send(f.path("milestone"), { cookie: a.cookie }); assert.equal(r.status, 503); assert.equal(r.body.error.code, "resource_changed"); assert.equal(f.calls.length, 2);
});
test("HTTP unavailable application services and closed DB fail safely", async t => {
  const f = await httpFixture(t, false), a = await f.login(); assert.equal((await f.send(f.path(), { cookie: a.cookie })).status, 503);
  const g = await httpFixture(t), b = await g.login(); g.s.close(); const r = await g.send(g.path(), { cookie: b.cookie }); assert.equal(r.status, 503); assert.equal(r.body.data, null);
});
test("HTTP missing RPC account and dependency timeout do not grant authority or retry", async t => {
  const f = await httpFixture(t), a = await f.login(); f.accounts.set(f.job.bindings.milestone, null);
  const missing = await f.send(f.path("milestone"), { cookie: a.cookie }); assert.equal(missing.status, 503); assert.equal(missing.body.error.code, "chain_state_unavailable");
  f.hook(async () => new Promise(() => {})); const timeout = await f.send(f.path("milestone"), { cookie: a.cookie }); assert.equal(timeout.status, 503); assert.equal(timeout.body.error.code, "chain_timeout");
});
for (const change of [{ origin: "https://other.example.test" }, { origin: "null" }, { host: "other.example.test" }, { "sec-fetch-site": "cross-site" }, { "x-forwarded-host": DOMAIN }, { "x-forwarded-proto": "https" }] as Record<string, string>[])
  test("HTTP exact context rejects " + Object.keys(change)[0], async t => { const f = await httpFixture(t), a = await f.login(); assert.equal((await f.send(f.path(), { cookie: a.cookie, headers: change })).status, 400); });
test("HTTP malformed JSON, oversized body, extra fields and missing origin reject", async t => {
  const f = await httpFixture(t);
  for (const raw of ["{", "[1]", "null"]) assert.equal((await f.send("/api/v1/auth/challenge", { method: "POST", raw, headers: { origin: ORIGIN } })).status, 400);
  assert.equal((await f.send("/api/v1/auth/challenge", { method: "POST", raw: "x".repeat(8193), headers: { origin: ORIGIN } })).status, 413);
  assert.equal((await f.post("/api/v1/auth/challenge", { ...f.input, approved: true })).status, 400);
  assert.equal((await f.send("/api/v1/auth/challenge", { method: "POST", input: f.input })).status, 400);
});
for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) test("HTTP private read rejects method " + method, async t => {
  const f = await httpFixture(t); const r = await f.send(f.path(), { method }); assert.equal(r.status, 405); assert.equal(r.headers.allow, "GET");
});
test("HTTP invalid resource, auth query transport, logout CSRF and duplicate cookies fail closed", async t => {
  const f = await httpFixture(t), a = await f.login();
  assert.equal((await f.send("/api/v1/jobs/bad", { cookie: a.cookie })).status, 400);
  assert.equal((await f.send(f.path() + "?token=not_supported", { cookie: a.cookie })).status, 404);
  assert.equal((await f.send("/api/v1/auth/logout", { method: "POST", input: { apiVersion: APPLICATION_API_VERSION, cluster: "devnet" }, cookie: a.cookie })).status, 400);
  assert.equal((await f.send(f.path(), { cookie: a.cookie + "; " + a.cookie })).status, 401);
});
test("HTTP nonce replay is rejected and session secrets never enter JSON/errors", async t => {
  const f = await httpFixture(t), a = await f.login(), r = await f.post("/api/v1/auth/verify", a.proof, a.requesterCookie);
  assert.equal(r.status, 401); assert.equal(r.body.data, null); assert(!JSON.stringify(r.body).includes(a.cookie));
  assert(!JSON.stringify(a.result.body).includes(a.cookie.split("=")[1]!));
});
test("HTTP four anonymous reservations cannot lock out the wallet owner's independent browser", async t => {
  const f = await httpFixture(t); let attacker: string | undefined;
  for (let i = 0; i < 4; i++) {
    const r = await f.post("/api/v1/auth/challenge", f.input, attacker); assert.equal(r.status, 200);
    attacker = r.headers["set-cookie"]![0]!.split(";")[0]!;
  }
  assert.equal((await f.post("/api/v1/auth/challenge", f.input, attacker)).status, 503);
  const owner = await f.login(); assert.notEqual(owner.requesterCookie, attacker);
  assert.equal((await f.send(f.path(), { cookie: owner.cookie })).status, 200);
});
test("HTTP login proof requires its own secure requester cookie and foreign attempts cannot burn it", async t => {
  const f = await httpFixture(t), c = await f.post("/api/v1/auth/challenge", f.input), other = await f.post("/api/v1/auth/challenge", f.input);
  const requester = c.headers["set-cookie"]![0]!, wrong = other.headers["set-cookie"]![0]!.split(";")[0]!;
  for (const flag of [CHALLENGE_COOKIE, "Secure", "HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=120"]) assert(requester.includes(flag));
  const proof = f.proof(c.body.data);
  assert.equal((await f.post("/api/v1/auth/verify", proof)).status, 401);
  assert.equal((await f.post("/api/v1/auth/verify", proof, wrong)).status, 401);
  assert.equal((await f.post("/api/v1/auth/verify", proof, requester.split(";")[0]!)).status, 200);
});
test("HTTP stalled login body times out and closes without issuing a challenge", async t => {
  const f = await httpFixture(t);
  const result = await new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: f.port, path: "/api/v1/auth/challenge", method: "POST",
      headers: { host: DOMAIN, origin: ORIGIN, "content-type": "application/json" } }, res => {
      const chunks: Buffer[] = []; res.on("data", c => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); req.on("error", reject); req.write("{");
  });
  assert.equal(result.status, 408); assert.equal(result.body.error.code, "request_timeout"); assert.equal(result.body.data, null);
});
test("HTTP concurrent incomplete requests are bounded to sixteen admitted bodies", async t => {
  const f = await httpFixture(t); const pending: ReturnType<typeof request>[] = [];
  t.after(() => { for (const req of pending) req.destroy(); });
  for (let i = 0; i < 16; i++) {
    const started = once(f.server, "request");
    const req = request({ hostname: "127.0.0.1", port: f.port, path: "/api/v1/auth/challenge", method: "POST",
      headers: { host: DOMAIN, origin: ORIGIN, "content-type": "application/json" } }, res => res.resume());
    req.on("error", () => {}); pending.push(req); req.write("{"); await started;
  }
  const r = await f.post("/api/v1/auth/challenge", f.input); assert.equal(r.status, 503); assert.equal(r.body.error.code, "application_capacity");
});
test("HTTP session expiry during awaited RPC cannot release a previously authenticated result", async t => {
  const f = await httpFixture(t), a = await f.login(); f.hook(async method => { if (method === "getMultipleAccounts") f.advance(SESSION_LIFETIME_MS); });
  const r = await f.send(f.path("milestone"), { cookie: a.cookie }); assert.equal(r.status, 401); assert.equal(r.body.data, null);
});
test("HTTP login verification rejects role forgery and duplicate Origin headers", async t => {
  const f = await httpFixture(t), a = await f.login();
  assert.equal((await f.post("/api/v1/auth/verify", { ...a.proof, role: "operator" })).status, 400);
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: f.port, path: f.path(), method: "GET",
      headers: ["Host", DOMAIN, "Origin", ORIGIN, "Origin", ORIGIN, "Cookie", a.cookie] }, res => { res.resume(); res.once("end", () => resolve(res.statusCode!)); });
    req.on("error", reject); req.end();
  }); assert.equal(status, 400);
});
test("default server activation remains closed; legacy verify and health remain compatible", async t => {
  const f = await httpFixture(t); const r = await f.send("/verify", { method: "POST", input: {}, headers: { authorization: "Bearer github_example", "content-type": "application/json" } });
  assert.equal(r.status, 200); assert.deepEqual(r.body, { legacy: true });
  const health = await f.send("/api/v1/health"); assert.equal(health.status, 200); assert.equal(health.body.data.execution, "disabled");
  assert.equal(health.body.data.authentication, "wallet_signature_single_instance");
  assert.equal(f.verifyCalls(), 1);
  const server = createVerifierServer({ verify: async () => { throw Error("not called"); } }); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const response = await fetch("http://127.0.0.1:" + (server.address() as any).port + "/api/v1/auth/challenge", { method: "POST" });
  assert.equal(response.status, 404);
});
