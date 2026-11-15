# Durable verification jobs: internal coordination, not authorization

IMPLEMENTED: operation-level idempotency, transactional claims, database fencing,
durable pre-transaction history and explicit interruption bookkeeping in the
existing lifecycle database. PLANNED: authenticated application orchestration,
live worker scheduling, evidence-gated transaction reconciliation, signer custody,
external fencing and operational signing/submission. No HTTP or browser API is added.

## Existing boundaries preserved

| Component | Existing authority and persistence boundary |
| --- | --- |
| VerifierService | Authenticates GitHub user/repository/PR/commit/tree/blob, checks existing evidence/requirements commitments and before/after chain state, runs the pinned sandbox suite. Unchanged. |
| AttestationAuthorizer | Fresh trusted verification issues a single-use, expiring WeakMap ticket. Tickets are process-local, nontransferable and cannot be serialized/restored. Unchanged. |
| AttestationTransactionPolicy | Consumes a genuine ticket and validates exact message/accounts/payer/blockhash/fresh state. Its approvals are also process-local. Unchanged. |
| Offline recovery classifier | Branded RecoveryAttempt/RecoveryObservation objects classify transaction-related observations; they are not durable authorizations. Unchanged. |
| Lifecycle reservations | Durable ID/fallback uniqueness, revision CAS and retained ambiguous reservations. Original v1 tables and public behavior preserved. |
| Verification jobs | New durable coordination snapshots and public audit outcomes; never signing eligibility, ticket restoration, transaction success or payout confirmation. |

The existing RecoveryStore interface requires provenance-branded RecoveryAttempt
objects. Implementing it by deserializing rows would weaken its contract.
This phase instead adds a small pre-transaction job abstraction. It does not
implement RecoveryStore, fabricate RecoveryObservation, or hydrate existing
WeakMaps/WeakSets. Future reconciliation needs independently authenticated
evidence and a separately reviewed integration; job metadata cannot supply it.

## One shared local database and explicit migration

LifecycleStore owns the same single connection lifecycle and guarded transactions
for reservations and jobs. No second database, PostgreSQL, Redis, ORM or dependency
is added. The Node pin remains 24.14.1 with experimental node:sqlite, rollback
journal DELETE, synchronous=EXTRA, bounded busy waits and strict schema validation.
WAL remains forbidden on this pinned engine. All processes must share the same
local database on one host; network filesystems and independent-host coordination
are unsupported.

Schema version 2 retains the exact three v1 reservation table definitions and
adds two STRICT tables:
- verification_jobs: permanent UUID job identity; unique canonical creation ID
  and operation key; ordered public bindings/digest; immutable identity; mutable
  state, revision, generation, worker, local outcome and recovery reason.
- verification_job_history: one unique (job_id, revision) append-only event per
  accepted mutation, foreign-key bound to its permanent job and hash-chained to
  the immutable identity, revision, previous digest and canonical event tuple.

Four pinned triggers forbid job deletion/identity updates and history deletion/
updates. These stop accidental SQL mutation; an attacker controlling the database
file/schema can bypass them. Hash chains detect inconsistency, not hostile storage
that rewrites every row and digest. The database is not an authorization authority.

Every open holds BEGIN IMMEDIATE for migration. Fresh v0 must be empty and have
no application identity, then creates v1, v2 and v3 in one transaction. Genuine v1
must match its exact schema/application ID BEFORE adding any v2 objects.
Existing v2 must match all five tables/four triggers exactly before explicit v3 migration. Foreign, altered,
unexpected or unknown-version schemas fail closed; no IF NOT EXISTS, implicit
repair or downgrade is provided. DDL and current user_version=3 commit or roll back
together. The v1 fixture is the actual approved implementation from main
894f603523001ffb050d95bb5e87c278fbd41202 with only its import relocated; migration
tests create real v1 reservations/history through that implementation.

Quiesce all old workers, take a consistent backup and upgrade all participating
processes before enabling this module. Old v1/v2 binaries reject v3 on open; stop old processes before upgrading.
Do not copy just a live main database file or reset counters after restoring an
old backup. Restore reservation/job histories and reconcile external activity
before resuming. Migration tests kill a process after partial uncommitted
migration DDL/version writes and verify rollback before the normal migrator runs.
These are process-crash tests, not a power-loss/filesystem-corruption guarantee.

## Immutable identity and idempotency

Bindings contain only public, bounded canonical values:
Devnet cluster/genesis/program; sponsor; internship ID/PDA; milestone ID/PDA;
submission PDA; student/verifier; requirements/evidence commitments; GitHub
repository/contributor numeric IDs; exact lowercase SHA-1 commit; and
verificationSpecHash. PDA helpers and existing public identities are reused.
The specification identity MUST equal the existing committed requirements hash,
which already identifies the exact manifest/tests/runner. No new evidence
commitment or manifest format is introduced. IDs are canonical decimal u64
strings, not rounded numbers.

Security-sensitive identity uses a fixed field-order ARRAY, independent of object
property insertion order. A namespace-separated storage digest includes the UUID,
canonical first creation ID and those bindings. This digest is not an attestation.

operation_key is permanently unique by Devnet program and milestone. A new request
ID cannot create another job or replace bindings. Identical repeated requests
return the same job, including after rejection/closure; changed evidence,
roles/repository/commit/specification fail job_conflict. A canonical creation ID
already used for another operation also conflicts. Only the first creation ID is
retained: later request labels returning an existing operation are not persisted
as additional aliases or attempts, and never alter job identity.

