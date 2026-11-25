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


## Internship-to-student preparation workflow

In **Backend API** mode, sign in and open the organization workspace. Fill the internship note, intended student and independent verifier wallets, coordinator-reserved IDs, positive **raw integer DEMO units** (6 decimals), future assignment/submission UTC cutoffs, GitHub owner/repository and the **exact approved compact manifest**. The existing verifier accepts sum-v1/sum-v2 only: arbitrary prose is not executable requirements. No image digest, test digest, repo ID or verifier is supplied by a fabricated default. See the existing manifest parser for its pinned test schema.

Choose **Prepare organization instructions**. The authenticated sponsor is the signer and proposed owner; the existing finance client creates four ordered unsigned instruction steps: create internship, create milestone, fund milestone, assign student. Review/copy the resulting JSON and share its proposed terms with the intended student off-chain. The title/note and GitHub name are local proposal metadata, not new on-chain fields or authenticated repository claims; only the exact manifest is hashed into the requirements commitment. Nothing is persisted by the preparation endpoint. Reserve IDs through the existing coordinator process; this form does not allocate or promise uniqueness. Funding requires the existing canonical sponsor DEMO ATA, sufficient tokens and rent; student consent/vetting remain off-chain.

The intended student signs in to the student workspace, imports that JSON and enters an immutable contributor ID, exact 40-lowercase-hex SHA-1 commit, positive PR number and private 32-byte evidence nonce encoded as 64 lowercase hex. **Retain the manifest and evidence preimage privately** for the designated verifier; neither this form nor the response persists them. No token/key belongs in these fields. Preparation computes the existing domain-separated evidence digest and uses the existing submit builder. It does not authenticate GitHub identity or establish that an assignment exists. Imported terms are untrusted proposals, even if the JSON says otherwise. The existing authorized record reader remains the source of stored job/chain observations; it cannot list assignments without a coordinator-provided job ID.

`POST /api/v1/workflow/prepare` is available only through the explicit wallet application composition. It uses the existing version/Devnet JSON envelope, exact Host/Origin, same-origin fetch context, body/capacity limits and verified cookie session. Requests are `{apiVersion,cluster,action,terms}` for `organization`, or the same plus `{evidence:{contributorId,commit,nonce,pullRequest}}` for `submission`. `terms` has exactly `{title,note,sponsor,student,verifier,internshipId,milestoneId,rewardAmountRaw,assignBy,submitBy,owner,repository,manifest}`; IDs, amounts and timestamps are decimal strings. Sponsor/student identity must equal the current server session for its respective action. The server rechecks expiry after reading the body. The response provenance is `unsigned_finance_client`; accountState is `not_observed`, proposalAuthority `not_proven`, idsReserved/signed/broadcast false, verification `not_run`, rewardPayment `not_established`. No recent blockhash is invented: the result contains actual ordered instruction accounts/data and fee payer, not a signable or submitted transaction.

Duplicate preparations are deterministic and have **no persistent effect**, not proof a duplicate on-chain submission is allowed. Existing on-chain init/status/deadline gates prohibit replay and the one submission cannot be replaced. The UI clears preparations when inputs, wallet, role, authentication or data-source context change. It stores no evidence, tokens or credentials in browser storage.

**Disabled in production:** signing/broadcast, persistent listing/ID allocation, verifier dispatch/job creation, attestation and settlement execution. The job-creating `POST /api/v1/workflow/dispatch` handler is implemented only for explicitly injected offline fixture composition; the production CLI does not compose its dispatcher and returns unavailable. No second lifecycle state machine is introduced. Existing `/verify` still independently requires GitHub authentication, exact confirmed account commitments and its trusted isolated runner; wallet cookies cannot authorize it and it rejects browser Origin headers. Enabling a later operational journey needs separately approved signing/broadcast integration, validated deployed Devnet program/mint/account evidence, explicit transaction authorization, an approved durable ID/metadata/consent workflow, and independent GitHub/runner configuration. Existing settlement observations remain conditional and never prove payout by themselves.


## Wallet execution review — live execution remains disabled

