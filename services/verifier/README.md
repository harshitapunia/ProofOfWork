# ProofOfWork GitHub verifier

This Node 24/TypeScript service checks a submitted software milestone against its committed requirements. It reads Solana Devnet state, authenticates the contributor through GitHub, validates PR provenance, retrieves the exact committed source file, and evaluates pinned tests inside a restricted Docker container.

The output is an off-chain verification result and, on success, unsigned arguments for `attest_milestone`. The milestone remains `Submitted` until a separately authorized signer submits a valid transaction. This service contains no signing keys or transaction-writing code.

## Supported task and manifest

The first supported assignment is a single ECMAScript module exporting `sum(values)`. It must return the numeric sum of an array, including an empty array and negative and fractional values. It cannot require npm dependencies or other repository files. The trusted suite in `src/manifest.ts` supplies inputs and expected outputs. Student-provided tests are unused.

A v1 manifest is a UTF-8 compact JSON object produced with `JSON.stringify`, without a BOM, trailing newline, duplicate keys or extra fields. Property order may vary, but the exact bytes must be retained and committed before funding. The service hashes those original bytes before parsing. Formatting changes yield another commitment and are rejected if they disagree with the on-chain requirements.

| Field | Required value |
|---|---|
| `version` | Integer `1` |
| `repositoryId` | Positive decimal string encoding a GitHub repository ID within u64 |
| `task` | `sum-v1` |
| `entry` | Relative `.mjs` path, such as `solution.mjs`, with no traversal, URLs or symlinks |
| `interface` | `export function sum(values)` |
| `tests` | Object with `suite: "sum-v1"` and `sha256` equal to the exported `TEST_DIGEST` |
| `runner` | Object containing the fields below |
| `passing` | `all` |

The test digest is SHA-256 over the UTF-8 `JSON.stringify(CASES)` bytes from the trusted suite. This pins the exact service-owned test vectors.

Runner fields are `image` (an operator-approved image reference pinned with `@sha256:` and a 64-digit lowercase digest), `network: "none"`, `user: "65534:65534"`, `readOnly: true`, `cpus` (0.1–1), `memoryMb` (integer 64–256), `pids` (integer 8–64), `timeoutMs` (integer 100–10000 per case), and `outputBytes` (integer 128–16384 per case). The image must exactly match the service's trusted configuration. A client cannot select an arbitrary image or execution policy.

Requirements use `SHA256(ASCII("proofwork:requirements:v1") || exact_manifest_bytes)`. Evidence uses the approved fixed-width binary concatenation:

```text
ASCII("proofwork:submission:v1")
program_id[32] || milestone[32] || student[32] || requirements_hash[32]
repo_id_u64_le || contributor_id_u64_le || commit_sha_raw[20] || nonce[32]
```

The service decodes canonical base58 public keys, exact lowercase 40-digit SHA-1 Git commits, lowercase 64-digit hashes/nonces, and decimal u64 IDs. It rejects overflow, malformed lengths and mismatched commitments.

## GitHub authentication and provenance

Each request must carry a GitHub **user** access token in its Authorization Bearer header. Keep tokens out of URLs, request bodies, logs and Git. Use an OAuth user token or fine-grained personal access token with access to the relevant repository and read access to contents and pull requests. Application installation tokens or caller-supplied usernames do not establish a contributor identity.

The service calls GitHub's authenticated `/user`, repository, commit, pull request and contents endpoints. It compares immutable numeric IDs, the PR's target repository and author, and its exact head SHA. Fork-based PRs are accepted only when the PR targets the registered repository, the authenticated user is its author, and the same commit is accessible through the registered repository's API. This proves the accepted PR workflow, not exclusive authorship of every line.

All API destinations are constructed under `https://api.github.com`. Redirects are refused. Source retrieval uses the validated commit as the contents API ref and checks the returned Git blob SHA. No arbitrary clone URL, archive extraction, checkout script or repository installation command runs on the host. Only the supported entry module is retrieved.

## Chain validation and unsigned attestation

The read-only RPC adapter supports the approved public endpoint `https://api.devnet.solana.com`. Custom endpoints are rejected in this initial version. With configuration absent, the request returns `missing_onchain_state`.

