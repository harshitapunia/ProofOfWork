# ProofOfWork finance client

Creation, funding, lifecycle and Settlement Destination Policy v2 support remains
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

Funding and refund contracts retain canonical sponsor ATA policies. The lifecycle
builders below extend the unsigned API without modifying settlement preparation
or destination provisioning. The verifier's existing internal attestation builder
is reused by compiled-ABI regression tests; it is not duplicated here.

## Dependency and validation boundary

Use this package's npm ci --ignore-scripts. Web3 stays pinned to 1.98.4 with an
exact scoped Jayson 5.0.0 override, outside Web3's declared upstream range.
[Compatibility tests](../../tests/dependency-security/README.md) cover the used
RPC/ID behavior, Web Crypto and simulated browser bundles. Consuming application
roots must preserve and audit the resolution; overrides do not propagate.

Run check, build, test, test:rust-abi, test:settlement-abi and test:lifecycle-abi. [Backend CI](../../docs/BACKEND_CI.md)
runs independent compiled ABI and runtime jobs in addition to package tests.
[Runtime infrastructure](../../tests/runtime/README.md) executes actual generated
transactions with signature verification; two bridge cases are preflight-only.
No simulated browser or local VM result establishes wallet-adapter parity,
Devnet parity, deployment readiness or complete application automation.


## Unsigned lifecycle builders

All three accept sponsor, internshipId and milestoneId. IDs are bigint raw u64
values; numbers and numeric strings are rejected. Reuse the existing derivation
helpers rather than supplying parent, milestone, submission, vault or destination
addresses. Unsupported fields (including refund destination overrides) fail with
invalid_arguments. Existing sponsor-key validation is preserved; possession of a
signing authority and stored relationships are enforced on-chain, not inferred
from a public key. No builder signs, reads RPC state or submits a transaction.

- assignStudentInstruction also accepts student (nonzero on-curve public key,
  distinct from sponsor). Accounts are sponsor signer (readonly), internship
  readonly and milestone writable. It serializes only the student public key.
- submitMilestoneInstruction also accepts student and evidenceHash. Student signs
  and pays submission rent; accounts are student writable signer, internship
  readonly, milestone writable, derived submission writable and System Program.
  evidenceHash is a nonzero exact 32-byte Uint8Array or 64-character hex string.
  It is copied; the only serialized argument is that digest.
- refundUnclaimedMilestoneInstruction optionally accepts rewardMint/tokenProgram,
  which must equal the existing approved DEMO/classic SPL configuration. Accounts
  are sponsor writable signer, internship readonly, milestone writable, mint
  readonly, vault writable, authority readonly, canonical sponsor ATA writable and
  classic Token Program. It has no serialized arguments and accepts no arbitrary
  destination. Settlement Policy v2 does not apply to refund destinations.

The student/verifier distinction, stored sponsor/student bindings, status,
deadlines, missing submissions, escrow backing and account ownership remain
authoritative program checks. Assignment cannot verify the stored verifier or
current state without chain observations. These are serializers, not eligibility
or authorization services. A transaction may choose a separate fee payer; it then
also needs that payer's signature.

For evidence, use the existing domain-separated evidenceHash implementation in
services/verifier/src/commitments.ts in the approved off-chain workflow and pass
only its final digest. This package deliberately implements no new hashing scheme
or evidence storage. Keep manifests, preimages, GitHub credentials and nonces
private; none belongs in these instruction arguments.

Malformed inputs use FinanceClientError with stable codes: invalid_arguments,
invalid_public_key, invalid_sponsor, invalid_student, invalid_u64,
invalid_evidence_hash, incorrect_mint or incorrect_token_program as applicable.
Inputs are copied during synchronous construction. Existing exports and
creation/funding/settlement instruction bytes remain unchanged.

lifecycle-rust-abi.rs exports actual generated Anchor instruction and account
types for assignment, submission, refund and attestation. Compiled snapshots
cover zero, beyond-safe-number and maximum u64 IDs. Finance tests compare the
three new builders; verifier tests compare its unchanged attestation builder.
The existing ABI CI job compiles and checks this new family too.

The runtime bridge retains all 26 existing cases and adds 20 lifecycle cases
(46 total), executing actual TypeScript instructions with real local signatures.
Trusted fixtures initialize mint/ATAs, internship, funding and optional assignment;
each operation under test comes from the production client. Negative cases cover
wrong roles/signatures, verifier-as-student, cutoffs, repeated/terminal operations,
cross-vault and noncanonical refund destinations, changed ATA authority and
financial rollback. Token/lamport overflow prestates are explicitly synthetic;
the VM supplies rollback and snapshots are never restored by the harness.
