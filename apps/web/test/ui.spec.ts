import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";

const ORIGIN = "https://application.example.test"; // Intercepted browser-test origin only. No public deployment or TLS claim.
const WALLET = "mock-browser-wallet"; // Deliberately non-operational provider stub. No signing keys or real identity.
const ID = "11111111-1111-4111-8111-111111111111";
const VERSION = "proofwork-application-api-v1";
const reply = (data: object | null, provenance = "server_challenge", error: string | null = null) => ({ apiVersion: VERSION, cluster: "devnet", requestId: ID, data, provenance, error: error ? { code: error } : null });
type Settings = { reject?: boolean; expires?: number; altered?: boolean; badSignature?: boolean; challengeExpired?: boolean; error?: number; delay?: number; jobError?: number };
async function browserFixture(page: Page, settings: Settings = {}) {
  const calls: { path: string; body: any; cookie?: string }[] = [];
  let challenge: any;
  await page.addInitScript(({ wallet, reject, badSignature }) => {
    const key = { toBase58: () => wallet };
    const events: Record<string, (() => void)[]> = {};
    const state = window as any;
    state.signedMessages = [];
    state.phantom = { solana: { isPhantom: true, publicKey: key,
      connect: async () => { if (reject) throw new Error("User rejected"); return { publicKey: key }; },
      disconnect: async () => { (events.disconnect ?? []).forEach(f => f()); },
      signMessage: async (bytes: Uint8Array, display: string) => { state.signedMessages.push({ bytes: Array.from(bytes), display }); return { signature: new Uint8Array(badSignature ? 65 : 64), publicKey: key }; },
      on: (event: string, fn: () => void) => { (events[event] ??= []).push(fn); },
      removeListener: (event: string, fn: () => void) => { events[event] = (events[event] ?? []).filter(f => f !== fn); },
    } };
    state.changeWallet = () => { state.phantom.solana.publicKey = null; (events.accountChanged ?? []).forEach(f => f()); };
  }, { wallet: WALLET, reject: settings.reject, badSignature: settings.badSignature });
  await page.route(ORIGIN + "/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path.startsWith("/api/")) {
      calls.push({ path, body: req.postDataJSON(), cookie: req.headers().cookie });
      if (settings.error) return route.fulfill({ status: settings.error, json: reply(null, "none", "application_unavailable") });
      if (path.endsWith("/challenge")) {
        const issuedAt = new Date(Date.now() - (settings.challengeExpired ? 130_000 : 0)).toISOString();
        const expiresAt = new Date(Date.parse(issuedAt) + 120_000).toISOString(), nonce = "a".repeat(64);
        const text = `application.example.test wants you to sign in with your Solana account:\n${WALLET}\n\nSign in to ProofOfWork for read-only application access. No transaction or payment is authorized.\n\nURI: ${ORIGIN}\nVersion: 1\nChain ID: solana:devnet\nNonce: ${nonce}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}\nRequest ID: ${nonce}`;
        challenge = { kind: "wallet_challenge", wallet: WALLET, challengeId: nonce, issuedAt, expiresAt, message: settings.altered ? text.replace("solana:devnet", "other-chain") : text, signedMessageFormat: "siws-raw-ed25519" };
        return route.fulfill({ json: reply(challenge), headers: { "set-cookie": "__Host-proofwork_challenge=test-context; Path=/; Secure; HttpOnly; SameSite=Strict" } });
      }
      if (path.endsWith("/verify")) return route.fulfill({ json: reply({ kind: "wallet_session", wallet: WALLET, origin: ORIGIN, domain: "application.example.test", cluster: "devnet", authenticationMethod: "siws-raw-ed25519", expiresAt: new Date(Date.now() + (settings.expires ?? 300_000)).toISOString() }, "wallet_signature_session"), headers: { "set-cookie": "__Host-proofwork_session=test-session; Path=/; Secure; HttpOnly; SameSite=Strict" } });
      if (path.endsWith("/logout")) return route.fulfill({ json: reply({ kind: "wallet_logout", revoked: true }, "wallet_signature_session"), headers: { "set-cookie": "__Host-proofwork_session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0" } });
      if (settings.delay) await new Promise(r => setTimeout(r, settings.delay));
      if (settings.jobError) return route.fulfill({ status: settings.jobError, json: reply(null, "none", settings.jobError === 401 ? "authentication_required" : "not_found") });
      if (path.endsWith("/milestone")) return route.fulfill({ json: reply({ kind: "milestone_state", address: "test-milestone", internship: "test-internship", sponsor: WALLET, student: "test-student", rewardMint: "test-mint", status: "Settled", rewardAmountRaw: "300000000", slot: 100, programDeployment: "not_verified", rewardPayment: "not_established" }, "offline_fixture") });
      if (path.endsWith("/execution")) return route.fulfill({ json: reply({ kind: "execution_status", jobId: ID, phase: "confirmed", operationalExecution: "unavailable", liveTransactionId: null, rewardPayment: "not_established" }, "lifecycle_v5_offline") });
      return route.fulfill({ json: reply({ kind: "verification_job", jobId: ID, milestone: "test-milestone", state: "verification_completed", verificationOutcome: "passed", reconciliationRequired: false }, "lifecycle_v5_offline") });
    }
    // Serve the real production build at an intercepted secure test origin, not a fabricated API host.
    const relative = path === "/" ? "index.html" : path.slice(1), root = resolve("dist"), file = resolve(root, relative);
    if (!file.startsWith(root + "/")) return route.abort();
    const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
    try { return route.fulfill({ body: await readFile(file), contentType: types[extname(file)] ?? "application/octet-stream" }); } catch { return route.fulfill({ status: 404, body: "Not found" }); }
  });
  await page.goto(ORIGIN + "/#student");
  return { calls, challenge: () => challenge };
}
async function signIn(page: Page) {
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  await page.getByRole("button", { name: "Connect Phantom & sign in" }).click();
}
test("landing navigation and both role workspaces render without console errors", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto("/"); await expect(page.getByRole("heading", { level: 1 })).toContainText("Proven");
  await page.getByRole("link", { name: "Explore student workspace" }).click();
  await expect(page.getByText("Fictional records. No live Devnet data.")).toBeVisible();
  await page.getByRole("link", { name: "Organization workspace", exact: true }).click();
  await expect(page.getByRole("heading", { name: "A clearer view of the work." })).toBeVisible();
  await page.getByRole("link", { name: /Openfield Studio.*Build an open-source/ }).click();
  await expect(page.getByRole("heading", { name: "Milestone breakdown" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Settlement unavailable" })).toBeDisabled();
  expect(errors).toEqual([]);
});
test("demo navigation is responsive and makes no API requests", async ({ page }) => {
  const requests: string[] = []; page.on("request", r => { if (r.url().includes("/api/")) requests.push(r.url()); });
  await page.goto("/#student");
  await expect(page.getByRole("heading", { name: "Your work, on record." })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/workspace-${test.info().project.name}.png`, fullPage: true });
  expect(requests).toEqual([]);
});
test("API mode has a useful signed-out empty state and never invents records", async ({ page }) => {
  await page.goto("/#student"); await page.getByRole("button", { name: "Backend API", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in to read your records." })).toBeVisible();
  await expect(page.getByText("Openfield Studio")).toHaveCount(0);
});
test("missing wallet and insecure origin fail with actionable messages", async ({ page }) => {
  await page.goto("/#student"); await signIn(page);
  await expect(page.getByRole("alert")).toContainText("No supported wallet");
  await browserFixture(page); await page.goto("http://127.0.0.1:4173/#student"); await signIn(page);
  await expect(page.getByRole("alert")).toContainText("HTTPS");
});
test("wallet rejection is handled without a fabricated session", async ({ page }) => {
  const f = await browserFixture(page, { reject: true }); await signIn(page);
  await expect(page.getByRole("alert")).toContainText("cancelled or rejected"); expect(f.calls).toEqual([]);
});
test("authentication sends exact bytes and cookies then reads real contract projections", async ({ page }) => {
  const f = await browserFixture(page); await signIn(page);
  await expect(page.getByText("Authenticated API mode", { exact: true })).toBeVisible();
  const verify = f.calls.find(c => c.path.endsWith("/verify"))!;
  expect(verify.body).toEqual({ apiVersion: VERSION, cluster: "devnet", challengeId: "a".repeat(64), messageBase64: Buffer.from(f.challenge().message).toString("base64"), signatureBase64: Buffer.alloc(64).toString("base64") });
  expect(verify.cookie).toContain("__Host-proofwork_challenge=");
  expect(await page.evaluate(() => (window as any).signedMessages[0].display)).toBe("utf8");
  await page.getByLabel("Verification job ID").fill(ID); await page.getByRole("button", { name: "Load record" }).click();
  await expect(page.getByRole("heading", { name: "Milestone observation" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Reward payment not established." })).toBeVisible();
  await expect(page.getByText("offline fixture / slot 100")).toBeVisible();
  await expect(page.getByRole("button", { name: "Settlement unavailable" })).toBeDisabled();
  expect(f.calls.filter(c => c.path.startsWith("/api/v1/jobs/")).every(c => c.cookie?.includes("__Host-proofwork_session="))).toBe(true);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});
for (const scenario of ["altered", "badSignature", "challengeExpired"] as const) test(`rejects ${scenario} before proof submission`, async ({ page }) => {
  const f = await browserFixture(page, { [scenario]: true }); await signIn(page);
  await expect(page.getByRole("alert")).toBeVisible(); expect(f.calls.some(c => c.path.endsWith("/verify"))).toBe(false);
  if (scenario !== "badSignature") expect(await page.evaluate(() => (window as any).signedMessages.length)).toBe(0);
});
test("API unavailable never becomes successful authentication", async ({ page }) => {
  await browserFixture(page, { error: 503 }); await signIn(page);
  await expect(page.getByRole("alert")).toBeVisible(); await expect(page.getByText("Authenticated API mode", { exact: true })).toHaveCount(0);
});
test("loading state and unauthorized record error", async ({ page }) => {
  await browserFixture(page, { delay: 300, jobError: 404 }); await signIn(page);
  await page.getByLabel("Verification job ID").fill(ID); await page.getByRole("button", { name: "Load record" }).click();
  await expect(page.getByRole("status")).toContainText("Loading authorized");
  await expect(page.getByRole("alert")).toContainText("may not exist");
});
test("server session expiry clears private records", async ({ page }) => {
  await browserFixture(page, { jobError: 401 }); await signIn(page);
  await page.getByLabel("Verification job ID").fill(ID); await page.getByRole("button", { name: "Load record" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to read your records." })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("session expired");
});
test("local expiry and wallet changes clear session state", async ({ page }) => {
  await browserFixture(page, { expires: 1500 }); await signIn(page);
  await expect(page.getByText("Authenticated API mode", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("session expired", { timeout: 5000 });
});
test("logout revokes through API, clears records and expires browser cookie", async ({ page }) => {
  const f = await browserFixture(page); await signIn(page);
  await page.getByLabel("Verification job ID").fill(ID); await page.getByRole("button", { name: "Load record" }).click();
  await expect(page.getByRole("heading", { name: "Milestone observation" })).toBeVisible();
  await page.getByRole("button", { name: "Wallet session for " + WALLET, exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Milestone observation" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Sign in to read your records." })).toBeVisible();
  expect(f.calls.some(c => c.path.endsWith("/logout"))).toBe(true);
  expect((await page.context().cookies()).some(c => c.name === "__Host-proofwork_session")).toBe(false);
});
test("wallet disconnect during a pending read suppresses late private results", async ({ page }) => {
  await browserFixture(page, { delay: 300 }); await signIn(page);
  await page.getByLabel("Verification job ID").fill(ID); await page.getByRole("button", { name: "Load record" }).click();
  await page.evaluate(() => (window as any).changeWallet());
  await expect(page.getByRole("heading", { name: "Sign in to read your records." })).toBeVisible();
  await page.waitForTimeout(500); await expect(page.getByRole("heading", { name: "Milestone observation" })).toHaveCount(0);
});

test("network failures return a useful error without a session", async ({ page }) => {
  await browserFixture(page);
  await page.route(ORIGIN + "/api/**", route => route.abort("connectionfailed"));
  await signIn(page);
  await expect(page.getByRole("alert")).toContainText("Could not reach the API");
  await expect(page.getByText("Authenticated API mode", { exact: true })).toHaveCount(0);
});
