# ProofOfWork finance client

Merged creation, funding and Settlement Destination Policy v2 support remains
unsigned: this package does not handle private keys, sign, send, deploy or
generate wallets.

## Exports and settlement

Creation/funding builders and canonical internship, milestone, vault and authority
derivations remain available. Settlement adds settleMilestoneInstruction,
deriveSubmission, deriveCompletion, deriveStudentAta,
deriveSponsorFallbackDestination and prepareSettlementTransaction.

The preparation API validates approved Devnet endpoint/genesis, program account
ownership/layouts, PDAs and stored bindings, Verified state, timing, mint/vault
custody/backing, student canonical destination and completion collisions.

It prefers a healthy canonical sponsor ATA, otherwise an explicit initialized
sponsor-owned classic token account, or a public caller-scoped seeded fallback.
An absent destination is created and initialized with sponsor authority in the
same transaction as settlement. A prefunded System-owned zero-data address is
topped up if necessary and allocated/initialized atomically. Foreign, executable,
occupied or unsuitable destinations fail closed. Never split these instructions.

The application must durably reserve IDs/fallback seeds, supply a fresh verified
Devnet blockhash, retain the complete transaction and obtain the caller's signature.
On-chain checks remain authoritative. Stale observations or concurrent address
use require refresh/re-preparation, not blind replacement of signed bytes.

Funding and refund contracts retain canonical sponsor ATA policies. A reusable
refund builder and assignment/submission production clients remain integration
work. The verifier already contains an internal attestation builder.

## Dependency and validation boundary

Use this package's npm ci --ignore-scripts. Web3 stays pinned to 1.98.4 with an
exact scoped Jayson 5.0.0 override, outside Web3's declared upstream range.
[Compatibility tests](../../tests/dependency-security/README.md) cover the used
RPC/ID behavior, Web Crypto and simulated browser bundles. Consuming application
roots must preserve and audit the resolution; overrides do not propagate.

Run check, build, test, test:rust-abi and test:settlement-abi. [Backend CI](../../docs/BACKEND_CI.md)
runs independent compiled ABI and runtime jobs in addition to package tests.
[Runtime infrastructure](../../tests/runtime/README.md) executes actual generated
transactions with signature verification; two bridge cases are preflight-only.
No simulated browser or local VM result establishes wallet-adapter parity,
Devnet parity, deployment readiness or complete application automation.
