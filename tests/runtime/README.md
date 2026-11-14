# Portable local LiteSVM validation

This standalone locked workspace validates merged settlement PR #24, refund
PR #25 and finance-client PR #27. Runtime infrastructure PR #26 is merged.
It does not link native program handlers, deploy or contact blockchain RPCs.

## Reproduction

Prerequisites: Linux native build tools, Python 3, Node/npm, host Rust 1.98.1,
Solana CLI 4.1.2 and verified official SBF platform-tools v1.57 (bundled Rust
1.95.0-dev, LLVM 22.1.2). Install toolchains separately; no installer is run here.
Use the host-appropriate official Anza platform-tools bundle and verify its
published digest. Do not use anchor build or cargo-build-sbf: wrapper
postprocessing can create deployment keys. No wallet files are needed.

From the repository root run:

    python3 tests/runtime/build-sbf.py --platform-tools "$POW_PLATFORM_TOOLS"
    node tests/runtime/run-client-bridge.mjs

The build uses direct cargo, --locked and a remapped source prefix. Add
--offline only after dependency caches are populated. The runner installs the
locked npm dependencies without lifecycle scripts, builds the actual
packages/finance-client implementation and runs all runtime tests serially.
It accepts standard Cargo/npm dependency caches, not prior ignored snapshots.
PROOFWORK_NODE defaults to the runner's Node executable. PROOFWORK_SBF_PATH
may explicitly select an artifact, but every VM verifies its pinned SHA-256.
Generated evidence and binaries remain below ignored target/. No client source
copy, private-key export or persistent test wallet is used.

Review artifact-provenance.json for the pin and source/toolchain provenance.
The build writes fresh target/keyless-sbf/provenance.json and refuses a different
hash. Explicit checks remain active under python3 -O and PYTHONOPTIMIZE. If a host/compiler changes the output, review that record before a separate
explicit pin change; never disable the guard.

## Coverage and limits

23 core tests cover settlement, refunds, lifecycle, local signed history and
failed transfer/closure/completion atomicity. Financial core fixtures use
placeholder signatures. The 46 bridge tests use real TypeScript-generated
wire bytes and signed settlement/attack transactions; two cases are client
preflight rejection only. Lifecycle setup uses placeholder signatures.
Synthetic overflow/shortfall/completion prestates are labelled in source;
rollback is observed from VM state, never implemented by restoring snapshots.

Worker RAII holds a process-wide mutex and restores all role environment values.
The runner also enforces --test-threads=1 and strips inherited bridge overrides.
In-memory ephemeral identities exist only for local tests.

LiteSVM 0.18.2 uses an Agave 4.3 feature profile with p-token replacement disabled.
This is not proof of Devnet feature parity. Classic Token 3.5.0 and ATA 1.1.1
bundled executable hashes remain enforced. No external transactions are sent.
Settlement Policy v2 and its shared changes are approved as recorded in
TEAM_APPROVAL.md. This runtime PR remains subject to its own review; tests do
not authorize deployment or establish complete application readiness.

## Full local regression commands

Before the runtime runner, from the repository root run:

    cargo fmt --all --check
    cargo fmt --manifest-path tests/runtime/Cargo.toml --check
    cargo check --workspace --all-targets --locked
    cargo test --workspace --locked
    npm --prefix packages/finance-client ci --ignore-scripts
    npm --prefix packages/finance-client run check
    npm --prefix packages/finance-client test
    npm --prefix packages/finance-client run test:rust-abi
    npm --prefix packages/finance-client run test:settlement-abi

Use host Rust/Cargo 1.98.1 on PATH (a version-numbered rustup installation must
include Cargo and rustfmt, not only rustc). No global toolchain setting is
changed. NO_DNA=1 may be supplied for the native dependency build profile used
in the recorded runs. The runner records the actual client source/compiled
JavaScript, package/lock files, harness inputs and tool versions below
target/client-bridge/run-*/provenance.json. Each invocation gets a fresh
directory and result.json records Cargo success/failure; prior evidence is never
deleted or mixed with a new source manifest. Direct Cargo bridge execution uses
a fresh direct-PID-timestamp directory but does not supply the wrapper manifest.

Core financial fixtures and initial lifecycle construction are trusted setup;
bridge settlement/attack signatures are real local Ed25519 checks. Operational
verifier signing, RPC transport, wallet adapters, transaction confirmation and
backend/frontend orchestration remain outside this harness.

The unchanged finance-client runtime dependency tree has known npm advisories.
Review npm audit output separately; do not run automatic major-version upgrades
inside this runtime-only PR. No copied client source, binary or test output
belongs in the commit.

## Automated validation

The [backend workflow](../../docs/BACKEND_CI.md) installs official checksum-pinned
platform-tools v1.57 and Solana CLI 4.1.2 on Linux, selects host Rust 1.98.1,
builds keylessly and enforces the unchanged reviewed SBF hash before running all
core and bridge suites. Missing or skipped runtime cases fail CI. Actual GitHub
run results must be checked; local historical results are not GitHub CI evidence.


## Lifecycle client extension

The 46 bridge cases include the original 26 settlement/attack cases and 20 new
assignment/submission/refund cases. They call the actual finance-client builders,
then sign exact bytes with disposable in-memory identities. Creation/funding and
optional assignment setup are labeled trusted fixtures; targeted lifecycle
operations are never reconstructed as Rust instructions. Existing two preflight-
only cases remain. Synthetic Token/lamport overflow tests are fault injection,
not economically reachable supply claims. The CI guard requires all 46 bridge
tests in addition to the unchanged 23 core tests.