The adapter validates program ownership, exact account lengths and Anchor discriminators, canonical Internship/Milestone/Submission PDAs and bumps, sponsor-parent links, assigned student, designated verifier, linked submission, status `Submitted`, zero prior verification time and timely submission. Manifest and evidence digests must match on-chain values. It reads state again after execution and rejects a changed snapshot.

Successful responses contain the milestone and submission addresses, verifier public key, and `expected_student`, `expected_requirements_hash`, `expected_evidence_hash` derived from validated state. A future signer must authenticate this service, independently reread current chain bindings, and sign only the approved instruction. Never sign client-supplied result JSON. Never use the deployment keypair as the verification authority.

## Isolated execution

Install and configure a compatible Docker Engine separately. There is no host-execution fallback. An operator must audit and provision a trusted Linux image containing Node, pin its actual digest, and set the same reference used by the manifest. Image pulling is disabled during verification.

Every test case runs in a fresh container with no network, a non-root user, read-only root and source mount, all capabilities dropped, privilege escalation disabled, CPU/memory/swap/process/file-descriptor limits, bounded combined stdout/stderr, and an execution timeout. The Docker socket, service credentials, GitHub token, evidence nonce and Solana keys are never mounted or passed into the container. The host compares captured output against trusted expected values. Container logs are disabled. Containers are created stopped and started only after Docker returns a valid container ID. The runner inspects the actual exited state and exit code before accepting results, then force-removes that exact container ID in a finally block, including after timeout or excess output. Cleanup failure rejects the verification. If creation times out, no start request is issued and cleanup targets the generated name. A late daemon-side creation can leave a stopped container after that cleanup attempt. Containers carry the label `proofwork.verifier=true` so operators can identify such leftovers. Real benign-fixture and timeout cleanup has been observed on Docker Desktop; this does not establish cleanup reliability for every daemon failure or late creation race.

The worker environment must be dedicated to untrusted work. Docker containment is an operational trust boundary, not a proof that code is harmless. A passing finite test suite establishes only the agreed acceptance checks. Expected output is evaluated by the host, while submitted code can intentionally target those tests.

## Local setup and HTTP use