Structural validation is not proof of live GitHub or on-chain identity. Trusted
application code must perform the existing authoritative checks; do not wire
createOrGetJob directly to untrusted request JSON. Incorrect trusted metadata can
reserve/block an operation. No generic JSON, credentials, private manifest,
evidence preimage/nonce, Docker output or private logs can be persisted.

## State machine and fencing

    created -> claimed -> verification_running -> verification_completed
                                             \-> verification_rejected -> closed
    verification_completed -> authorization_pending
    claimed / verification_running / verification_completed / authorization_pending
        -> recovery_required (explicit control-plane interruption)

verification_completed means a trusted worker recorded a local passed outcome,
not that this ledger executed verification or issued authorization.
authorization_pending records intent/uncertainty BEFORE a future authorization
boundary; no ticket is stored or returned. signingAuthorization is always the
constant not_granted. No submitted/confirmed/paid state exists.

claimJob atomically checks revision/identity and issues a generation-bound claim.
Only created or explicitly interrupted pre-authorization verification is claimable.
Every worker mutation checks UUID, immutable identity, worker ID, current generation
AND expected revision within BEGIN IMMEDIATE, then atomically updates the head and
appends history. Protected events retain their worker/generation for replay
validation. Ordinary workers cannot replace a current claim, even with the same
worker ID or a new request ID. Snapshot/history reads use one read transaction.

There are NO clocks, leases, expiry-driven release or automatic retries.
The separate jobRecovery capability belongs only to trusted control-plane code.
interruptJob invalidates the prior generation, clears its worker and records a
computed reason. Reclaiming increments generation again. Old workers remain
fenced from database mutation even if they are alive and know the new revision.

Only claim_interrupted and verification_interrupted recovery reasons permit a
new claim for a complete fresh verification run. Completed verification without
a process-local ticket, or authorization-related uncertainty, stays blocked.
An interrupt cannot transform these into a safe restart by repeating the call.
Rejection can close only through the owning claim; closed jobs are permanent
tombstones, never deleted/recreated to permit another authorization attempt.

Claims are PUBLIC coordination metadata, not authentication secrets. Trusted
backend identity/access control remains required; the library does not protect
against a malicious administrator or a caller impersonating a trusted worker.
Pass only the worker facade to workers, never the store/recovery control.
No database generation fences Docker, an RPC, a signer or Solana. Future trusted
handoff must enforce its own fence and record intent before possible side effects.
A stale process can still run external work; this phase does not claim exactly-once
external execution or that revocation burns an existing verifier ticket.

Each job permits at most 256 accepted mutations; generation is a bounded safe
integer and never wraps. Exhaustion fails job_exhausted, retains identity/history,
and requires future reviewed policy, not history pruning or a replacement job.

## Internal API and restart behavior

Construct the existing LifecycleStore(path,busyTimeoutMs). No new default path is
chosen and importing creates no database.

store.jobs (frozen worker/read facade):
- createOrGetJob(creationId, bindings)
- claimJob(jobId, identity, expectedRevision, workerId) -> frozen job/claim
- transitionJob(claim, expectedRevision, nextState) -> frozen audit snapshot
- getJob(jobId)
- getJobHistory(jobId)
- listRecoveryRequired(afterId?,limit=100) -> frozen entries and nextAfter cursor

store.jobRecovery (separate frozen trusted-control capability):
- interruptJob(jobId, identity, expectedRevision, operatorId)

All input data are validated/copied, outputs immutable, SQL failures sanitized
through existing LifecycleError codes. New failures include job_conflict,
stale_claim and job_exhausted, alongside conflict/invalid_transition/corrupt_store.
The public APIs expose no SQL handle, signer, transport, credential loader, ticket
or instruction builder.

On restart, read-only classifications distinguish never_claimed,
claimed_unfinished, verification_unfinished, verification_completed_locally,
verification_rejected_locally, authorization_uncertain and reconciliation_required.
A claimed/running record does not prove its worker is dead; the trusted control
plane must decide whether interruption is justified. Missing records never prove
external work did not occur. Timeout/absence never permits signing or resubmission.

Recovery scanning validates even closed rows before filtering and is bounded to
100 rows per page. Continue with nextAfter even if a page has no visible entries.
Pages are not a work queue, lease or cross-page snapshot. No automatic recovery
executor is included; blocked work stays visible and retained.

## Validation

Install the existing finance/verifier/lifecycle locked dependencies first.
The lifecycle test script explicitly builds finance/verifier prerequisites, then
lifecycle and its tests; direct runs do not depend on stale generated artifacts.
The standalone lifecycle typecheck still needs finance-client declarations built.
The current workflow's lifecycle test glob includes all new tests in the existing
verifier job; all six jobs, pins, read-only permissions and audit gates remain.

New tests exercise actual SQLite locking and uniqueness with two/eight worker
threads and four separate Node processes, IPC/shared-memory barriers, revocation,
stale revisions/generations, restart, SIGKILL during work and uncommitted writes,
genuine v1 migration, schema/history tampering, injected append rollback and
permanent closure/idempotency. No sleep-based lease races or real database data
are used. Stored job JSON is explicitly rejected by the unchanged authorizer,
transaction policy and offline recovery classifier.

No live signing, transaction, Devnet deployment, public HTTP route, production
scheduler or full application readiness is established.

## Offline composition and schema v3

The [offline authorization composition](OFFLINE_AUTHORIZATION.md) now reuses these
unchanged job transitions and adds a separate append-only mock handoff journal.
V2 schemas and histories remain unchanged. Schema v3 migration validates exact
prior schemas transactionally. A receipt is local mock evidence, never a signer
authorization or blockchain acknowledgment. The original non-durable coordinator
remains available; callers needing cross-process coordination must use the new
internal DurableOfflineCoordinator with one shared trusted store.
