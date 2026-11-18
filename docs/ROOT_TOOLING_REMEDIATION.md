# Root developer-tooling remediation candidate

This separately authorized remediation is based on main
5190c7b39cc5723d6c0da339df535b5eb528ffaa and is independent of wallet API PR #45.
Publishing it does not integrate the fix into main or make PR #45's failed CI
green. Integration requires normal review and separately authorized merging.

## Trigger and chosen correction

The root-only Mocha 9.2.2 → Chokidar 3.5.3 → AnyMatch/Readdirp → Picomatch 2.3.2
path now reports [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf).
The advisory was reviewed/updated on 2026-11-17, covers versions through 4.0.7
and listed no patched Picomatch version at investigation time. The existing gate
correctly refused the new findings; no exception was added or scanner bypassed.

Mocha 12 was considered but the current ts-mocha peer range does not support it.
No --force, --legacy-peer-deps or automatic audit fix is used. Mocha 11.8.0 with
ts-mocha 11.1.0 preserves the existing wrapper CLI and supports the pinned Node
24.14.1. Its ts-node 10.9.2 and tsconfig-paths 4.2.0 peers are explicitly pinned.
Chokidar 4 removes the Picomatch dependency. A first Mocha-11-only experiment
removed Picomatch but retained other vulnerable tooling dependencies; its audit
and manifests are preserved outside Git and that incomplete result was not
treated as a secure remediation.

The final candidate scopes exact overrides to Mocha 11.8.0 only:

| Dependency | Candidate version |
| --- | --- |
| diff | 9.0.0 |
| glob | 14.0.6 |
| js-yaml | 4.3.2 |
| minimatch | 11.0.9 |
| serialize-javascript | 7.1.4 |

These are deliberate cross-major overrides outside some upstream ranges, not an
upstream compatibility guarantee. Major runner upgrades, watcher semantics,
module loading, configuration parsing, diagnostics and worker serialization need
review. The compatibility suite exercises those actual behaviors. Node 24 native
TypeScript stripping is not substituted for ts-node enum transpilation.

## Security policy and isolation

Audit findings reduce from 17 on the unchanged affected tree (11 high, five
moderate, one low) to seven pre-existing SDK findings (two high, five moderate).
There is no Picomatch path and no Mocha-chain finding. Six obsolete exceptions
for diff, js-yaml, minimatch, Mocha, nanoid and serialize-javascript are removed.
The remaining exact package/version/node/severity/advisory constraints and
2026-12-14 deadline are unchanged; no new waiver or severity threshold change.
Rationale text is corrected because CI now runs controlled compatibility fixtures.

Anchor SDK 1.2.2 and its public API remain. Existing SDK debt in Anchor/Borsh,
Web3, Jayson, stream-json, TOML and UUID is not fixed or declared harmless. Do not
use root SDK tooling with untrusted input, wallets or operational signing. Backend
package manifests/locks, Rust, financial/ABI/PDA rules, runtime harness, database
schemas and application sources remain untouched. All six CI jobs and pinned
actions/tools remain; the existing compatibility command adds this suite.

## Local validation scope

Seven real root-tooling tests cover CommonJS hooks/async/callback execution and
public BN serialization through Anchor, ESM modules, ts-mocha TypeScript enum
transpilation, YAML/glob/ignore discovery, assertion diff and failing exit status,
parallel workers/root hooks, and an actual file-watch rerun. Fixtures are created
under the root CommonJS boundary and cleaned up. One subprocess intentionally
fails an assertion to verify failure reporting; the compatibility test expects
that exit status. No network or private keys are used by these tests.

Actual dependency installs, security gates, broader compatibility totals and
reproducibility results are recorded in the delivery report and PR checks. Local
results alone do not establish hosted CI/CodeRabbit success or a merge. Full Rust/SBF
tests need not be rerun solely for this root-only dependency change; their source
and all backend/finance package locks are unchanged and must remain protected.

Publication requires reviewed cross-major overrides and remaining SDK debt,
clean locked installs and the unchanged gate. Merge/integration must be separately authorized; PR #45 remains
blocked until an approved remedy is integrated and its current-head checks pass.