From this directory:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run build
node --env-file=.env dist/src/server.js
```

Create a local ignored `.env` from `.env.example` and supply values securely. `SOLANA_RPC_URL` must be the approved Devnet endpoint. `VERIFIER_PUBLIC_KEY` is the designated verifier's public address, never a keypair. `TRUSTED_RUNNER_IMAGE` is the audited, locally available image digest. Optional `PORT` defaults to 8787. No environment values are supplied by this repository.

The service listens on `127.0.0.1` and accepts `POST /verify` with `Content-Type: application/json` and the contributor's Bearer token. It rejects browser Origin headers. Keep it behind a separately authenticated, TLS-protected application backend before any remote exposure.

The JSON request has exactly these fields:

- `manifestBase64` holding the exact requirements manifest bytes.
- `milestone`, `student`, `repositoryId`, `contributorId`, `commit` and `nonce` providing the evidence preimage.
- `owner`, `repository` and positive integer `pullRequest` identifying the GitHub PR.

Store local request fixtures under ignored `.local/` and never log the body or Authorization header. Responses include safe reason codes, authenticated IDs and commit after provenance checks, public chain bindings, test IDs and pass/fail outcomes, and execution timestamps. Raw code, stdout/stderr, nonce and credentials are omitted.

Requests are serialized per milestone within one service process and capped at four active jobs. No successful response is cached. Repeated requests reauthenticate and reread the current chain state. Multi-process coordination and a durable attestation job ledger belong to the future signing integration.

## Validation and current limits

`npm test` runs deterministic commitment vectors, manifest validation, GitHub/RPC mocks, pipeline integration, runner command and failure tests, and local HTTP tests. It uses no real credentials or on-chain accounts. `npm run check` performs strict TypeScript checks including unused code. No separate lint tool is configured.

`npm run test:sandbox` runs the benign passing and failing fixtures only inside the configured Docker runner. Without a trusted image it explicitly reports a skip. Real benign-fixture execution has been validated using Docker Desktop with Ubuntu WSL2; live Solana RPC integration remains unverified. The separate opt-in GitHub adapter test is described below. Mocked passing outcomes are test doubles only.

The service does not implement OAuth enrollment, deployment, mint creation, stipends, signing or on-chain transactions. The program's existing on-chain authorization and replay checks remain authoritative. This is a fictional Devnet DEMO-token prototype.

Sources used for the integration are the [GitHub authenticated-user API](https://docs.github.com/en/rest/users/users#get-the-authenticated-user), [GitHub pull-request API](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request), and [Docker runtime controls](https://docs.docker.com/engine/containers/run/).


## Docker Desktop prerequisite and runtime validation

The initial sandbox-runtime review found Docker unavailable. Docker Desktop 4.98.0 has since been installed separately with Ubuntu 24.04 WSL2 integration; Docker CLI and daemon 29.9.2 are reachable from Ubuntu.

The minimal setup is Docker Desktop for Windows with the WSL 2 engine, Linux containers, and Ubuntu enabled under Settings → Resources → WSL Integration. Restart the Ubuntu terminal and verify both `docker --version` and `docker info` succeed. Follow the [official Docker WSL instructions](https://docs.docker.com/desktop/features/wsl/).

Once the runtime is available, resolve an official Node 24 image rather than copying a digest from an example:

```sh
docker pull node:24-bookworm-slim
export TRUSTED_RUNNER_IMAGE="$(docker image inspect node:24-bookworm-slim --format '{{index .RepoDigests 0}}')"
docker image inspect "$TRUSTED_RUNNER_IMAGE" --format '{{.Os}}/{{.Architecture}}'
docker run --rm --pull=never --network=none --user=65534:65534 --read-only --cap-drop=ALL --security-opt=no-new-privileges --entrypoint=node "$TRUSTED_RUNNER_IMAGE" --version
npm run test:sandbox
docker ps -a --filter label=proofwork.verifier=true
```

Confirm the image is Linux, matches the host architecture and reports Node 24 before fixture execution. The mutable tag above is used only to resolve a genuine digest. Actual fixture testing uses the immutable reference. Review any labeled leftovers instead of deleting unrelated containers.

### Real fixture validation

The approved local image was `docker.io/library/node@sha256:c0a93797ee78814ae6d32fcca2561fdbbe423149c3f5389aad32d86e9fd85bd4` (Linux/amd64, Node 24.22.2). Configure `TRUSTED_RUNNER_IMAGE` locally; the test does not pull images.

The shared mock helper retains its 1000 ms timeout. Only `test/sandbox.ts` sets its in-memory manifest to 5000 ms before validation. The original one-second start/attach deadline timed out benign fixtures, sometimes after correct output. In the controlled five-second run, container creation took 160–389 ms, start/attach 661–1261 ms, and cleanup 136–237 ms. Docker-reported container lifetimes were approximately 280–756 ms. Start/attach includes lifecycle and CLI overhead, not just JavaScript execution. These measurements do not separately isolate Node startup, JavaScript execution, or post-exit attachment delay.

All four passing-fixture cases passed. All four failing-fixture cases returned incorrect output (`999`) with exit code zero and were rejected for output mismatch, without timeout or infrastructure failure. Exact-container cleanup succeeded, including after the earlier one-second timeout; no labeled containers or temporary source directories remained.

No production runner policy, manifest bounds, hashing, or isolation settings changed. `timeoutMs` is part of the committed manifest bytes: changing it changes the requirements hash. Existing on-chain commitments must never be silently rewritten to use the local test setting.

Actual container inspection confirmed the pinned image, non-root user, disabled networking, read-only root/source mount, dropped capabilities, no-new-privileges, and CPU/memory/swap/process/file-descriptor limits. This is configuration evidence; active network/write denial, resource exhaustion and output-overflow enforcement were not exercised by these benign fixtures. Unit tests cover failure paths with mocked Docker commands. Live Solana RPC, signing, hostile submissions and late daemon-creation races remain unverified; live GitHub adapter validation is described below. Passing finite fixtures does not prove containment against arbitrary malicious code.


## Opt-in live GitHub adapter validation

Authenticate GitHub CLI as `harshitapunia`, then run from this directory:

```sh
npm run test:github:live                  # Explicit skip; no authentication or network calls
LIVE_GITHUB=1 npm run test:github:live    # Authenticated read-only integration
```

The script captures `gh auth token --hostname github.com` in process memory without printing it, putting it in command arguments, or writing an environment file. Do not enable shell tracing or log credentials. No Docker container or retrieved source is executed. The script permits only GET requests to `https://api.github.com` with redirects refused.

