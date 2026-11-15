# Offline transaction-intent ledger (Phase 8A)

## Trust boundaries and architecture decision

IMPLEMENTED: extend the existing trusted, single-host lifecycle SQLite
database with an explicit transactional schema v4. This ledger is bookkeeping,
permanent idempotency, preparation audit and crash-recovery evidence only.
No row, digest, intent identity or historical mock receipt grants signing,
submission, retry or confirmation authority. No signer, transport, HTTP route,
private key or second database is introduced.

Existing finance builders construct unsigned instructions. VerifierService,
AttestationAuthorizer, AttestationTransactionPolicy and the existing coordinators
retain verification and authorization responsibility. Durable jobs retain canonical
operation bindings and worker fencing. V3 mock receipts and the offline recovery
classifier retain their original meanings; neither becomes a transaction signature.

Keep preparation separate from authorization. A new internal offline preparer
builds the sole unsigned legacy attestation with the existing attestation
builder, validated fresh trusted chain bindings and blockhash observations. It
accepts no caller transaction bytes or approval JSON. It records only the public
message digest and lease metadata, returning a defensive message copy. Storage
accepts strictly shaped public bookkeeping assertions from trusted backend code;
it does not certify those assertions as authorized or permit their later use to
reconstruct a ticket. Operational signer integration remains PLANNED. The optional\n[ephemeral test path](SIGNER_ARCHITECTURE.md) creates a NEW intent during genuine\npolicy consumption; it never promotes this preparer or an existing row.

## Identity and permanent operation reservation

One permanent intent per verification job (therefore per program/milestone
operation), even after rejection, uncertainty or reconciliation. The canonical
first request ID and UUID are retained. Another request label can retrieve the
same intent but cannot change payer or reserve a new intent for the operation.

Intent identity hashes a fixed ordered domain-separated tuple of UUID, first
request ID, job ID, immutable job identity, operation key, separate fee payer and
legacy unsigned-attestation format. Existing immutable job bindings provide
Devnet/genesis/program, internship, milestone, submission, student, verifier,
requirements/evidence, GitHub identities and specification identity without
duplicating their full representation in another table.

A preparation identity additionally binds exact message SHA-256, message format,
blockhash and decimal-string last-valid/observed block heights. Bigint-safe u64
metadata never uses SQLite signed integers or unsafe JavaScript coercion.
Neither digest changes the existing evidence commitment algorithms.

## State and fencing model

Implemented offline transitions:
- created -> preparation_recorded / preparation_rejected / preparation_uncertain
  / reconciliation_required.
- preparation_recorded / preparation_rejected / preparation_uncertain ->
  reconciliation_required.
- reconciliation_required is terminal.

There are no signed/submitted/confirmed/settled states and no replacement message.
Identical recordPreparation calls may return the existing record with no append;
changed preparations conflict. Expected intent revision still applies.

All worker writes check the job's current identity, worker, generation,
expected job revision and authorization_pending state in the same BEGIN IMMEDIATE
transaction as the intent write. They also require the intent's original worker
generation and expected intent revision. Job bookkeeping is not signing authority.
Revocation never lets the former worker escalate or clear a row. Reads/lists
conservatively flag revoked/changed-job intents as requiring reconciliation.
There is no post-revocation writer or automatic recovery reset in this phase.

## Migration and crash policy

V4 adds an intent table, append-only hash-chained history and immutable/no-delete
triggers. Historical v1/v2/v3 SQL definitions remain unchanged. Fresh initialization
and exact prior-schema transactional migration are required. Genuine provenance-
checked historical stores create migration fixtures.

Intent creation precedes async preparation. Crashes before creation leave no
intent; an uncommitted insert/transition rolls back. Created, uncertain and recorded
intents remain permanently consumed after restart. Missing acknowledgment does not
prove no effect. A prepared digest is only local evidence, never proof of signing.
A stale/revoked worker cannot record success. No SQLite lock spans async reads.

## Future operational requirements

PLANNED Phase 8B/8C: independently authorized signer and fee-payer custody, exact
approved message signing with all required signatures, durable submission intent,
signature identity, authenticated RPC acknowledgment/confirmation observations,
expiration/reconciliation and external idempotency/fencing. A local database check
followed by an external call has an unavoidable race; this phase does not solve
external fencing or claim exactly-once execution. DB-owner tampering, backups,
single-host filesystem trust, authenticated orchestration and private recovery
control remain operational prerequisites. DELETE/EXTRA and pinned Node 24.14.1
remain mandatory; WAL is not enabled.

## Internal APIs and preparation boundary

store.transactionIntents provides:
- createIntent(claim, jobRevision, requestId, feePayer), returning frozen
  {intent, created}. Only the canonical first request ID is retained; later
  labels are aliases, not new globally reserved request identities.
- recordPreparation(claim, jobRevision, intentId, identity, intentRevision, metadata).
- rejectPreparation / markPreparationUncertain / requireReconciliation with the
  same job fence, intent identity and expected revision.