After unsigned preparation, **Review fresh Devnet state** reviews one operation at a time using the existing finance client. Settlement may include atomic destination-provisioning instructions in the same reviewed transaction. Keep the existing HTTPS setup; `APP_CHAIN_READS=devnet` opts into the read-only reviewer. First run the existing keyless pinned SBF build so the local artifact can be compared. No new RPC, mint, wallet, program ID or runtime enable secret is required or accepted. Missing configuration/artifact/deployment fails closed. To repeat the public read-only deployment audit explicitly, run `npm --prefix services/verifier run audit:devnet`. It never loads a wallet or sends transactions. The audit is not part of offline CI and is not run automatically on startup.

The new session-bound POST routes are `/api/v1/workflow/review` (`{apiVersion,cluster,operation,workflow}`), `/revalidate` under the same workflow prefix (`{apiVersion,cluster,reviewId}`), `/validate` and `/confirm` (`{apiVersion,cluster,reviewId,wireBase64}`). `workflow` is the existing complete preparation request for create_internship, create_milestone, fund_milestone, assign_student and submit_milestone. For settle_milestone it is the scope-only `{apiVersion,cluster,sponsor,internshipId,milestoneId}`; terms and destinations are freshly derived/validated from chain state. Neither format accepts caller-supplied instruction bytes. `/api/v1/workflow/broadcast` always returns `live_execution_disabled` without a sender or RPC call. All routes retain exact-origin, session, capacity and body checks. Session expiry is rechecked after RPC work. Review IDs are random, wallet-bound, bounded in-memory caches, not durable authorizations; signing reviews expire after 20 seconds and confirmation correlation is retained for at most ten minutes. Server restart or expired correlation requires reconciliation; it is not permission to retry.

Deployment review checks the approved Devnet genesis, executable program/upgradeable-loader owner, canonical ProgramData pointer, loader state and slot, authority metadata, and exact code bytes against the local reviewed artifact with only zero allocation padding accepted. Mutable upgrade authorities are blocked because no approved authority policy is recorded; `null` authority with an absent program means **not observed**, not proof of immutability. Artifact equality is reported only as matching **RPC-reported bytes**, not independent chain/source verification. The DEMO mint must be initialized classic SPL, 6 decimals, no freeze authority and match the approval record's public mint authority. The provenance remains unverified_devnet_rpc.

Per-operation review reuses existing strict lifecycle decoders and builders. It derives canonical PDAs; compares sponsor, student, verifier, IDs, requirements hash, exact reward and deadlines; checks relevant absence/state gates; uses observed chain block time; validates the payer's system account, rent and fee balance; and validates canonical funding ATA/current authority and escrow ownership/mint/state/backing. Funding source checks conservatively reject delegates/independent close authority. No token accounts are created implicitly. The reviewer issues one exact single-signer message with a fresh context-bound Devnet blockhash, checks height/validity and fee/rent, and never trusts imported instruction JSON. Revalidation checks fresh deployment/accounts/deadlines/fee/blockhash without substituting the reviewed message. Invalid or stale review requires a new explicit review action, not auto-signing.