The public test case is repository `harshitapunia/ProofOfWork` (ID `1447380055`), contributor `harshitapunia` (ID `230834342`), PR #10 and original head `a0696fe0dd6f09e00ea853e19331162c3f96b3bf`, retrieving `services/verifier/fixtures/passing.mjs`. Live metadata must match before the existing `GitHub.verify` and `GitHub.source` methods are exercised. Source requests are pinned to that commit and the returned Git blob SHA is independently recomputed. Negative cases use mismatched contributor/repository IDs and the accessible merge commit instead of the PR head; each must produce its specific rejection reason.

`npm test` remains deterministic and does not select this script. Live authentication/API/assertion errors fail the opt-in script with sanitized output, rather than skipping. This validates the GitHub adapter only: it does not establish exclusive code authorship or test OAuth enrollment, other users/private repositories/fork PRs, live Solana state, signing, transactions or end-to-end attestation. Rate-limit/network-failure and corrupted-response tests remain mocked.

The authenticated live run passed for the public case above, including all three specific negative rejections. The retrieved blob SHA was `6f095dec6eec57214a8a40a026a01cf7317d4b8b`. No retrieved code was executed or GitHub resources modified.


## Opt-in live DevnetReader readiness test

```sh
npm run test:devnet:live                  # SKIPPED, no RPC calls
LIVE_DEVNET=1 npm run test:devnet:live    # Read-only readiness and negative tests
```

This separate script is not selected by deterministic `npm test`. It allows only read-only RPC methods at `https://api.devnet.solana.com`, verifies the Devnet genesis hash, inspects the configured program's existence/executable/loader ownership, and counts its program-owned accounts. Loader ownership alone does not audit deployed bytecode or upgrade authority. RPC errors fail rather than masquerading as absent state.

Missing configuration and malformed milestone addresses exercise the existing reader's local fail-closed guards without RPC. A synthetic, explicitly labeled PDA probe is first confirmed absent with live RPC, then passed to `DevnetReader` to verify `missing_onchain_state`. The program ID is used only as a public negative-test verifier sentinel, not as a designated verifier. No keypair or blockchain fixture is created. If the probe exists, that negative case is explicitly skipped.

For a future positive case, supply both `LIVE_MILESTONE_ADDRESS` and `VERIFIER_PUBLIC_KEY` as local public environment settings with `LIVE_DEVNET=1`. Obtain these real values from Harshita or Palak; there are no fallback fixture addresses or verifier keys. The reader validates the supplied accounts; the script independently compares returned public bindings, requirement/evidence digests and the snapshot against fresh account bytes. Concurrent state changes can fail the snapshot comparison and require a fresh run. Partial or invalid configuration and invalid supplied fixtures fail. This does not independently prove the off-chain commitment preimages.

`PASS` means an assertion actually ran successfully; `BLOCKED` identifies missing deployment/fixture infrastructure; `SKIPPED` identifies execution not performed. When no positive fixture is configured, the readiness script can exit successfully with blockers; that is not a positive live account-validation pass. Program-owned inventory alone does not establish a valid Submitted milestone. There is no deployment, signing, transaction, airdrop, mint creation, wallet access, or Solana CLI configuration change.

The initial opt-in readiness run passed Devnet connectivity/genesis verification, local configuration/address guards, and the live missing-account rejection. The program account was absent and program-owned inventory was zero. Positive account validation was explicitly BLOCKED/SKIPPED, not passed.


## Server-internal attestation preparation (unsigned)

`src/attestation.ts` adds `buildAttestMilestoneInstruction`, `AttestationAuthorizer`, and the trusted composition factory `createDevnetAttestationAuthorizer`. No HTTP route or signing/submission implementation is added. Existing verifier, chain reader, commitments, runner and Rust modules remain unchanged. The builder alone is public-data serialization, never evidence of authorization.

The approved ABI is 104 bytes: the first eight bytes of SHA-256 over `global:attest_milestone` (`e5a7009640d3ed97`), raw expected student public key (32), requirements hash (32), and evidence hash (32). Account order is verifier (signer, read-only), internship (read-only), milestone (writable), submission (read-only), under the configured ProofOfWork program ID. There is no payer, token account, system program or finance CPI in this instruction.

