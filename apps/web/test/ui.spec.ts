import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";

const ORIGIN = "https://application.example.test"; // Intercepted browser-test origin only. No public deployment or TLS claim.
const WALLET = "mock-browser-wallet"; // Deliberately non-operational provider stub. No signing keys or real identity.
const ID = "11111111-1111-4111-8111-111111111111";
const VERSION = "proofwork-application-api-v1";
const reply = (data: object | null, provenance = "server_challenge", error: string | null = null) => ({ apiVersion: VERSION, cluster: "devnet", requestId: ID, data, provenance, error: error ? { code: error } : null });
type Settings = { workflowError?: number; reject?: boolean; expires?: number; altered?: boolean; badSignature?: boolean; challengeExpired?: boolean; error?: number; delay?: number; jobError?: number; logoutError?: number; invalidVerify?: boolean };
async function browserFixture(page: Page, settings: Settings & { hold?: string[]; reconciliation?: boolean } = {}) {
  const calls: { path: string; method: string; body: any; cookie?: string }[] = [];
  const gates = new Map((settings.hold ?? []).map(path => {
    let release!: () => void, seen!: () => void;
    const pending = new Promise<void>(r => { release = r; }), arrived = new Promise<void>(r => { seen = r; });
    return [path, { pending, arrived, release, seen }] as const;
  }));
  let challenge: any;
  await page.addInitScript(({ wallet, reject, badSignature }) => {
    const events: Record<string, (() => void)[]> = {}, state = window as any;
    state.mockWallet = wallet; state.signedMessages = [];
    const key = { toBase58: () => state.mockWallet };
    state.phantom = { solana: { isPhantom: true, publicKey: key,
      connect: async () => { if (reject) throw new Error("User rejected"); state.phantom.solana.publicKey = key; return { publicKey: key }; },
      disconnect: async () => { (events.disconnect ?? []).forEach(f => f()); },
      signMessage: async (bytes: Uint8Array, display: string) => { state.signedMessages.push({ bytes: Array.from(bytes), display }); return { signature: new Uint8Array(badSignature ? 65 : 64), publicKey: key }; },
      on: (event: string, fn: () => void) => { (events[event] ??= []).push(fn); },
      removeListener: (event: string, fn: () => void) => { events[event] = (events[event] ?? []).filter(f => f !== fn); },
    } };
    state.changeWallet = () => { state.mockWallet = wallet + "-changed"; state.phantom.solana.publicKey = key; (events.accountChanged ?? []).forEach(f => f()); };
  }, { wallet: WALLET, reject: settings.reject, badSignature: settings.badSignature });
  await page.route(ORIGIN + "/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path.startsWith("/api/")) {
      const method = req.method();
      calls.push({ path, method, body: req.postDataJSON(), cookie: (await req.allHeaders()).cookie });
      // UI-only response fixture. Actual authorization/builders/hashes are exercised by real HTTPS/backend tests.
      if (path === "/api/v1/workflow/review") return route.fulfill({json:reply({kind:"wallet_execution_review",state:"blocked",liveExecution:false,
        operation:req.postDataJSON().operation,wallet:WALLET,reviewId:null,messageBase64:null,messageBase58:null,lastValidBlockHeight:null,blockhash:null,observedSlot:200,expiresAt:null,feeLamports:null,rentLamports:null,
        deployment:{programExists:false,executable:false,artifactEquality:"not_established",mint:{exists:true,decimals:6,supplyRaw:"0"}},blockers:["missing_program"],rewardPayment:"not_established",provenance:"unverified_devnet_rpc"},"unverified_devnet_rpc")});
      if (path === "/api/v1/workflow/prepare") {
        if (method !== "POST") return route.fulfill({status:405,json:reply(null,"none","method_not_allowed")});
        if (settings.workflowError) return route.fulfill({status:settings.workflowError,json:reply(null,"none",settings.workflowError===401?"authentication_required":"application_unavailable")});
        const body=req.postDataJSON();
        return route.fulfill({json:reply({kind:"workflow_preparation",action:body.action,stage:"unsigned_instruction_plan",terms:body.terms,
          internship:"synthetic-internship-pda",milestone:"synthetic-milestone-pda",requirementsHash:"ab".repeat(32),evidenceHash:body.evidence?"cd".repeat(32):null,
          steps:(body.action==="organization"?["create_internship","create_milestone","fund_milestone","assign_student"]:["submit_milestone"]).map(action=>({action,feePayer:WALLET,instructions:[]})),
          accountState:"not_observed",idsReserved:false,signed:false,broadcast:false,verification:"not_run",proposalAuthority:"not_proven",rewardPayment:"not_established"},"unsigned_finance_client")});
      }
      const auth = ["/api/v1/auth/challenge", "/api/v1/auth/verify", "/api/v1/auth/logout"].includes(path);
      const job = `/api/v1/jobs/${ID}`;
      if (!(path === "/api/v1/health" || auth || [job, job + "/milestone", job + "/execution"].includes(path))) return route.fulfill({ status: 404, json: reply(null, "none", "not_found") });
      if (method !== (auth ? "POST" : "GET")) return route.fulfill({ status: 405, json: reply(null, "none", "method_not_allowed") });
      const gate = gates.get(path); if (gate) { gate.seen(); await gate.pending; }
      if (path === "/api/v1/health") return route.fulfill({ json: reply({ kind: "health", readiness: "limited", authentication: "wallet_signature_single_instance", applicationReads: "authenticated_read_routes", storage: "not_probed", chain: "not_probed", execution: "disabled" }, "process_health") });
      if (settings.error) return route.fulfill({ status: settings.error, json: reply(null, "none", "application_unavailable") });
      if (path === "/api/v1/auth/challenge") {
        const wallet = req.postDataJSON().wallet;
        const issuedAt = new Date(Date.now() - (settings.challengeExpired ? 130_000 : 0)).toISOString();
        const expiresAt = new Date(Date.parse(issuedAt) + 120_000).toISOString(), nonce = "a".repeat(64);
        const text = `application.example.test wants you to sign in with your Solana account:\n${wallet}\n\nSign in to ProofOfWork for read-only application access. No transaction or payment is authorized.\n\nURI: ${ORIGIN}\nVersion: 1\nChain ID: solana:devnet\nNonce: ${nonce}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}\nRequest ID: ${nonce}`;
        challenge = { kind: "wallet_challenge", wallet, challengeId: nonce, issuedAt, expiresAt, message: settings.altered ? text.replace("solana:devnet", "other-chain") : text, signedMessageFormat: "siws-raw-ed25519" };
        return route.fulfill({ json: reply(challenge), headers: { "set-cookie": "__Host-proofwork_challenge=test-context; Path=/; Secure; HttpOnly; SameSite=Strict" } });
      }
      if (path === "/api/v1/auth/verify") return route.fulfill({ json: reply({ kind: settings.invalidVerify ? "unsupported" : "wallet_session", wallet: challenge.wallet, origin: ORIGIN, domain: "application.example.test", cluster: "devnet", authenticationMethod: "siws-raw-ed25519", expiresAt: new Date(Date.now() + (settings.expires ?? 300_000)).toISOString() }, "wallet_signature_session"), headers: { "set-cookie": "__Host-proofwork_session=test-session; Path=/; Secure; HttpOnly; SameSite=Strict" } });
      if (path === "/api/v1/auth/logout" && settings.logoutError) return route.fulfill({ status: settings.logoutError, json: reply(null, "none", "application_unavailable") });
      if (path === "/api/v1/auth/logout") return route.fulfill({ json: reply({ kind: "wallet_logout", revoked: true }, "wallet_signature_session"), headers: { "set-cookie": "__Host-proofwork_session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0" } });
      if (settings.delay) await new Promise(r => setTimeout(r, settings.delay));
      if (settings.jobError) return route.fulfill({ status: settings.jobError, json: reply(null, "none", settings.jobError === 401 ? "authentication_required" : "not_found") });
      if (path === job + "/milestone") return route.fulfill({ json: reply({ kind: "milestone_state", address: "test-milestone", internship: "test-internship", sponsor: WALLET, student: "test-student", rewardMint: "test-mint", status: "Settled", rewardAmountRaw: "300000000", slot: 100, programDeployment: "not_verified", rewardPayment: "not_established" }, "offline_fixture") });
      if (path === job + "/execution") return route.fulfill({ json: reply({ kind: "execution_status", jobId: ID, phase: "confirmed", reconciliationRequired: settings.reconciliation ?? false, operationalExecution: "unavailable", liveTransactionId: null, rewardPayment: "not_established" }, "lifecycle_v5_offline") });
      return route.fulfill({ json: reply({ kind: "verification_job", jobId: ID, milestone: "test-milestone", state: "verification_completed", verificationOutcome: "passed", reconciliationRequired: false }, "lifecycle_v5_offline") });
    }
    const relative = path === "/" ? "index.html" : path.slice(1), root = resolve("dist"), file = resolve(root, relative);
    if (!file.startsWith(root + sep)) return route.abort();
    const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
    try { return route.fulfill({ body: await readFile(file), contentType: types[extname(file)] ?? "application/octet-stream" }); } catch { return route.fulfill({ status: 404, body: "Not found" }); }
  });
  await page.goto(ORIGIN + "/#student");
  return { calls, challenge: () => challenge, seen: (path: string) => gates.get(path)!.arrived, release: (path: string) => gates.get(path)!.release() };
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
  await browserFixture(page); await page.goto("/#student"); await signIn(page);
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
  expect(await page.evaluate(() => (window as any).signedMessages[0].bytes)).toEqual(Array.from(Buffer.from(f.challenge().message, "utf8")));
  await page.getByLabel("Verification job ID").fill(ID); await page.getByRole("button", { name: "Load record" }).click();
  await expect(page.getByRole("heading", { name: "Milestone observation" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Reward payment not established." })).toBeVisible();
  await expect(page.getByText("offline fixture / slot 100")).toBeVisible();
  await expect(page.getByRole("button", { name: "Settlement unavailable" })).toBeDisabled();
  const reads = f.calls.filter(c => c.path.startsWith("/api/v1/jobs/"));
  expect(reads.map(c => [c.method, c.path]).sort()).toEqual([`/api/v1/jobs/${ID}`, `/api/v1/jobs/${ID}/milestone`, `/api/v1/jobs/${ID}/execution`].map(path => ["GET", path]).sort());
  expect(reads.every(c => c.cookie?.includes("__Host-proofwork_session="))).toBe(true);
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
test("wallet disconnect suppresses fully delivered late private results", async ({ page }) => {
  const paths = [`/api/v1/jobs/${ID}/milestone`, `/api/v1/jobs/${ID}/execution`];
  const f = await browserFixture(page, { hold: paths }); await signIn(page);
  await page.getByLabel("Verification job ID").fill(ID); await page.getByRole("button", { name: "Load record" }).click();
  await Promise.all(paths.map(path => f.seen(path)));
  await page.evaluate(() => (window as any).changeWallet());
  await expect(page.getByRole("heading", { name: "Sign in to read your records." })).toBeVisible();
  const delivered = paths.map(path => page.waitForResponse(response => new URL(response.url()).pathname === path));
  paths.forEach(path => f.release(path)); await Promise.all((await Promise.all(delivered)).map(response => response.finished()));
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole("heading", { name: "Milestone observation" })).toHaveCount(0);
});
test("network failures return a useful error without a session", async ({ page }) => {
  await browserFixture(page);
  await page.route(ORIGIN + "/api/**", route => route.abort("connectionfailed"));
  await signIn(page);
  await expect(page.getByRole("alert")).toContainText("Could not reach the API");
  await expect(page.getByText("Authenticated API mode", { exact: true })).toHaveCount(0);
});

test("superseded verification is revoked before the next sign-in", async ({ page }) => {
  const path = "/api/v1/auth/verify", f = await browserFixture(page, { hold: [path] });
  await signIn(page); await f.seen(path);
  await page.evaluate(() => (window as any).changeWallet());
  expect(f.calls.some(c => c.path.endsWith("/logout"))).toBe(false);
  f.release(path);
  await expect(page.getByRole("button", { name: "Connect Phantom & sign in" })).toBeEnabled();
  await expect.poll(async () => (await page.context().cookies()).some(c => c.name === "__Host-proofwork_session")).toBe(false);
  await page.getByRole("button", { name: "Connect Phantom & sign in" }).click();
  await expect(page.getByText("Authenticated API mode", { exact: true })).toBeVisible();
  const endpoints = f.calls.map(c => c.path);
  expect(endpoints.indexOf("/api/v1/auth/logout")).toBeGreaterThan(endpoints.indexOf(path));
  expect(endpoints.lastIndexOf("/api/v1/auth/challenge")).toBeGreaterThan(endpoints.indexOf("/api/v1/auth/logout"));
});
test("delayed revocation cannot clear a newer login cookie", async ({ page }) => {
  const path = "/api/v1/auth/logout", f = await browserFixture(page, { hold: [path] }); await signIn(page);
  await expect(page.getByText("Authenticated API mode", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).changeWallet()); await f.seen(path);
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  await page.getByRole("button", { name: "Connect Phantom & sign in" }).click();
  expect(f.calls.filter(c => c.path.endsWith("/challenge"))).toHaveLength(1);
  f.release(path);
  await expect(page.getByRole("button", { name: "Wallet session for " + WALLET + "-changed", exact: true })).toBeVisible();
  expect((await page.context().cookies()).some(c => c.name === "__Host-proofwork_session")).toBe(true);
});
test("reconciliation disagreement is visible rather than a record-wide all-clear", async ({ page }) => {
  await browserFixture(page, { reconciliation: true }); await signIn(page);
  await page.getByLabel("Verification job ID").fill(ID); await page.getByRole("button", { name: "Load record" }).click();
  await expect(page.getByRole("status")).toContainText("Reconciliation observations disagree");
  await expect(page.getByText("Not flagged in the job observation", { exact: true })).toBeVisible();
  await expect(page.getByText("Execution reconciliation observation: Required.", { exact: true })).toBeVisible();
});
test("sample navigation after sign-in activates demo mode without losing the session", async ({ page }) => {
  await browserFixture(page); await signIn(page);
  await page.getByRole("link", { name: "How it works", exact: true }).click();
  await page.getByRole("link", { name: /1 Map the data model/ }).click();
  await expect(page.getByRole("heading", { name: "Milestone breakdown" })).toBeVisible();
  await expect(page.getByText("Demonstration mode", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Wallet session for " + WALLET, exact: true })).toBeVisible();
});
test("primary hover retains readable text and skip navigation marks its destination", async ({ page }) => {
  await page.goto("/");const link = page.getByRole("link", { name: "Explore student workspace" });
  const ink = await link.evaluate(el => getComputedStyle(el).color);await link.hover();
  expect(await link.evaluate(el => getComputedStyle(el).color)).toBe(ink);
  await page.getByRole("link", { name: "Skip to content" }).focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toHaveCSS("outline-style", "solid");
});

test("unconfirmed revocation blocks a newer proof", async ({ page }) => {
  const f = await browserFixture(page, { logoutError: 503 }); await signIn(page);
  await expect(page.getByText("Authenticated API mode", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).changeWallet());
  await expect(page.getByRole("status")).toContainText("revocation is unconfirmed");
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  await page.getByRole("button", { name: "Connect Phantom & sign in" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(f.calls.filter(c => c.path.endsWith("/challenge"))).toHaveLength(1);
  await expect(page.getByRole("heading", { name: "Sign in to read your records." })).toBeVisible();
});
test("unsupported verification response does not deny that a proof was signed and is revoked", async ({ page }) => {
  const f = await browserFixture(page, { invalidVerify: true }); await signIn(page);
  await expect(page.getByRole("alert")).toContainText("could not be confirmed");
  expect(await page.evaluate(() => (window as any).signedMessages.length)).toBe(1);
  expect(f.calls.some(c => c.path.endsWith("/logout"))).toBe(true);
  expect((await page.context().cookies()).some(c => c.name === "__Host-proofwork_session")).toBe(false);
});

async function organizationForm(page:Page) {
 await browserFixture(page);await page.getByRole("link",{name:"Organization workspace",exact:true}).click();
 await page.getByRole("button",{name:"Backend API",exact:true}).click();await signIn(page);
 await expect(page.getByRole("heading",{name:"Prepare an internship & milestone"})).toBeVisible();
 for(const [name,value] of Object.entries({title:"Fictional browser internship",student:"2".repeat(32),verifier:"3".repeat(32),internshipId:"1",milestoneId:"2",rewardAmountRaw:"1000000",assignBy:"2099-01-01T10:00",submitBy:"2099-01-02T10:00",owner:"fixture-owner",repository:"fixture-repository",manifest:'{"browser":"UI-only fixture"}'})) await page.locator(`[name="${name}"]`).fill(value);
}
test("organization prepares a clearly unsigned plan and clears it when terms change",async({page})=>{
 await organizationForm(page);await page.getByRole("button",{name:"Prepare organization instructions"}).click();
 await expect(page.getByRole("heading",{name:"Unsigned instruction plan prepared"})).toBeVisible();
 await expect(page.getByText("Verification not run. Reward payment not established.",{exact:true})).toBeVisible();
 await expect(page.getByRole("button",{name:"Sign & broadcast unavailable"})).toBeDisabled();
 await expect(page.getByRole("button",{name:"Run GitHub verification unavailable"})).toBeDisabled();
 const plan=JSON.parse(await page.getByLabel("Prepared instruction JSON").inputValue());expect(plan.steps).toHaveLength(4);expect(plan.signed).toBe(false);
 await page.locator('[name="rewardAmountRaw"]').fill("2000000");await expect(page.getByLabel("Prepared instruction JSON")).toHaveCount(0);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
for(const [name,value] of [["student","invalid-wallet"],["rewardAmountRaw","1.5"],["milestoneId","-1"]])test("organization HTML validation blocks invalid "+name,async({page})=>{
 await organizationForm(page);let sent=0;page.on("request",r=>{if(r.url().endsWith("/workflow/prepare"))sent++;});
 await page.locator(`[name="${name}"]`).fill(value);await page.getByRole("button",{name:"Prepare organization instructions"}).click();expect(sent).toBe(0);await expect(page.getByLabel("Prepared instruction JSON")).toHaveCount(0);
});
test("deadline relationship errors do not prepare a transaction",async({page})=>{
 await organizationForm(page);await page.locator('[name="assignBy"]').fill("2099-01-03T10:00");await page.getByRole("button",{name:"Prepare organization instructions"}).click();
 await expect(page.getByRole("alert")).toContainText("assignment before submission");await expect(page.getByLabel("Prepared instruction JSON")).toHaveCount(0);
});
test("student imports a proposal and prepares evidence without claiming authorization or payment",async({page})=>{
 await organizationForm(page);await page.getByRole("button",{name:"Prepare organization instructions"}).click();
 const plan=await page.getByLabel("Prepared instruction JSON").inputValue();
 await page.getByRole("link",{name:"Student workspace",exact:true}).click();
 await page.locator('[name="proposal"]').fill(plan);
 for(const [name,value] of Object.entries({contributorId:"2002",commit:"cd".repeat(20),nonce:"ef".repeat(32),pullRequest:"7"}))await page.locator(`[name="${name}"]`).fill(value);
 await page.getByRole("button",{name:"Validate evidence & prepare submission"}).click();
 await expect(page.getByRole("heading",{name:"Unsigned instruction plan prepared"})).toBeVisible();
 const prepared=JSON.parse(await page.getByLabel("Prepared instruction JSON").inputValue());expect(prepared.steps[0].action).toBe("submit_milestone");expect(prepared.rewardPayment).toBe("not_established");
 await page.getByRole("button",{name:"Wallet session for "+WALLET,exact:true}).click();
 await page.getByRole("button",{name:"Sign out",exact:true}).click();await expect(page.getByLabel("Prepared instruction JSON")).toHaveCount(0);
});
test("expired authentication rejects workflow preparation and clears private form state",async({page})=>{
 await browserFixture(page,{workflowError:401});await page.getByRole("button",{name:"Backend API",exact:true}).click();await signIn(page);
 await page.locator('[name="proposal"]').fill('{"terms":{}}');
 for(const [name,value] of Object.entries({contributorId:"1",commit:"cd".repeat(20),nonce:"ef".repeat(32),pullRequest:"1"}))await page.locator(`[name="${name}"]`).fill(value);
 await page.getByRole("button",{name:"Validate evidence & prepare submission"}).click();
 await expect(page.getByRole("heading",{name:"Sign in to read your records."})).toBeVisible();await expect(page.locator('[name="nonce"]')).toHaveCount(0);
});

test("fresh Devnet review exposes missing deployment and cannot invoke wallet or broadcast",async({page})=>{
 await organizationForm(page);await page.getByRole("button",{name:"Prepare organization instructions"}).click();
 const signedBefore=await page.evaluate(()=>(window as any).signedMessages.length);
 await page.getByRole("button",{name:"create internship — review",exact:true}).click();
 await expect(page.getByRole("heading",{name:"Execution blocked"})).toBeVisible();await expect(page.getByText("missing program",{exact:true})).toBeVisible();
 await expect(page.getByRole("button",{name:"Approve transaction in wallet — disabled"})).toBeDisabled();await expect(page.getByRole("button",{name:"Broadcast signed transaction — disabled"})).toBeDisabled();
 expect(await page.evaluate(()=>(window as any).signedMessages.length)).toBe(signedBefore);
 await expect(page.getByText("Program exists: false.",{exact:false})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
