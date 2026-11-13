# Backend architecture and trust boundaries

The [approved contract specification](CONTRACT_SPEC.md), with Settlement
Destination Policy v2, supersedes this document's historical draft. Account
layouts, PDA seeds, signer sets and transitions remain unchanged.

## On-chain components

| Component | Implemented responsibility |
| --- | --- |
| Internship | Immutable sponsor and sponsor-scoped ID |
| Milestone | Terms, roles, commitment, deadlines, escrow bindings and lifecycle |
| Submission | One immutable student evidence commitment |
| Vault/authority | Dedicated classic SPL escrow and milestone-specific PDA signer |
| CompletionRecord | Immutable settlement provenance, created atomically with payment |

There is no separate Verification account. The designated verifier transitions
Submitted to Verified for exact stored bindings. The eight instructions cover
creation, funding, assignment, submission, attestation, settlement and eligible
unclaimed refund. Settled/Refunded are mutually exclusive terminal states.

Settlement pays exactly the reward to the student's canonical classic ATA,
returns surplus to a validated sponsor-owned classic token account and vault
rent to the sponsor, then records completion atomically. The canonical sponsor
ATA is preferred but not mandatory for settlement. Funding/refunds continue to
require the canonical sponsor ATA. No caller gains payout authority.

## Off-chain components

The finance client provides unsigned creation/funding/settlement builders,
canonical derivations and validated atomic sponsor-destination fallback.
Assignment/submission/refund production client coverage and general lifecycle
queries remain integration work; the internal attestation builder already exists.

The verifier authenticates GitHub numeric identities, pins PR/commit/blob
evidence, validates domain-separated commitments and checks submitted chain
state before and after restricted acceptance execution. Docker workers receive
no signing credentials or network access. A future signer must consume only
authenticated authorization and exact approved message bytes, never client
approval JSON.

Process-local single-use tickets and transaction policy, a test-only execution
workflow, read-only RPC helpers and an offline recovery classifier are
implemented. They are not durable operational signing or recovery. No production
HTTP route activates them. Persistent uniqueness, worker fencing, custody,
restart reconciliation and authenticated application orchestration remain open.

## Validation and limits

[CI](BACKEND_CI.md) separates Node, dependency, native Rust, compiled ABI and
keyless SBF/LiteSVM validation. The runtime bridge executes actual client wire
bytes; two cases are preflight-only and fixture setup has documented limits.
It does not prove Devnet feature parity or complete application readiness.

The chain trusts its designated verifier, while GitHub provenance and acceptance
quality remain off-chain. Passing finite tests does not prove authorship or
universal correctness. Sponsor vetting, consent, listings, applications, private
evidence and credential operations belong off-chain. Timely unverified work
can remain locked under the approved MVP. New recovery/dispute instructions,
verifier rotation or ABI changes require explicit design review.