`DevnetAttestationReader` adds the internship address, sponsor and u64 IDs required for construction without changing `ChainState`. It uses only the approved Devnet endpoint and read-only `getMultipleAccounts`, and delegates the final three-account batch to the existing `decodeState` validator. This checks ownership, exact size/discriminator, canonical PDAs/bumps, parent/sponsor/student/submission bindings, Submitted status, verifier and timely submission. The parent extracted for lookup must also match the validated final batch. The builder independently derives internship, milestone and submission PDAs using the approved seeds and little-endian u64 IDs.

A trusted server must construct the production factory itself with the supplied designated verifier public key, approved RPC and pinned Docker image; these dependencies must never come from request JSON. `prepare(evidenceRequest, githubToken)` copies input, validates authoritative state and the existing commitments, and calls the existing `VerifierService.verify` internally. The service must actually authenticate GitHub provenance, retrieve pinned source and run all Docker checks. Only that invocation's successful, complete, matching result is accepted. The workflow re-reads chain state after evaluation, checks the full snapshot and bindings, and returns an opaque process-local object. Caller-provided result/attestation JSON or a serialized copy of the object is not an authorization.

`takeInstruction(handle)` burns that handle before awaiting, enforces a 30-second monotonic-clock lifetime, re-reads authoritative state, rejects stale bindings/snapshot or invalid lifecycle, and rebuilds the unsigned instruction. Duplicate/concurrent approval of a milestone is rejected for this authorizer instance's lifetime; a successfully issued reservation remains even after consumption or expiry. Failed preparations release their reservation. These controls are process-local: a restart or another instance has a separate ledger. Deploying multiple workers or enabling real signing requires a durable atomic job/replay ledger and explicit retry/recovery policy, not automatic retries or trusting cached result JSON.

`FutureAttestationSigner` and `FutureDevnetTransport` are interface contracts only. Deterministic tests use mock implementations with synthetic bytes, not real signatures or Solana transactions. Real signing, transaction assembly/blockhash/fee-payer policy, authenticated internal handoff, durable job coordination, signer identity checks, final state freshness policy, secure key storage, RPC cluster verification and submission/confirmation are deferred for separate review. Never use the deployment keypair as the verifier signer. An unsigned instruction is mutable public data, so a future signer must independently validate the final transaction and sign only its own trusted workflow output; exposing this builder as a generic signing endpoint is prohibited.

Off-chain freshness is a best-effort observation, not an atomic lock on Solana state. The on-chain program remains authoritative for signer, account/PDA bindings, clock/state, commitments and replay rejection at transaction execution. A passing off-chain test does not guarantee eventual transaction success. No live attestation, signing, Devnet transaction, deployed program or positive live milestone validation is claimed. Palak's finance creation/funding integration and an explicitly approved deployment/fixture are still required for a real lifecycle; shared ABI changes require joint review.


## Offline final-transaction authorization policy

`src/transaction-policy.ts` adds `AttestationTransactionPolicy`, an offline gate around the existing authorizer and instruction builder. It neither signs nor sends anything. The earlier `FutureAttestationSigner.sign(instruction)` interface is a placeholder, not a sufficient final-transaction signing boundary: it omits payer, blockhash, compiled permissions, other instructions and transaction confirmation. Do not attach a real signer to that interface without a separately reviewed coordinator.

The trusted server constructs the policy with the existing `AttestationAuthorizer`, an authoritative `AttestationStateReader`, a `TrustedBlockhashSource`, and explicit `verifier`, `feePayer`, `maxAgeMs` and `minRemainingBlockHeights` settings. There are no live identity or freshness defaults. Those dependencies/settings must never be supplied through request JSON. Test fixtures use synthetic public values and mocked blockchain observations, never signing keys or real blockhash claims.

Supported format is deliberately narrow: a canonical unsigned legacy Solana transaction, within 1232 bytes, with exactly one approved `attest_milestone` instruction. Versioned messages/address lookup tables, durable nonces, partial signatures, extra compute-budget/memo/token/transfer instructions, unused accounts, altered signature slots and ambiguous/noncanonical wire encodings are rejected. This is an offline implementation subset, not approval of a live payment/signing arrangement.

