# Node dependency compatibility review

This isolated test workspace verifies the narrowly scoped Jayson replacement used
by the finance client and verifier. It does not enable signing or contact any
blockchain RPC. RPC responses are injected fixtures. Public address fixtures and
unsigned messages are not external configuration or persistent wallets.

## Decision

Keep @solana/web3.js exactly 1.98.4 and override only its Jayson child to exactly
5.0.0 in each package. The latest legacy release checked, 1.99.0, still requests
Jayson 4. Jayson 5 is an official upstream release, but this override is outside
Web3's declared range; compatibility must remain regression-tested. Do not run
npm audit fix --force or migrate to Kit as part of this correction.

The original ancestry in both packages was:
@solana/web3.js 1.98.4 -> jayson 4.3.0 -> stream-json 1.9.1 / uuid 8.3.2.
Web3 and Jayson audit entries inherited the leaf advisories; they were not
separate directly demonstrated application vulnerabilities.

- GHSA-528h-pc64-c93x: quadratic stream-json path filters; fixed in 3.5.0.
- GHSA-hqr4-qq8f-hg3x: quadratic JSONC comment scanning; fixed in 3.6.0.
- GHSA-mjw6-4jj6-33hc: parsed-object prototype injection; fixed in 3.6.0.
- GHSA-w5hq-g745-h8pq: UUID v3/v5/v6 output-buffer bounds; fixed lines
  include 11.1.1, 12.0.1 and 13.0.1. npm labels this moderate, with CVSS 7.5.

Current application paths did not demonstrate reachability of those vulnerable
APIs: Web3 uses the Jayson browser client, not its streaming server utilities,
and that client used UUID v4 without an output buffer. The verifier's concrete
HTTP/RPC readers also use bounded native JSON parsing. Absence of demonstrated
reachability is not proof of harmlessness; the vulnerable leaves are removed.

Jayson 5 retains the used request/response callback API and replaces UUID with
Web Crypto. Tests cover randomUUID and getRandomValues fallback, and rejection
when secure entropy is absent. Node 24 is the approved project runtime; browser
consumers need Web Crypto. No Math.random fallback is introduced.

The lockfile update removes eyes, stream-chain, stream-json and UUID 8.3.2.
npm also prunes a pre-existing extraneous top-level utf-8-validate 5.0.10 entry;
the separate rpc-websockets optional validator and UUID 14.0.3 remain unchanged.
Every other retained dependency entry is unchanged apart from Jayson.

## Reproduce

From the repository root, with Linux Node 24 and npm:

    npm --prefix packages/finance-client ci --ignore-scripts
    npm --prefix services/verifier ci --ignore-scripts
    npm --prefix tests/dependency-security ci --ignore-scripts
    npm --prefix packages/finance-client run check
    npm --prefix packages/finance-client test
    npm --prefix services/verifier run check
    npm --prefix services/verifier test
    npm --prefix tests/dependency-security test

Run both finance-client compiled ABI checks and the portable runtime suite using
tests/runtime/README.md. The runtime runner reinstalls finance-client dependencies
from this corrected lockfile and executes the real compiled client.

The 25 focused tests cover both dependency installations: request IDs,
notifications, batches, result/error callbacks, malformed responses, HTTP and
transport failure, mocked Connection reads, browser builds and browser-versus-Node
settlement instruction bytes/account metas. Browser builds use pinned development-
only esbuild 0.25.12; generated bundles stay in memory. Execution uses a simulated
browser VM, not a claim of real-browser or wallet-adapter end-to-end validation.

## Scope and continuing obligations

Overrides apply when each private package is the npm installation root. npm does
not propagate dependency-owned overrides to a consuming application's root.
A future frontend/workspace root must explicitly preserve and audit the chosen
resolution. The repository-root tooling now has a separate lockfile and visible, expiring
security exceptions in the backend CI policy; it is not certified clean by these
package audits. See ../../docs/BACKEND_CI.md. Future frontend trees need their
own dependency review.

Both locked application packages and this test workspace audited with zero
findings during review. Audit results are time-specific, not a security guarantee.
Keep the override exact and scoped, re-review it when upgrading Web3, and prefer
a compatible upstream fix once available. No Rust, ABI, public API, token policy,
program identity, signing activation or external transaction behavior changes.

The selected-package lockfile assertions deliberately tolerate separately audited
ancestor tooling dependencies. They still reject stream-json in either selected
package lock and reject the vulnerable UUID 8.3.2 descendant.
