# Shared Rust foundation

The [approved specification](CONTRACT_SPEC.md), including its v2 settlement
amendment, defines the stable ABI, six PDA derivations and allowed transitions.

The single proof_of_work Anchor crate contains all eight business entry points.
Shared modules are state (Internship, Milestone, Submission, CompletionRecord,
MilestoneStatus), seeds, errors and instruction namespaces. Their checked
serialization/ownership fixtures remain authoritative. Error variants preserve
the approved ordering, 6000 through 6010.

Harshita owns creation/funding and verification; Palak owns settlement/refunds
and completion. The [current workflow](TEAM_WORKFLOW.md) supersedes older
all-finance assignments. Joint review is required for layouts, seed encodings,
instruction interfaces, state transitions and shared helper interfaces.

## Devnet identities and build boundary

The configured public program ID is
J2FkqDuuuHT14gxjVMhSryrX3Bs4Knct45NMLA79dGdZ. The approved classic DEMO mint
and authority information are recorded in TEAM_APPROVAL.md and config.rs.
Their presence in source is not evidence of deployment or live mint validation.
Deployment/upgrade authority arrangements and any deployment require separate
authorization. Never expose or generate deployment keys for validation.

Host Rust/Cargo is pinned to 1.98.1. The reproducible SBF build uses the
independently verified v1.57 platform-tools compiler and Solana CLI 4.1.2,
without Anchor/cargo-build-sbf wrapper postprocessing. The reviewed artifact
SHA-256 remains:
1711e2dbbd2f0129f34be5d70e3e48867c42a849b2beea7d36cfbddaf2ed64e1

[Runtime instructions](../tests/runtime/README.md) and [CI policy](BACKEND_CI.md)
explain reproduction, official tool digests and provenance. Compiler/hash drift
must fail review; CI does not repin artifacts automatically. Native tests alone
do not establish transaction atomicity; SBF tests exercise actual CPIs/rollback.

Operational signing, durable orchestration, application APIs and frontend remain
separate integration work. No deployment is performed by the validation workflow.