`authorize(evidenceHandle, proposedWire)` snapshots the untrusted proposal, requires the original process-local evidence authorization from trusted verification, consumes it through `takeInstruction`, and compares the complete account order, signer/writable flags, program ID and 104-byte instruction data with the existing builder output. It revalidates authoritative chain bindings/snapshot and compares both the complete expected compiled message and unsigned wire bytes. Fake approval JSON or transaction bytes alone cannot create authorization. Failures after evidence-handle consumption burn that handle; failures before consumption expose no transaction approval.

Fee-payer policy: this implementation requires an explicitly configured payer distinct from the verifier, every attestation account and the program. Solana promotes the fee payer to writable; a verifier-as-payer would violate the currently supported read-only verifier permissions. No actual payer address has been selected. Before live signing, Harshita and Palak must agree who pays (a separate relayer/sponsor payer is supported), custody/authentication, fee limits and co-signing order. Verifier-as-payer, pre-signed payer transactions and other arrangements require a separate reviewed policy; this component does not silently enable them. No financial authorization is implied by these offline checks.

Blockhash policy: the trusted source must attest the official Devnet endpoint and genesis identity, the exact approved blockhash, its last-valid block height, current block height, a validity check and observation time in the policy's trusted monotonic clock. The read-only Devnet source is described below; signing remains unimplemented. Age must be finite, nonnegative and below explicit `maxAgeMs` (at most 30 seconds); remaining heights must meet the configured positive safety margin. The candidate must use this exact approved hash. At consumption, the same hash/expiry lease must still be valid/fresh, with nondecreasing height. A newly selected hash causes rejection even if the old hash might still be usable; no silent blockhash replacement is allowed. The live freshness values and RPC commitment/slot strategy remain deployment decisions.

The policy returns an opaque process-local transaction approval. `consume(approval)` burns it before awaits, rechecks the state and blockhash lease and expiry, reconstructs the exact expected transaction, and returns a defensive copy of the authorized message bytes. It does not accept a replacement transaction. A future authenticated signer must invoke this handoff internally and sign exactly those message bytes, validate its own public identity and payer policy, and reject any post-validation mutation or caller-provided replacement. The returned bytes are public data, not standalone proof of authorization. No remote signing route or signer implementation is provided.

Evidence reservations and transaction approvals are in-memory. Process restart, independent policy/authorizer instances and multiple workers are not a durable replay boundary. Durable atomic job/approval coordination, failed-attempt recovery, secure signer isolation/authentication, final message identity checks, actual fee estimation/bounds and co-signing, and blockhash-source implementation require separate review before any real signatures. State may change after the last RPC check or while signing; the on-chain program remains authoritative for signer/state/commitment/replay checks. A signature or submitted transaction is not success: future transport must track confirmation/expiry and reread finalized state before reporting attestation. Program deployment and valid live milestone/submission fixtures are still required for end-to-end validation. Production signing is not complete.


The transaction-policy security review added a final authoritative state reread after the awaited blockhash observation, in both authorization and consumption. Regression tests reproduce a concurrent transition to Verified during the provider await and require rejection; otherwise a prior read could release a stale message. Freshness is checked again after the final reread. This closes the avoidable provider-await window, but cannot atomically lock blockchain state or prevent changes after the last observation and before transaction execution. CodeRabbit's initial complete three-file review reported zero issues; this gap was independently reproduced and fixed, not attributed to CodeRabbit.


### Read-only Devnet blockhash source

`new DevnetBlockhashSource()` from `src/devnet-blockhash.ts` implements `TrustedBlockhashSource` using only the official Devnet RPC, confirmed commitment and verified genesis. Share one instance with the transaction policy: it pins a hash/expiry lease and rechecks validity and nonregressing height/slot bounds on every read. An expired lease fails that read; a later read may acquire a new one, which invalidates old policy approvals. Observation time uses `performance.now()` from the start of the bounded read; any custom clock must match the policy clock. RPC failures return no observation. No signer, wallet or deployment is required.

Run `npm run test:blockhash:live` for an explicit no-network skip, or `LIVE_DEVNET_BLOCKHASH=1 npm run test:blockhash:live` for the read-only live check. Normal `npm test` stays deterministic. This supplies RPC observations, not transaction confirmation or protection from a compromised RPC node; final policy freshness margins and signing decisions remain separately configured.

