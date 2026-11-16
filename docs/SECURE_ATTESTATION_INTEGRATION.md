# Secure attestation integration — Phase 8D

**IMPLEMENTED OFFLINE. NOT YET OPERATIONAL.** No live RPC, operational signer,
transaction sender, deployment, settlement or public execution route is added.
This document describes an internal test composition, not a successful Devnet
attestation or permission to activate one.

## A. Existing workflow

`VerifierService` reads GitHub evidence through the existing GitHub reader,
checks the attestation manifest and commitments against the chain reader, and
runs the restricted verifier runner. `AttestationAuthorizer` creates a fresh,
process-local, single-use capability. `AttestationTransactionCoordinator` and
`AttestationTransactionPolicy` check the canonical instruction, exact message,
account relationships, roles, public bindings, blockhash and original deadline.
`DurableOfflineCoordinator` already wraps this path with permanent job identity,
worker/revision/generation checks and durable v3/v4 records. Phase 8D extends
that coordinator; it does not implement a second verifier or authorization engine.

## B. New internal orchestration

`SecureOfflineAttestationIntegration.investigate(input, githubToken)` accepts
only `{mode: "offline-only", requestId, evidence}`. Evidence has exactly the
existing verifier request fields. Unknown properties, accessors, malformed
identities and attempted authorization/transaction injection are rejected.
The token is a separate trusted caller input, never a request-selected signer
or persisted/returned credential. There is no HTTP registration or environment
loader. Constructor dependencies are trusted composition code, not sandboxed
application requests; they must remain offline fixtures in this phase.

An optional trailing, synchronous `DurableOfflineCoordinator` audit callback
exposes defensive copies of public progress only: resolved job, verification
result, consumed-policy context, retained preparation and public signature
simulation evidence. It exports no policy ticket, signing request or signed wire.
Callbacks cannot mutate the originals through these copies. Existing callers
without the hook retain their path. The integration uses this hook to correlate
the real preparation with the existing execution ledger **before** providers run.

The result reports actual completed stages, safe verification fields, durable
identities, public simulation evidence and optional observation classification.
It never infers completed verification or fresh authorization from historical
records. Stable failure categories distinguish invalid input, verification or
authorization denial, expiry, invalid message, duplicate/permanent intent,
stale worker, signing timeout/uncertainty, incomplete/conflicting evidence and
corrupt history. Dependency exception messages are not returned.

## C. Reused components

- Existing verifier, GitHub evidence adapter, attestation chain reader and runner.
- Existing authorizer, finance-client instruction builder, exact-message policy
  and transaction coordinator.
- Existing `DurableOfflineCoordinator`, `LifecycleStore` jobs, v3 handoff,
  v4 transaction intents and v5 execution attempts/history.
- Existing `OfflineDualSignatureSimulation` and test-only role providers.
- Existing `OfflineReadOnlyObservationAdapter`, `reconcileOfflineReadEvidence`,
  protocol validators, signature verification and raw account decoders.

No new database, transaction builder, reconciler, storage migration, protocol
authority token or dependency is introduced. The public server route and CLI
remain unchanged. Finance client, Rust and on-chain interfaces remain unchanged.

## D. Verification boundaries

The actual `VerifierService` executes; only external GitHub, chain, blockhash,
runner and observation dependencies are fixtures in integration tests. GitHub
repository/contributor/commit mismatch, runner failure and changed commitments
cannot create fresh authorization. The integration returns the safe service
result and original evidence commitments for the active call.

**Persistence gap:** schema v5 stores the existing job outcome and commitments,
not the complete verification response. The complete response is transient.
Restart inspection returns `verification: null`; it does not reconstruct a
successful verifier result. Persisting additional verification details requires
a separate reviewed design, retention/privacy decision and, if needed, schema PR.

## E. Authorization boundaries

Only the existing authorizer can issue a genuine fresh capability. Only the
existing exact-message policy can consume it. Reconstructed tickets, old job,
intent, execution or observation DTOs cannot replace the capability. Original
deadlines are retained, and role/message/blockhash substitution fails closed.
The integration does not expose authorization objects in its result.

The result always retains `operationalAuthorization: false`,
`signingAuthorization: "not_granted"`, `submissionAuthorized: false`,
`retryAuthorized: false`, `reservationReleaseAuthorized: false`,
`rpcAuthenticated: false`, `onChainStateVerified: false`,
`settlementPermission: false`, and `reconciliationRequired: true`.

## F. Signature simulation boundary

The existing `OfflineDualSignatureSimulation` consumes the original genuine
policy provenance and validates separate verifier/payer signatures over the exact
original message using the original authorization deadline. Tests reuse existing
ephemeral test providers. Runtime integration contains no private-key reader,
wallet generator, generic signer API or transaction sender.

**Composition gap:** the simulator intentionally returns public evidence only;
it does not export signed transaction bytes. The test helper assembles fixture
wire from signatures already held by test-only providers. Runtime orchestration
does not assemble or expose that wire. Observing this fixture is not proof of an
operational signed transaction, a submission or authenticated RPC response.

## G. Durable intent integration

