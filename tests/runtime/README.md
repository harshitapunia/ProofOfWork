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
placeholder signatures. The 50 bridge tests use real TypeScript-generated
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

The finance-client dependency tree is checked by the strict Node security gate.
Review current npm audit output separately; do not run automatic major-version upgrades
inside this runtime-only PR. No copied client source, binary or test output
belongs in the commit.

## Automated validation

The [backend workflow](../../docs/BACKEND_CI.md) installs official checksum-pinned
platform-tools v1.57 and Solana CLI 4.1.2 on Linux, selects host Rust 1.98.1,
builds keylessly and enforces the unchanged reviewed SBF hash before running all
core and bridge suites. Missing or skipped runtime cases fail CI. Actual GitHub
run results must be checked; local historical results are not GitHub CI evidence.


## Lifecycle client extension

The 50 bridge cases comprise 26 settlement/attack cases, 20 lifecycle cases,
three complete verifier journeys and one browser/HTTPS/SBF journey. They call the actual finance-client builders,
then sign exact bytes with disposable in-memory identities. Creation/funding and
optional assignment setup are labeled trusted fixtures; targeted lifecycle
operations are never reconstructed as Rust instructions. Existing two preflight-
only cases remain. Synthetic Token/lamport overflow tests are fault injection,
not economically reachable supply claims. The CI guard requires all 50 bridge
tests in addition to the unchanged 23 core tests.


## Complete offline workflow/verifier journey

Three additional bridge tests connect real `prepareWorkflow` organization and
student plans to signed SBF transactions for creation, milestone creation,
funding, assignment and submission. The VM's actual account bytes feed the
existing attestation reader, GitHub adapter, `VerifierService` and single-use
`AttestationAuthorizer`. Only the instruction returned by that authorizer is
signed by the independent disposable verifier. All journey transactions enable
signature verification. Settlement uses the actual finance-client serializer.

Both zero-surplus and positive-surplus paths assert every status, submission
commitment, exact student reward, sponsor surplus, vault closure/rent return,
completion provenance and replay rejection. Failed GitHub identity, runner
outcomes and evidence commitments emit no attestation wire and cannot pay.
The original 23 core and 46 bridge cases are retained; the CI guard now requires
at least 73 total runtime cases, without failed/ignored/filtered cases.

This is offline integration, not real GitHub acceptance execution or a browser
wallet demonstration. GitHub HTTP responses and runner outcomes reuse explicit
test doubles. Fixture setup provisions a local mint/ATAs and an unrelated
internship 7; the journey creates absent internship 8 itself. No journey program
state is injected. The runner builds the locked lifecycle/verifier dependencies
before executing tests and hashes the consumed verifier source/compiled modules
and fixture inputs into fresh provenance. Do not run package installs concurrently
with other suites consuming those same node_modules directories.

The standalone browser and HTTPS suites exercise form/adapter behavior, real
handlers and cryptographic login. The additional case below connects these
components to LiteSVM. Real Phantom and live Devnet remain untested here. See the
[controlled live rehearsal plan](../../docs/LIVE_DEVNET_REHEARSAL.md) for remaining
operational gates. Signing and broadcasting remain disabled.


## Actual browser-to-HTTPS-to-SBF application case

One additional bridge case runs Chromium against the actual HTTPS application
and built frontend. It authenticates sponsor/student with disposable Ed25519
provider doubles, checks secure cookies, prepares organization/submission plans
through the real UI/HTTP handlers and executes their exact client wire in LiteSVM.
After each effect the browser refreshes the production scope query against the
actual VM account snapshot. The private handoff returned by real HTTPS is passed
to the existing verifier/authorizer; failed verification cannot attest or pay.
The test checks attestation, exact reward, completion, rent return, vault closure
and frontend Submitted/Verified/Settled observations without claiming payment
from status alone. All original cases remain: 23 core plus 50 bridge, minimum 73.

Simulated boundaries are explicit: Phantom/provider, RPC transport backed by VM
snapshots, GitHub HTTP/runner outcomes and test-only dispatch of signed wire to
LiteSVM. No production transaction button is enabled. This is genuine browser and
HTTPS execution, not a real Phantom or live Devnet rehearsal.

Linux requires the existing Playwright Chromium installation, its OS libraries,
OpenSSL/Bash and `libnss3-tools` (`certutil`). The existing runtime CI job installs
these prerequisites without adding permissions/jobs. The test uses disposable
in-memory TLS keys, sends the key through an anonymous pipe and trusts only its
public test certificate in a temporary Chromium HOME/NSS profile. It never
changes system or user certificate trust or bypasses HTTPS validation. Test
SQLite/profile files are isolated and cleaned up; no operational wallet or
application database is loaded. See Chromium's official
[Linux certificate management](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/linux/cert_management.md).

The browser journey also requests backend verification dispatch for its actual
Submitted VM commitment. Scoped contributor admission, GitHub HTTP and runner
outcomes are explicit offline doubles; the real application, v5 job writer and
existing verifier run, and the browser refreshes the genuine job status. No private
credential, manifest or nonce enters the job ledger. The existing durable coordinator runs fresh verification/authorization and exact
message policy. Its original process-local mock receipt supplies the message for
the separate fixture verifier/payer signatures executed by LiteSVM. A cloned
receipt, changed message or replay cannot supply the wire; a passed job itself
is never operational signing authority.