### Versioned sum suites

Existing `sum-v1` cases and `TEST_DIGEST` are unchanged. New milestones may commit
`task` and `tests.suite` as `sum-v2` with `SUM_V2_DIGEST` from `src/sum-v2.ts`.
That digest pins `SUM_V2_POLICY`: 10 edge cases plus 8 independent CSPRNG cases,
quarter-unit inputs, a trusted integer-tick oracle, the exact harness, and explicit
byte-exact output/exit/cleanup acceptance rules. Missing, sparse or malformed outcome sets fail closed.
Each case uses a fresh restricted container (18 maximum; 128 values maximum).
Random inputs and expected outputs stay internal; API outcomes contain only IDs and pass flags.
Existing manifests are never upgraded automatically. Policy changes require a new suite version.
The opt-in `test:sandbox` command also exercises harmless v2 fixtures when the trusted image is configured.
Finite randomized testing reduces simple hardcoding; it does not prove general correctness or stop every adversarial implementation.


## Pinned Git tree source policy

Identity and PR provenance checks remain mandatory before acceptance. Source
retrieval independently rechecks the numeric repository identity and exact
commit. The REST commit's tree SHA must agree with the Git data commit's tree;
both commit responses must identify the requested immutable commit. All endpoints
are constructed within the validated repository, never taken from response URLs
or request-supplied tree metadata.

The verifier requests that root tree once with recursive=1. It requires the exact
tree SHA, explicit truncated=false, well-formed unique entries and valid Git
type/mode pairs. Each ancestor of the requested nested path must be a directory
tree (040000); the final entry must be a regular blob, 100644 or 100755.
Executable regular files are accepted as source bytes under the same isolated
Node invocation; Git executable permission grants no additional execution
authority. Symlinks (120000), gitlinks/submodules (160000), directories,
unsupported modes, absent paths and ambiguous/partial responses fail closed.
Contents API type=file alone is never treated as regular-file evidence, including
when GitHub dereferences a symlink.

Contents retrieval remains pinned to the exact commit and exact manifest path.
The tree-selected blob SHA, Contents SHA and locally calculated Git blob SHA-1
must all agree; declared tree and Contents sizes must match the decoded bytes.
Canonical base64, base64 encoding, nonempty source and the existing 131072-byte
limit remain enforced. Source paths use the existing relative .mjs manifest
grammar and 120-character bound; traversal, empty components, backslashes,
URL syntax and encoded separators are rejected before networking.

Source uses five bounded GETs: repository, REST commit, Git commit, recursive
tree and Contents. Existing identity/PR validation is separate. Each response
retains the 1000000-byte cap and 10-second timeout with redirects refused.
Large/truncated trees are rejected rather than partially trusted or retried with
weaker checks. This may reject otherwise valid files in very large repositories.
There is no clone, archive extraction, arbitrary object URL fetch, branch HEAD
fallback or authorization cache. New tree/metadata/blob failures use
github_api_failure; existing identity, repository, commit, missing-commit and
rate-limit classifications remain intact. Credentials are never included in
failure results.

This adapter trusts authenticated GitHub HTTPS/API responses to map a commit
object to its tree; it does not independently reconstruct the complete signed
Git commit or certify authorship. It retains the approved SHA-1 repository and
evidence-commitment policy. Requirements/evidence schemas, manifest parsing,
Docker isolation, acceptance policy, attestation and signing restrictions are
unchanged. Deterministic mocked adversarial tests do not establish live GitHub,
Docker, Devnet or complete-application readiness.

API references: [Git commits](https://docs.github.com/en/rest/git/commits)
and [Git trees](https://docs.github.com/en/rest/git/trees).

The existing opt-in live GitHub adapter test now asserts all five source
provenance requests instead of expecting only Contents. It passed read-only
against the already documented public PR #10 fixture after this hardening,
including the exact pinned tree/nested path/blob checks and the existing
contributor, repository and non-head-commit rejections. Retrieved code was not
executed. Adversarial tree/API failure cases remain deterministic mocks; this
live result does not prove hostile-response handling, sandbox containment,
private/fork enrollment, signing or complete application readiness.