The original coordinator creates the permanent operation/job identity, checks
current worker/revision/generation, creates one v4 intent, records its immutable
preparation and marks it reconciliation-required **before** either test provider.
The new hook correlates that exact retained intent to one v5 attempt using the
existing `executionAttempts.create` API. It does not replace identities, clear
reservations, overwrite messages or revive an existing intent. Duplicate calls,
separate connections, old intents and old attempts fail through existing guards.

Schema stays **5**, using Node **24.14.1** built-in `node:sqlite`, strict schema
validation, rollback journal **DELETE**, `synchronous=EXTRA`, existing revision
CAS and append-only history on a single host. No historical migration changes.

## H. Execution attempt semantics

The v5 row exists before providers as `execution_record_created`, already
uncertain/reconciliation-required. After simulation or an interrupted path, the
integration may record the existing `markUncertain` event while the original
worker fence remains valid. Revocation/corruption is reported; it never falls
back to a privileged recovery write.

`invocationRecorded` stays false. Neither `recordSimulatedInvocation` nor
`recordSubmissionIntent` is called. Public simulator evidence is insufficient
for those existing APIs. No signed wire or transaction ID is written to v5 as
submitted evidence. A matching observation cannot clear this hold.

## I. Observation integration

An optional trusted synchronous fixture planner receives the current attempt.
Its output is revalidated by `validateOfflineReadPlan` and must select that
exact attempt ID, identity and revision before any reads. Existing offline
sources then provide status, transaction and raw account fixtures through the
existing adapter. With no planner/sources the result is `observation_pending`.

**Composition gap:** the adapter returns non-authorizing protocol DTOs, not the
process-local trusted v5 mutation token. Integration does not promote a DTO into
that token or update the ledger from fixture finality. Independent historical
inspection is read-only and may examine revoked-worker history without granting
that worker permission to continue.

## J. Finality and account-state rules

Existing reconciliation retains missing, timeout, incomplete, failed-finalized,
processed/confirmed, conflicting-source and matching-finalized classifications.
It validates transaction identity, both role signatures, canonical message,
account program ownership, raw layouts, PDA relationships and milestone state.
A matching finalized candidate remains **offline fixture evidence**, never
authenticated on-chain proof or permission for retry/reservation release.

The integration independently checks the **current job** fence after awaited
observation. The old observer sees immutable intent fields and a flag already
set to reconciliation-required; that view alone cannot always reveal later job
revocation. A retained matching fixture can therefore accompany `stale_worker`.
It is retained evidence, not accepted authority or a state transition.

## K. Crash and recovery behavior

Tests kill owned child processes before/after job creation, after preparation,
before/after execution creation, before/after each role provider, before/after
the uncertainty event, during observation, after matching evidence and after
revocation. A new connection validates committed v5 history. No committed
reservation is cleared, intent replaced, signature request replayed or uncertain
operation automatically retried.

`inspect({mode: "offline-only", attemptId, identity, revision})` checks real
historical records and can run read-only fixture reconciliation. It never calls
verification, authorization, policy consumption or signature providers. It
returns `verification: null` and `simulation: null`. Corrupt history fails closed.
Some crash windows precede intent/attempt creation; their committed job remains
reserved and is not automatically repaired by this component.

## L. Remaining operational blockers

There is no operational custody, signer, relayer, authenticated RPC admission,
durable signed-wire provenance, live reconciliation, approved retry mechanism,
public execution API or deployed-program validation here. Existing offline
records must not be relabeled as operational attempts. SQL CAS does not fence
external signer or RPC effects. The signed-wire, trusted-observation mutation
and complete-verification persistence gaps above are deliberate boundaries;
they require separate approved designs rather than convenience bypasses.

## M. Required human approvals

Harshita authorized this isolated offline integration and its review PR, not a
merge or operational activation. Do not infer Palak approval. Joint review is
required for shared Rust definitions, on-chain ABIs, layouts, PDA/state or
financial-policy changes; none are changed here. Operational custody, signer
roles, durable storage/privacy policy, RPC/provider provenance, retry/recovery
policy and any deployment or wallet-generation step need explicit later approval.

## N. Future live Devnet activation plan

Review the remaining protocol/custody/provenance gaps first; design any new
authority-bearing boundary in a separate PR with crash and adversarial tests.
Obtain approved public program/mint/operator bindings and provider configuration
from the team; verify configured deployment and roles read-only under separate
authorization. No endpoint, public identity or signing-service URL is invented
by this phase. Approve operational custody and fenced submission/reconciliation
before connecting any transport. Then separately authorize a narrowly scoped
Devnet-only DEMO-token rehearsal. Deployment, live signing, token operations and
transaction submission remain disabled until those explicit approvals exist.

## Validation

New integration tests exercise the real service/coordinator/policy/store/simulator
and observer, with external fixture dependencies. Separate real-process tests
cover thirteen crash windows. The existing verifier glob runs both in CI; the
six-job pinned workflow remains intact. Full regressions cover lifecycle,
finance, native Rust, four ABI/layout comparisons, keyless SBF, core LiteSVM and
actual-client runtime bridge tests, dependency policy and whitespace checks.
Local and hosted execution counts belong in the PR evidence; this document does
not claim a live Devnet transaction or complete application validation.