The wallet controller separates Prepared, Ready for review, Awaiting wallet approval, Signed awaiting broadcast, Submitted, Confirming, Confirmed, Failed and Unknown/requires reconciliation. The real Phantom adapter uses its documented traditional **signTransaction request** (serialized message), never transaction bytes passed to signMessage and never wallet-controlled automatic sending. This legacy Phantom capability must be verified in the actual supported browser before a rehearsal; no real Phantom session is claimed. See [Phantom's official signing documentation](https://docs.phantom.com/solana/sending-a-transaction). The UI controller's production mode and the adapter's literal signing gate are disabled, and both explicit buttons are disabled. Offline test ports are not live permission; no existing operational simulation/ticket grants authority. The only helper reused from that module is its pure base58 encoder.

Signed-wire validation requires the exact reviewed message, sole required signer, canonical full transaction encoding and valid Ed25519 signature. A separate explicit broadcast action exists in the controller but its production transport is a hard denial. Unknown sends consume the attempt; there is no automatic retry. Confirmation requires matching Devnet signature status, exact confirmed transaction bytes/message and slot, and decoded instruction-specific account postconditions (including exact funding source debit). A submitted signature alone is insufficient. Missing/corrupt account data or unavailable RPC remains Unknown, not Confirmed. Only a correlated confirmed transaction receives a Devnet Explorer URL. Payment remains not_established for all five operations.

**Observed read-only audit, 2026-11-19:** the official Devnet RPC reported the expected genesis and the configured program account absent. Deployment, executable bytecode equality and upgrade authority therefore remain **not established**. The approved DEMO mint existed under classic SPL, decimals 6, approved authority, no freeze authority and raw supply 0. Its authority's derived canonical DEMO ATA was absent. A separate largest-token-account request failed; no complete token-account inventory is claimed. Public raw observations are retained outside Git; no deployment, signing, broadcast, token movement or minting occurred.

A controlled live follow-up requires explicit authorization, verified deployment of the reviewed artifact, recorded deployment/upgrade policy, actual sponsor/student wallets and consent, existing correctly owned DEMO ATA/token balances and rent, approved reserved IDs and manifests, and a separately reviewed change enabling wallet approval plus a fixed-Devnet transport with preflight/maxRetries:0. No environment/browser flag in this PR enables it. Independent GitHub authentication, exact confirmed evidence bindings, trusted pinned isolated runner and designated verifier authorization are still required after submission. Browser cookies never replace those controls; verifier keys stay out of the browser. Attestation and settlement execution remain inactive and require their own approved signer/transport/reconciliation path.


## Browser workflow observations and private verification handoff

In authenticated Backend API mode, organization and student workspaces now
include **Read the actual milestone**. Enter the recorded sponsor and explicit
internship/milestone IDs, or prepare a proposal to populate these fields. Refresh
queries canonical accounts through the existing fixed-Devnet read-only RPC and
existing lifecycle decoders. Actual sponsor/student bindings authorize reads;
imported JSON and the selected workspace do not establish assignment or authority.
Absence/collision results are slot-specific observations, not ID reservations.
Continue coordinating increasing IDs before creation. No public allocation or
listing endpoint is introduced.

`POST /api/v1/workflow/state` takes exactly
`{apiVersion,cluster,sponsor,internshipId,milestoneId}`. It shares the existing
HTTPS/Host/Origin, session, body/capacity and post-await expiry checks. It reports
Created/Funded/Assigned/Submitted/Verified/Settled/Refunded snapshots, commitments,
raw escrow backing and completion/vault observations. `APP_CHAIN_READS=devnet`
opts into the reader; otherwise it fails unavailable. Production provenance is
`unverified_devnet_rpc`, with `persisted:false` and `rewardPayment:not_established`.
A confirmed RPC context is not transaction correlation, independent chain proof,
a successful GitHub verification or proof of exact student payment. Prefunded
empty system accounts do not count as initialized submissions/completions.

For students, the existing preparation fills a **private** verifier request from
the same manifest/evidence preimage. Alternatively paste a privately retained
request after refresh. **Validate private verifier handoff** is enabled only for
a currently observed Submitted milestone recorded for that wallet. The server
freshly validates the student, manifest and evidence commitments through
`POST /api/v1/workflow/verification`, taking the state target plus `evidence` in
the existing verifier `Request` format. The response reports authorization not granted and no persistence. Dispatch is
unavailable in production. Only explicit offline fixture composition can report
contributor admission required and provide the separate test-only dispatch route. Never publish this
request: it contains the evidence nonce. No GitHub token belongs in these forms;
unknown credential fields are rejected. The existing `/verify` retains its
independent GitHub authentication, origin rejection, state rechecks and isolated
runner requirements. Wallet login grants no permission to dispatch it.

Transaction review continues to use the existing builders/reviewer/controller.
The UI observes actual controller stages; it does not optimistically label a
preflight as Submitted. Wallet ownership and review expiry are checked again
after awaited signed-wire validation. Production wallet signing and broadcasting
remain hard-disabled, including the backend broadcast denial. Offline doubles
are test-only; no runtime/browser flag activates production execution.

Scope snapshots are transient reads, not a second state machine/database or a
successful job writer. Durable operational ingestion remains blocked on approval
of the trusted ingestion actor, transaction/account evidence and finality policy,
retention/privacy and recovery rules, plus any necessary reviewed schema change.
Trusted verifier dispatch still needs approved credential custody and caller
admission distinct from the wallet session. Those specific paths are not enabled
in production. An unsigned proposal alone never creates a lifecycle job. Only
explicit offline composition can admit a validated actual Submitted fixture and
create the existing coordinator job; its stored rows are not live authorization.

## One-lifecycle verifier admission and settlement review

The candidate prepares admission of ONE chain-validated Submitted commitment to
the existing verifier and v5 job store. This is an explicit backend configuration,
not authority conferred by wallet login. Live verifier dispatch is hard-disabled (`LIVE_VERIFIER_DISPATCH=false`); the
production CLI rejects dispatch configuration. Only isolated tests compose the
adapter with explicit fixtures. A later separately approved activation would need
`APP_CHAIN_READS=devnet` and all five independently approved settings below:

- `APP_GITHUB_USER_TOKEN_FILE`: absolute path outside Git to an existing contributor
  credential file, owned by the server user and readable only by that user (0600).
  Symlinks are rejected. Never send its contents through the browser, chat or logs.
- `APP_VERIFICATION_MILESTONE`: exact existing Submitted milestone PDA.
- `APP_VERIFICATION_REPOSITORY_ID`: approved numeric GitHub repository ID.
- `APP_VERIFICATION_CONTRIBUTOR_ID`: independently authenticated contributor ID.
- `APP_VERIFICATION_COMMIT`: exact approved 40-character lowercase commit SHA.

The existing `VERIFIER_PUBLIC_KEY`, `SOLANA_RPC_URL` and `TRUSTED_RUNNER_IMAGE`
configuration still applies. GitHub authenticates the contributor against the
recorded evidence; the same `VerifierService`, source checks and isolated
`DockerRunner` run the agreed manifest. This change supplies no credentials,
approved repository, runner image, signer or production configuration.

The authenticated student first refreshes the actual Submitted scope, validates
the private handoff, then explicitly requests independent verification. The new
`POST /api/v1/workflow/dispatch` accepts exactly the handoff input, never a GitHub
token or claimed verification result. Admission and session checks precede job
creation. Public bindings alone enter the existing job tables; manifest bytes,
nonce, source and credentials do not. The response contains a job ID for the
existing authenticated job read route. Prepared, running, rejected and uncertain
jobs are not automatically rerun, including after a dispatcher restart. Existing
trusted job recovery/fencing remains authoritative.

Passing verification is NOT operational attestation authorization. Offline dispatch
runs the existing `DurableOfflineCoordinator`, including its fresh `AttestationAuthorizer`,
exact-message policy, worker fences and mock receipt. It does not leave a separate
completed-job path that the coordinator cannot resume. The browser/runtime test
signs that original process-local mock message with separate fixture payer and
verifier keys; no stored row or HTTP JSON is promoted to authority. The signing/custody,
operational journal and action admission gates are unchanged.

For an observed Verified milestone the frontend offers `settle milestone — review`.
The existing wallet reviewer uses the actual `prepareSettlementTransaction` client,
retains canonical student destination and Policy v2 sponsor destination validation,
and includes atomic fallback provisioning in the exact reviewed message and rent.
The application restricts private scope reads to the recorded sponsor/student;
the on-chain instruction remains permissionless with its original ABI.

Settlement confirmation requires the exact signed wire at a confirmed slot,
canonical transaction token-balance metadata, exact reward/surplus deltas, vault
closure/rent return and a freshly decoded matching completion record. Only that
correlation may say `exact_reward_confirmed`. It describes the transaction's raw
post-balances, not a guarantee that the student has not spent tokens afterward.
Missing, failed, processed-only or inconsistent evidence remains Unknown/Failed,
never authorizes retry, and cannot promote a transient Settled observation to paid.

Live Phantom signing and broadcasting remain disabled in both browser and backend.
No configuration above enables live verifier dispatch or a blockchain write. No new database schema, Rust
layout, instruction ABI, mint, destination policy or dependency lock is introduced.

Infrastructure outages (including unavailable/rate-limited GitHub or runner) enter
existing recovery bookkeeping, not permanent verification rejection. Dispatch does
not automatically retry them. Graceful application shutdown stops accepting HTTP
requests, drains admitted verifier tasks, then closes SQLite. A forced process kill
still requires the existing trusted interrupted-job recovery procedure.
Transaction-local balances, rather than a stale review balance, establish receipt
deltas; unrelated credits and unsolicited vault surplus/rent do not invalidate an
otherwise exact payment. Actual fees and rent must stay within the reviewed costs.

Offline preparation progresses the same existing job to `authorization_pending`
only through the durable coordinator's fresh verifier and one-use message policy.
Its local mock receipt carries `signingAuthorization: not_granted`; no historical
row, serialized receipt, browser request or environment flag is live authority.
The adapter rejects production RPC provenance and accepts only explicit offline
fixture composition. Live dispatch has no production factory in this candidate.
