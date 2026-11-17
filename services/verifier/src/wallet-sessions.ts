/** Reviewed single-process login feature, not production deployment approval. No signer or RPC. */
import { randomBytes, createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { key } from "./commitments.js";
import { record } from "./read-only-observation-data.js";
import { APPLICATION_API_VERSION, type WalletChallengeView, type WalletSessionView } from "./application-api-contracts.js";
export const SESSION_COOKIE = "__Host-proofwork_session";
export const CHALLENGE_LIFETIME_MS = 120_000, SESSION_LIFETIME_MS = 300_000;
export class WalletAuthError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
function need(ok: unknown, code = "invalid_request", status = 400): asserts ok {
  if (!ok) throw new WalletAuthError(code, status);
}
function fields(value: unknown, names: readonly string[]) {
  try { return record(value, names); } catch { throw new WalletAuthError("invalid_request", 400); }
}
function wallet(value: unknown): string {
  try {
    const k = key(value), p = ed25519.Point.fromBytes(k.toBytes());
    need(!p.isSmallOrder() && p.isTorsionFree()); return k.toBase58();
  } catch { throw new WalletAuthError("invalid_request", 400); }
}
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
interface Challenge { view: WalletChallengeView; expires: number }
interface Session { view: WalletSessionView; expires: number; challengeId: string; challengeIssuedAt: string }
/** Instantiating this service does not register routes or change the default CLI deployment. */
export class WalletSessions {
  readonly origin: string; readonly domain: string;
  readonly #now: () => number;
  readonly #challenges = new Map<string, Challenge>();
  readonly #sessions = new Map<string, Session>(); // SHA-256 token keys; raw tokens are not retained.
  #last = 0; #window = 0; #issued = 0; #verified = 0;
  constructor(config: { origin: string; domain: string; cluster: "devnet" }, now: () => number = Date.now) {
    const c = fields(config, ["origin", "domain", "cluster"]);
    try {
      need(typeof c.origin === "string" && c.origin.length <= 256 && c.cluster === "devnet");
      const u = new URL(c.origin);
      need(u.protocol === "https:" && u.origin === c.origin && u.host === c.domain
        && !u.username && !u.password && !u.search && !u.hash && !u.hostname.endsWith("."));
      need(typeof now === "function");
      this.origin = c.origin; this.domain = c.domain; this.#now = now;
    } catch { throw new WalletAuthError("invalid_auth_configuration", 503); }
    Object.freeze(this);
  }
  private time(): number {
    const t = this.#now();
    if (!Number.isSafeInteger(t) || t <= 0 || t < this.#last || t > 8e15) {
      this.#challenges.clear(); this.#sessions.clear();
      throw new WalletAuthError("authentication_unavailable", 503);
    }
    this.#last = t;
    for (const [id, c] of this.#challenges) if (t >= c.expires) this.#challenges.delete(id);
    for (const [id, s] of this.#sessions) if (t >= s.expires) this.#sessions.delete(id);
    if (t - this.#window >= 60_000) { this.#window = t; this.#issued = 0; this.#verified = 0; }
    return t;
  }
  private context(origin: string): void { need(origin === this.origin, "invalid_request"); }
  issue(input: unknown, origin: string): WalletChallengeView {
    this.context(origin); const t = this.time();
    need(++this.#issued <= 60, "authentication_rate_limited", 429);
    const r = fields(input, ["apiVersion", "cluster", "wallet"]);
    need(r.apiVersion === APPLICATION_API_VERSION && r.cluster === "devnet");
    const address = wallet(r.wallet);
    need(this.#challenges.size < 256 && [...this.#challenges.values()].filter(c => c.view.wallet === address).length < 4,
      "authentication_capacity", 503);
    const challengeId = randomBytes(32).toString("hex");
    need(!this.#challenges.has(challengeId), "authentication_unavailable", 503);
    const issuedAt = new Date(t).toISOString(), expiresAt = new Date(t + CHALLENGE_LIFETIME_MS).toISOString();
    // Strict SIWS v1 raw-message subset. No parser or client-authored message reconstruction.
    const signInInput = Object.freeze({ domain: this.domain, address,
      statement: "Sign in to ProofOfWork for read-only application access. No transaction or payment is authorized.",
      uri: this.origin, version: "1", chainId: "solana:devnet", nonce: challengeId, issuedAt, expirationTime: expiresAt,
      requestId: challengeId });
    const message = `${signInInput.domain} wants you to sign in with your Solana account:\n${address}\n\n${signInInput.statement}\n\nURI: ${this.origin}\nVersion: 1\nChain ID: solana:devnet\nNonce: ${challengeId}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}\nRequest ID: ${challengeId}`;
    const view: WalletChallengeView = Object.freeze({ kind: "wallet_challenge", challengeId, wallet: address,
      issuedAt, expiresAt, message, signInInput, signedMessageFormat: "siws-raw-ed25519" });
    this.#challenges.set(challengeId, { view, expires: t + CHALLENGE_LIFETIME_MS }); return view;
  }
  verify(input: unknown, origin: string): Readonly<{ token: string; view: WalletSessionView }> {
    this.context(origin); const t = this.time();
    need(++this.#verified <= 120, "authentication_rate_limited", 429);
    const r = fields(input, ["apiVersion", "cluster", "challengeId", "messageBase64", "signatureBase64"]);
    need(typeof r.challengeId === "string" && /^[a-f0-9]{64}$/.test(r.challengeId));
    const c = this.#challenges.get(r.challengeId);
    // No await between lookup, consumption and verification/session insertion: one attempt, one process.
    this.#challenges.delete(r.challengeId);
    need(c, "authentication_failed", 401);
    need(r.apiVersion === APPLICATION_API_VERSION && r.cluster === "devnet", "authentication_failed", 401);
    need(typeof r.messageBase64 === "string" && r.messageBase64 === Buffer.from(c.view.message, "utf8").toString("base64"), "authentication_failed", 401);
    need(typeof r.signatureBase64 === "string" && /^[A-Za-z0-9+/]{86}==$/.test(r.signatureBase64), "authentication_failed", 401);
    const signature = Buffer.from(r.signatureBase64, "base64");
    need(signature.length === 64 && signature.toString("base64") === r.signatureBase64
      && ed25519.verify(signature, Buffer.from(c.view.message, "utf8"), key(c.view.wallet).toBytes(), { zip215: false }), "authentication_failed", 401);
    need(this.#sessions.size < 256, "authentication_capacity", 503);
    const token = randomBytes(32).toString("base64url"), id = digest(token);
    need(!this.#sessions.has(id), "authentication_unavailable", 503);
    const view: WalletSessionView = Object.freeze({ kind: "wallet_session", wallet: c.view.wallet,
      sessionId: randomBytes(16).toString("hex"), authenticationMethod: "siws-raw-ed25519",
      origin: this.origin, domain: this.domain, cluster: "devnet", authenticatedAt: new Date(t).toISOString(),
      expiresAt: new Date(t + SESSION_LIFETIME_MS).toISOString() });
    this.#sessions.set(id, { view, expires: t + SESSION_LIFETIME_MS, challengeId: c.view.challengeId, challengeIssuedAt: c.view.issuedAt });
    return Object.freeze({ token, view });
  }
  resolve(token: string | undefined): WalletSessionView | null {
    this.time();
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return this.#sessions.get(digest(token))?.view ?? null;
  }
  revoke(token: string | undefined): void { if (this.resolve(token)) this.#sessions.delete(digest(token!)); }
}
export function sessionCookie(token: string, revoke = false): string {
  need(revoke || /^[A-Za-z0-9_-]{43}$/.test(token));
  return `${SESSION_COOKIE}=${revoke ? "" : token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${revoke ? 0 : SESSION_LIFETIME_MS / 1000}`;
}
export function readSessionCookie(raw: string | undefined): string | undefined {
  if (typeof raw !== "string" || raw.length > 2048) return undefined;
  const values = raw.split(";").map(v => v.trim()).filter(v => v.startsWith(SESSION_COOKIE + "="));
  if (values.length !== 1) return undefined;
  const value = values[0]!.slice(SESSION_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}
