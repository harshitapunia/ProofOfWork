# ProofOfWork frontend

React + TypeScript + esbuild. Run with Node 24 (CI pins 24.14.1).

```sh
cd apps/web
npm ci --ignore-scripts
npm run dev
npm run check
npm run build
npm run test:unit
npx --no-install playwright install chromium
npm test
```

The development server binds loopback only. `npm run preview` serves the production build locally. Browser binaries are test tooling; no wallets, keys or credentials are required. Playwright tests run desktop and mobile Chromium; the mobile project emulates an iPhone viewport, not WebKit or an actual device. `dist/`, browser traces and screenshots are ignored.

## What works

- Landing page, student workspace, organization workspace and internship detail view.
- Clearly labeled fictional demonstration mode, usable without a server or wallet. The source of every sample is `src/demo.ts`. No fixture is a live Devnet record, balance, payout, identity or claimed user.
- Backend API mode: authenticated reads of a coordinator-supplied job UUID using the actual `/api/v1/jobs/:jobId`, `/milestone` and `/execution` routes. No listing API exists. There is no title, organization directory or GitHub evidence URL in these projections; the UI does not invent them. Raw token units are shown without assuming mint decimals.
- Phantom injected provider: `connect`, exact UTF-8 `signMessage(bytes, "utf8")`, base64 signature proof and secure-cookie session. The browser validates the fixed Devnet/read-only context and supported raw 64-byte format; the server independently verifies ownership and authorization. No `signIn` reconstruction, OCMS or transaction-signing fallback.
- Loading, empty, unavailable, unknown/unauthorized record, rejected wallet, expired proof/session, logout, account change and disconnect states. Private records are cleared on session invalidation; late reads are suppressed. No session token or private record is persisted in browser storage. Refresh deliberately requires sign-in again because no session-introspection endpoint exists.

The integration follows Phantom's [raw message API](https://github.com/phantom/docs/blob/master/getting-started-with-solana/signing-a-message.md). Test provider stubs return dummy bytes; browser tests validate transport/UI behavior, **not real wallet cryptography**. Existing verifier tests independently exercise real Ed25519 verification. Test-only reserved HTTPS origins are intercepted inside Playwright, not deployed TLS endpoints.

## Real authentication configuration

No operational configuration, program ID, mint, wallet address or RPC is introduced here. API requests are always relative, with `credentials: same-origin`, no-store and redirect rejection. No development API proxy is provided: a convenient cross-origin proxy would conflict with the backend's exact Host/Origin policy.

HTTP localhost serves demonstration mode. Real login requires a separately approved **same-origin HTTPS** deployment serving these assets and the existing explicit `WalletApplicationHttp` composition. The configured backend origin and domain must match the browser exactly. Its `Secure; HttpOnly; SameSite=Strict; Path=/` cookies remain unchanged. Do not forward untrusted Host/proto headers or add wildcard CORS. The default backend CLI does not register wallet/read routes; this PR does not change it or enable public listeners.

Before a complete Devnet demo, Harshita must supply/approve the origin, TLS/hosting and trusted single-instance composition with actual authorized job IDs and the existing chain reader configuration. Review the backend's [activation blockers](../../docs/WALLET_AUTHENTICATED_APPLICATION_API.md). Real Phantom/device compatibility and same-origin TLS/cookie behavior need validation in that approved environment. No live wallet or external RPC was exercised by offline tests.

## Deliberately unavailable

Creation, assignment, GitHub submission, funding, settlement and refunds are disabled: serializers exist in `packages/finance-client`, but this PR has no reviewed write integration. No transaction signing/sending, minting, balances or transfers. DEMO is never labeled USDC. A `Verified` or `Settled` observation is not proof of reward payment; even the API explicitly returns `rewardPayment: not_established` and `programDeployment: not_verified`. Observations retain `offline_fixture`, `lifecycle_v5_offline` or unverified RPC provenance.

Workspace navigation chooses a presentation, not an authorized role. The server checks the recorded sponsor/student wallet for every read. The UI is not an authorization boundary. Logout is confirmed only after the POST succeeds; on failure the UI clears private state and warns that server revocation is unconfirmed. Wallet disconnect revocation is best effort; server expiry remains authoritative. A compromised same-origin script/provider is outside the browser client's trust boundary.

## Design and dependencies

Hallmark 2.0.0, reviewed source commit `04977e15f3dfd6ee4b74c887dac3eb52665d6c92`, informed the light paper surfaces, typography, constrained accent and product-led ledger. Its source was inspected outside the app; no installer, runtime script or third-party skill code is shipped. Coral was chosen from one three-theme deal, adapted to a restrained green signal and dense application layout. Native typography avoids remote font requests. `DESIGN.md` records adaptations and verification.

Only React/React DOM are runtime dependencies. esbuild, TypeScript, React types and Playwright are pinned development dependencies. All installs use `--ignore-scripts`; lockfile and audit checks are required. The existing strict Node gate also scans this package with no frontend exceptions. Never run automatic audit fixes or weaken the retained root SDK policy.

Vite 8.3.8 was evaluated but its glob dependency stack reported four high-severity findings from Picomatch. It was removed before publication rather than waived or downgraded to an obsolete Vite. The small Node development server serves explicit built assets on loopback only; it has no auth proxy, TLS bypass or operational backend. Reload the browser after edits.
