# ProofOfWork

ProofOfWork is a Devnet prototype for fictional internships, verified work and
non-monetary DEMO-token rewards. Private evidence, identity information and
credentials stay off-chain.

## Implemented

The Anchor program exposes eight instructions: create_internship,
create_milestone, fund_milestone, assign_student, submit_milestone,
attest_milestone, settle_milestone and refund_unclaimed_milestone.

Dedicated milestone escrow enforces exact funding, authorized verification,
Settlement Destination Policy v2, sponsor surplus/rent return, secure unclaimed
refunds and atomic completion records. Funding/refunds retain canonical sponsor
ATA policies; settlement permits a validated sponsor-owned classic token
destination and the finance client can provision it atomically.

The finance client supplies unsigned creation, funding and settlement builders.
The GitHub verifier binds repository/contributor IDs, commit and evidence
commitments, executes pinned acceptance suites in restricted Docker workers,
and prepares unsigned attestations. Authorization/message-policy and recovery
models exist, but operational signing and submission remain disabled.

Local SBF/LiteSVM tests exercise token CPIs, rollback and actual TypeScript
transactions. The dependency compatibility suite validates the scoped Jayson 5
override without migrating the legacy Web3 API.

## Validation and setup

Use Linux, Node 24.14.1 and the pinned Rust/Cargo 1.98.1. Each Node package has
its own locked installation; run npm ci --ignore-scripts at its installation root.
Root Node tooling is retained for optional Anchor SDK/formatting compatibility,
not as an application backend or a source of child-package dependencies.

[Backend CI](docs/BACKEND_CI.md) documents the six independent GitHub Actions
jobs, security thresholds, exact tool downloads, root findings and maintenance
reviews. CI runs on pull requests, main pushes and manual dispatch. Actual run
results are authoritative; historical counts are not a promise of future passes.

For local native checks:

    cargo fmt --all --check
    cargo check --workspace --all-targets --locked
    cargo test --workspace --locked

See [runtime reproduction](tests/runtime/README.md) for the direct keyless SBF
build with verified platform-tools v1.57 and Solana CLI 4.1.2. Normal Anchor build
wrappers can generate deployment identities; do not use them in this validation.

## Remaining work and boundaries

Durable offline jobs, intents, execution histories and restart inspection are
implemented. [Devnet execution readiness](docs/DEVNET_EXECUTION_READINESS.md)
correlates their evidence with existing protocol checks and reports NOT READY:
authenticated custody, operational admission, external fencing, controlled first
submission and authenticated live reconciliation remain blocked. Complete application
API/frontend integration also remains. Local VM tests do not establish Devnet
feature parity or complete backend automation. This phase performs no deployment.

The approved MVP allows one submission and no disputes or automatic timeout
payout. Timely unverified work can remain locked indefinitely. A completion record
establishes the agreed checks and provenance, not universal skill or employment.

The [approved specification](docs/CONTRACT_SPEC.md), including its v2 amendment,
is authoritative. [Team workflow](docs/TEAM_WORKFLOW.md) records ownership:
Harshita owns creation/funding, clients, verification and coordination; Palak owns
settlement/refunds/completion; Ganga owns the frontend. Shared ABI changes require
joint review. Program/mint identities are in [shared foundation](docs/SHARED_FOUNDATION.md)
and [team approval](docs/TEAM_APPROVAL.md).

No Mainnet, real funds, production signer activation or deployment is authorized
by validation. Dependency findings and accepted maintenance debt remain visible;
the repository is not claimed vulnerability-free.

The [operational journal foundation](docs/OPERATIONAL_JOURNAL_FOUNDATION.md) adds a pure admission/event model with evidence-bound replay. It does not persist operational records or activate signing/sending; its proposed schema requires separate approval.

The [application API foundation](docs/APPLICATION_API_FOUNDATION.md) adds public process health and authorized internal job, milestone and offline-execution projections. Private HTTP routes remain unregistered pending approved application authentication; operational execution stays disabled.

The [wallet-authenticated application API](docs/WALLET_AUTHENTICATED_APPLICATION_API.md) implements SIWS challenges, short-lived secure-cookie sessions and authorized read routes in explicit single-instance composition. The default CLI keeps private routes disabled; public deployment and the authentication protocol still require approval.


## Hackathon frontend

The React/TypeScript app lives in [apps/web](apps/web/README.md). With Node 24,
run `npm --prefix apps/web ci --ignore-scripts`, then `npm --prefix apps/web run dev`
and open the printed loopback URL. Demonstration mode uses explicitly fictional
records. API mode uses the existing wallet-authenticated reads and requires the
separately approved same-origin HTTPS composition; no write/transaction actions
or backend activation changes are included. See the frontend README for build,
checks, browser tests and remaining real-Devnet-demo configuration.


## One local HTTPS application

The frontend and real wallet/read APIs can now run on one loopback HTTPS listener.
See [local application instructions](docs/LOCAL_APPLICATION.md) for explicit trusted TLS/database configuration, install/build commands and real HTTPS integration tests. After configuration, start everything with `npm --prefix services/verifier run start:application`. The original verifier CLI remains unchanged; no records are seeded or transactions enabled.
