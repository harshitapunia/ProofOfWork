# Backend validation and dependency policy

## Workflow

.github/workflows/backend-validation.yml runs on pull requests, pushes to main
and explicit manual dispatch. Six GitHub-hosted Ubuntu 24.04 jobs report
independently: finance client; offline verifier; Node security/browser/RPC;
native Rust/Rust security; compiled ABI; keyless SBF/all LiteSVM tests.

Finance/verifier jobs perform clean locked installs, type checking, builds and
full default test suites. Live GitHub/Devnet/blockhash scripts are excluded.
The ABI job fetches locked Rust dependencies before its offline exporters and
shares their local target cache between both comparisons. The runtime job builds SBF once and runs the complete bridge once,
including all core suites; it rejects missing, failed, ignored or filtered cases.
Historical counts (98 native, 112 finance, 330 verifier, 25 compatibility, 23 core
runtime and 26 bridge) are baselines, not fabricated CI results or fixed future
unit-test totals. Two bridge cases are intentionally preflight-only.

All jobs have contents: read permissions. Checkout does not persist credentials.
There are no wallet/deployment secrets, privileged pull_request_target events,
signer activation, external blockchain transactions or deployment steps.
Untrusted PR code runs only on disposable GitHub-hosted runners without elevated
repository authority. No dependency/build cache is restored, avoiding cache
trust ambiguity and stale compiled artifacts. Public provenance/test-result
files may be uploaded, never wallet files or deployment binaries.

## Toolchain provenance

Node 24.14.1 and Rust/Cargo 1.98.1 are selected explicitly. Rustup uses official
Rust distribution manifests/checksums; setup-node uses official Node distribution
verification. Actions are pinned to immutable Node-24-compatible commits; automatic npm caching
is explicitly disabled. The repository Rust pin
does not change global rustup or Git defaults.

.github/ci-tools.json records official release URLs and published SHA-256
digests resolved from GitHub release-asset metadata for:
- Anza platform-tools v1.57, Linux x86_64.
- Anza Agave/Solana CLI v4.1.2, Linux x86_64.
- RustSec cargo-audit 0.23.0.
- actionlint 1.7.12.

install-tools.py downloads archives, verifies exact hashes before extraction,
uses Python's data extraction filter and never executes external installers.
SBF Rust is not installed globally or put ahead of host Rust outside build-sbf.py.
The full local/CI runtime build retains the reviewed SBF SHA-256:
1711e2dbbd2f0129f34be5d70e3e48867c42a849b2beea7d36cfbddaf2ed64e1

Mismatch must stop validation and trigger provenance investigation. No automatic
repin is permitted. Source, lockfile and ELF checks in the existing builder remain
enabled. A passing local build is not a GitHub result or Devnet parity proof.

## Node security gate

Every installation uses npm ci --ignore-scripts and a tracked lockfile.
The finance, verifier and dependency-compatibility trees permit zero npm audit
findings at every reported severity, including low. The compatibility suite
checks Web3 1.98.4, Jayson 5.0.0, removed vulnerable descendants, actual mocked RPC
behavior and simulated browser bundles. The exact scoped override remains outside
Web3's upstream declared range. A future consuming root must preserve/review it.

The optional repository-root Anchor SDK and legacy Mocha/formatting tooling is
retained for existing developer compatibility and now has a reproducible lock.
It is not used as the backend package installation root. Its modules/tests are
not executed by this CI; only a locked install and advisory inspection run.
No root tooling major upgrade is hidden in this PR.

The initial root audit reports 13 vulnerable package entries: seven high, five
moderate and one low. Inherited entries are not separate independent CVEs.
Affected packages include Anchor core/Borsh, Web3, Jayson, stream-json, UUID,
TOML, Mocha, js-yaml, minimatch, nanoid, serialize-javascript and diff.
The exact installed versions, advisory IDs, inherited paths and severity are in
.github/security-policy.json. Root findings are security debt, not harmlessness
or repository-wide clean-audit certification. In particular TOML parsing and
legacy Mocha dependencies need a prioritized separate remediation assessment;
do not process untrusted inputs or activate signing through this root tree.

Root exceptions expire on 2026-12-14. Each is constrained to the exact package,
installed versions, node paths, severity and advisory/inheritance set. Changed
versions, new advisories, escalated severity or expired reviews fail. Every
accepted finding and rationale is printed and retained in the JSON report.
Removed findings may disappear without failure; unused exceptions should then
be removed on review. There is no blanket severity suppression, force-fix or
major Anchor/Kit migration. Update policy only through explicit security review.

## Rust security gate

Pinned cargo-audit scans Cargo.lock and tests/runtime/Cargo.lock against a fresh
RustSec database and records the database commit. Any reported vulnerability
fails regardless of severity. Infrastructure errors or malformed/incomplete
reports fail closed. New non-maintenance notices also fail.

Existing exact unmaintained-package notices are visible, temporary reviews:
bincode 1.3.3 (both locks), and runtime-only ansi_term 0.12.1, derivative 2.2.0,
libsecp256k1 0.7.2 and paste 1.0.15. The policy pins package/version/advisory/lock
and expires on 2027-02-14. These upstream maintenance notices are not reported
exploits and are not a reason to change serialization or cryptography ad hoc.
Reassess upstream releases quarterly; security vulnerabilities cannot reuse
maintenance exceptions. No cargo-audit ignore list is used.

Policy refusal-path regressions cover new findings, version/advisory/severity
changes, expiry, malformed reports, inconsistent totals, Rust vulnerabilities
and attempts to treat another warning category as accepted maintenance.

## Local reproduction and evidence

Use the commands in the workflow with the pinned tools. Validate YAML with
verified actionlint, run .github/scripts/test-security-gates.py, then run
security-gates.py node and security-gates.py rust --audit PATH_TO_PINNED_BINARY.
Scripts write only public audit/provenance outputs under ignored target/.

CI run logs and public provenance are authoritative for the run's actual
results. Networked dependency/advisory downloads remain availability dependencies;
no scanner outage is treated as a clean result. Docker acceptance execution,
real-browser/wallet adapters, live Devnet behavior, operational signing, durable
jobs/recovery and complete application integration remain outside default CI.
The approved contract specification and Settlement Destination Policy v2 are
unchanged. No deployment or key generation occurs in this phase.