- getIntent, getIntentHistory and bounded keyset listOutstandingIntents.

Every record includes signingAuthorization: not_granted, submissionAuthorized:
false and retryAuthorized: false. Public job bindings are derived on reads from
the retained job, not copied into a second mutable binding blob. Preparation
metadata accepts exact own-data fields only; extra instructions, byte payloads,
signatures, result JSON, operational transaction IDs and status claims are rejected.

OfflineTransactionPreparer is server internal and not imported by HTTP routes.
It accepts only claim/jobRevision/requestId, with explicit trusted chain,
blockhash source and existing separate payer/verifier configuration. It first
creates the durable intent and proceeds only when that transaction reports
created: true. An existing created record is never resumed by this helper,
including by another process, request ID or restarted instance. This avoids a
fresh message after a previous process may already have computed unrecorded bytes.

The helper reuses buildAttestMilestoneInstruction, validates fresh chain bindings
before/after the trusted blockhash read, checks the lease shape/freshness and
constructs one legacy message. It persists its exact SHA-256 and lease metadata;
the returned bytes are a defensive copy. This is unsigned preparation, not an
AttestationTransactionPolicy approval. No process-local authorization ticket is
issued or consumed, and no stored result can be used to recreate one.

The direct storage API records trusted public assertions. It cannot prove that
an asserted digest came from the helper, chain validation or authorization.
Consumers must not infer those facts from persistence. Its only digest writer
cannot replace an existing preparation or write after uncertainty/reconciliation.
A created row is conservatively flagged reconciliationRequired until preparation
is recorded. After revocation the original worker cannot write even a
reconciliation escalation; reads expose the retained state plus that flag.
Privileged post-revocation reconciliation is future reviewed work, not a bypass.

## Exact schema v4

Two STRICT tables are added: transaction_intents (one UUID, canonical request ID,
unique job FK, immutable payer/identity and revision/state head) and
transaction_intent_history (at most three canonical hash-chained events).
Four triggers prevent intent deletion/identity rewriting and history
deletion/update. Full message bytes, signatures, credentials, evidence preimages
and transaction submission claims are not stored.

Canonical fixed-order tuples bind intent identity to the immutable job identity
and permanent operation, and preparation identity to intent identity and exact
message/lease metadata. History hashes include immutable intent identity,
revision, previous hash and the canonical event. Reads replay valid transitions
and verify the historical authorization_pending job revision/worker/generation,
then compare the derived state to its SQL head. Mutations validate both current
job fence and original intent fence in one transaction. History is never pruned.

Fresh v0 initializes v1/v2/v3/v4 atomically. Existing v1/v2/v3 must match their
exact historical SQL and application ID before migration. Genuine historical
stores create the records used by migration tests; v3 source hashes are pinned.
Failures/crashes during migration roll back DDL and version changes. Foreign,
altered, unexpected and unsupported schemas fail closed, without repair.
Stop all old binaries before upgrading; a v1/v2/v3 binary rejects v4 on open.

## Crash-window test matrix

| Window | Persisted result / deterministic test |
| --- | --- |
| Before intent creation | No intent; owned child stops before insertion |
| During insertion | Real factory transaction rolled back on SIGKILL |
| After creation | Created row retained, reconciliation flag true, helper refuses resume |
| Before message preparation | Same consumed created row; no reconstruction from metadata |
| During preparation | Actual preparer stops inside its trusted chain dependency |
| After digest computation | Actual preparer stops at record transaction entry |
| During preparation-record commit | Real factory head/history changes roll back together |
| After record commit / lost acknowledgment | Exact digest and recorded state survive; helper refuses another preparation |
| After worker revocation | All former-worker writes fail; reads flag reconciliation |
| After restart | Permanent identity/history remain, no new helper attempt or authorization |

Checkpoint synchronization uses IPC/pipes and SIGSTOP/SIGKILL on owned Linux
children, with bounded watchdogs. No crash-test correctness depends on sleeps.
Separate Node processes race actual create and record APIs against the same
SQLite file; uniqueness and revision CAS choose the accepted result.

## Scope and operational limits

The six existing backend CI jobs remain; default service test globs include the
new ledger, historical migration, concurrency, integrity and preparer crash tests.
No dependency changes, production Rust changes, serializer/ABI/layout/seed changes
or financial-policy changes are needed.

A database owner can rewrite hashes and data; these are integrity checks, not a
signature or hostile-owner authentication system. Trusted directory/backups,
exclusive service ownership, a shared same-host database and secure recovery
control remain required. Restoring an old database or using independent databases
can defeat local idempotency and requires operational reconciliation.

Prepared/recorded means local preparation evidence only. It never means signed,
submitted, confirmed, attested, paid or settled. Current blockhash metadata is a
snapshot, not proof of continuing validity; future operational use must obtain
fresh independent authorization and reviewed expiration/submission policies.
No mock handoff is converted or linked as submission evidence. If a future
association is introduced, it must independently match job identity and exact
message digest while continuing to grant no authority.
