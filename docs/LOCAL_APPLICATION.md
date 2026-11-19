# Run ProofOfWork as one local HTTPS application

This entry point serves the existing frontend production build and existing verifier,
wallet-authentication and application-read handlers on **one loopback HTTPS listener**.
It is a local hackathon composition, not authorization for public deployment.
The original `npm --prefix services/verifier start` CLI is unchanged.

## Install and build

Node 24 is required (CI uses 24.14.1). From the repository root:

```sh
npm --prefix packages/finance-client ci --ignore-scripts
npm --prefix services/lifecycle ci --ignore-scripts
npm --prefix services/verifier ci --ignore-scripts
npm --prefix apps/web ci --ignore-scripts
npm --prefix services/verifier run build:application
```

## Explicit local configuration

Copy the blank `services/verifier/.env.example` to the gitignored
`services/verifier/.env.local` and configure these values locally. Do not send
credentials in chat or commit the filled file.

| Variable | Exact requirement |
| --- | --- |
| `APP_ORIGIN` | Canonical `https://localhost:<chosen-port>` or `https://127.0.0.1:<chosen-port>`, port 1024–65535. No path, credentials, query or fragment. The actual value is your explicit local configuration, not an invented public domain. |
| `APP_TLS_CERT_FILE` | Absolute path to an existing PEM certificate/chain trusted by the browser you will use. Its SAN must cover the selected hostname. |
| `APP_TLS_KEY_FILE` | Absolute path to its matching TLS server private key, kept outside source control. This is a TLS file, **not a wallet key**. |
| `APP_LIFECYCLE_DB` | Absolute path to an existing regular, non-symlink lifecycle SQLite file. The existing LifecycleStore validates/opens it using its existing schema/migration rules. No jobs, wallets or chain records are seeded by this CLI. Coordinate use with existing workers; back up real data before upgrades. |
| `APP_CHAIN_READS` | `off` (default) or `devnet`. Off serves real stored job/execution reads while milestone chain reads return unavailable. Devnet uses the existing DevnetLifecycleReader and its approved fixed endpoint/genesis and decoders; provenance remains `unverified_devnet_rpc`. No RPC is contacted on startup. |
| `APP_WEB_DIST` | Optional absolute directory of the existing frontend production assets; defaults to this checkout's `apps/web/dist`. Build first. |

A genuinely browser-trusted certificate and matching key are required for real
Phantom use. Provision them with your trusted local certificate tooling/policy
outside the repository. This PR does not generate/install a CA, select a public
hosting domain, disable TLS verification, weaken cookies, or deploy anything.
Do not use certificate-error bypass flags. A bare untrusted self-signed certificate
is not a substitute for browser trust.

After configuration, start the whole application with **one command**:

```sh
npm --prefix services/verifier run start:application
```

Open the configured `APP_ORIGIN` printed at startup. The server always binds
`127.0.0.1`; there is no public-host environment option, HTTP fallback or proxy.
When using `localhost`, ensure it resolves to loopback IPv4 on your machine.
No second frontend development server is needed. Static assets are loaded from
the checked build at startup; rebuild and restart to change them.

## Actual application flow

Open the landing page, select a workspace, choose **Backend API**, and inspect
the real public health result (limited readiness; storage/chain not probed).
Connect an existing Phantom wallet and approve the exact server-provided
read-only Devnet message. No transaction or payment is authorized. The existing
backend verifies strict raw Ed25519; no signIn reconstruction, OCMS, hardware
transaction fallback or signing workaround is introduced.

Same-origin requests retain the secure requester/session cookies, exact Host and
Origin checks, HttpOnly, Secure, SameSite=Strict, replay protection and expiry.
Supply a real job UUID from your coordinator: the wallet must match that job's
recorded sponsor/student. The UI calls the existing job, milestone and execution
routes and displays their real provenance and reconciliation observations.
Unrelated wallets and unknown jobs remain indistinguishable 404s. No listing API
exists. Signing in does not create a job or prove a global organization/student role.

Sign out to revoke the server session and expire its cookie. Existing browser
cookie-operation serialization, expiry, disconnected-wallet and stale-result
handling remain. Sessions/challenges are in memory in one instance; restart
invalidates sessions. No persistent/distributed or cross-tab coordination is
claimed. The original CLI's private routes are still unregistered.

The legacy `POST /verify` keeps its independent GitHub bearer authentication,
browser-Origin rejection, service and sandbox validation. Its existing
`SOLANA_RPC_URL`, `VERIFIER_PUBLIC_KEY` and `TRUSTED_RUNNER_IMAGE` requirements
remain unchanged; do not invent those values. The new frontend does not call
that route or acquire verification/transaction authority through wallet login.

Frontend demonstration mode remains isolated, fictional and clearly labeled.
Real API mode never loads a fixture ledger. No payment is claimed from a
Verified/Settled status or offline execution observation. Funding, submission,
settlement, refunds, token minting and transaction sending remain unavailable.
DEMO tokens are non-monetary, never USDC. Operational chain execution and public
deployment remain separate approvals/work, not features activated by this entry point.

## Tests and limits

```sh
npm --prefix services/verifier run test:application
```

This builds the actual frontend/backend and runs **real HTTPS requests** through
the same application/verifier/wallet/query handlers. It uses the existing valid
v5 wallet-ledger fixture and real account decoders, labeled `offline_fixture`.
Disposable Ed25519 and TLS test keys stay in memory; an anonymous pipe supplies
the TLS test key to OpenSSL. Linux/Bash/OpenSSL are needed for this helper.
The test client explicitly trusts only the ephemeral test certificate and still
performs normal hostname/certificate verification; a negative test rejects an
untrusted certificate. No private-key fixtures, key files, real wallets, external
RPCs or blockchain transactions are used. These tests are not a real Phantom or
browser-trusted TLS demonstration.

Coverage includes asset delivery, health, cryptographic login and replay, secure
cookie attributes, sponsor/student access, unrelated-wallet denial, expiry,
logout, Host/Origin/proxy guards, safe static paths, backend errors and absent
chain data. Existing frontend tests continue to use explicit wallet/API stubs;
the new suite supplies the real transport/handler/cryptography integration.

For the complete existing regressions, use the frontend instructions and
backend CI commands. All dependency/security gates remain active. No shared
Rust ABI, PDA, account layout, financial policy or lifecycle migration is changed.

## Remaining real-demo requirements

Harshita must supply/approve trusted local TLS files, the exact origin, a genuine
existing ledger with authorized job IDs and any existing optional verifier/read
configuration. Then exercise an actual Phantom/browser session on that trusted
origin. No real Phantom session, public deployment, live payment or complete
Devnet execution is claimed by the offline tests. Public hosting, edge controls,
multi-instance sessions and operational custody remain outside this local PR.
