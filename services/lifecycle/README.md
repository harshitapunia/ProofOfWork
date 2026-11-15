# Lifecycle readers and local reservation storage

IMPLEMENTED: validated read-only lifecycle observations, durable public
reservations and verification-job coordination with database worker fencing.
IMPLEMENTED: append-only offline mock handoff intent/receipt journal (schema v3).
PLANNED: transaction submission, confirmation ingestion, operational signer
authorization, operational transaction reconciliation and external-side-effect
fencing. [Durable job design and APIs](../../docs/VERIFICATION_JOBS.md) define
the separate worker and trusted recovery-control facades.
Nothing here signs, sends, retries, releases an ID or authorizes an attestation.

## Architecture decision

| Choice | Assessment |
| --- | --- |
| SQLite / Node built-in API | Chosen for this single-host prototype: transactions, uniqueness, bounded lock waits and crash recovery without a service or native npm addon. Real temporary-file tests exercise multiple connections/processes. |
| PostgreSQL | Appropriate future option for independent hosts and service operations, but adds server credentials, provisioning and deployment work not required here. No PostgreSQL/Redis/ORM introduced. |
| Plain files | Atomic rename alone does not coordinate allocation, multi-record uniqueness and history across processes. Building locking/journaling/recovery would duplicate database responsibilities. |

Node is pinned to 24.14.1, matching backend CI. Its built-in node:sqlite
DatabaseSync API is experimental (the runtime warning is retained); the tested
runtime embeds SQLite 3.51.2. Reassess this API on Node upgrades. No additional
SQLite npm runtime dependency is installed. The package reuses the local finance
client, Web3 1.98.4 and its reviewed Jayson override. Locked installs and the
zero-finding npm security gate include this package.

SQLite 3.51.2 has the known WAL-reset corruption defect fixed in 3.51.3.
This module therefore requires rollback-journal DELETE mode and synchronous=EXTRA;
it does NOT enable WAL on this pinned engine. The bug is specific to concurrent
WAL writers/checkpoints. No claim is made that this runtime fixes it. WAL support
would require a separately reviewed patched runtime and new tests. Rollback
journaling permits coordinated writers/readers but readers may delay writer
commits; bounded busy errors are an expected outcome, never an excuse to retry
transactions or reuse reservations. See [SQLite's WAL-reset disclosure](https://sqlite.org/wal.html#walreset).


All participants MUST use the same database file on the same host, on a reliable
local filesystem. SQLite does not provide coordination across independent hosts or
databases; network filesystems are unsupported. No filesystem-type autodetection
or distributed lock is claimed. DatabaseSync is synchronous and can block up to
the configured busy timeout: run coordination in dedicated workers, not a
latency-sensitive HTTP handler. The default is 1000 ms, configurable from 0 to
5000 ms; lock contention fails with storage_busy and never silently retries.

## Local initialization

From the repository root, using pinned Node and locked dependencies:

    npm --prefix packages/finance-client ci --ignore-scripts
    npm --prefix packages/finance-client run build
    npm --prefix services/lifecycle ci --ignore-scripts
    npm --prefix services/verifier ci --ignore-scripts
    npm --prefix services/verifier run build
    npm --prefix services/lifecycle run check
    npm --prefix services/lifecycle test
    npm --prefix services/lifecycle run test:layouts

After the three locked package installations, the lifecycle test script explicitly
builds finance-client and verifier prerequisites before lifecycle/tests. Those
verifier artifacts serve compatibility and non-hydratable authorization tests;
production lifecycle code does not import verifier modules. The test script
does not install dependencies or upgrade packages. Compiled layout checking uses the existing offline Rust ABI exporter
infrastructure and requires the repository Rust dependencies/toolchain.

Construct LifecycleStore with an absolute application-owned local database path
whose parent directory already exists. No default application path or live data
is selected by this module. New files use mode 0600; existing symlink/nonregular
database paths are rejected. Operators must secure the parent directory, existing
files, journal sidecars and backups against substitution and unauthorized writers.
The database contains public metadata, but is not trusted as authorization.
No real database is created by importing the package.

## Schema and migration

Initialization uses BEGIN IMMEDIATE, application_id=0x504f574c and user_version=4.
Version 1's exact three reservation tables are unchanged. The explicit v1-to-v2
migration first validates that original schema, then adds two job tables and
four pinned integrity triggers. V3 validates the exact v2 schema and adds one append-only offline handoff journal
and two integrity triggers without changing v2 job histories. Empty v0 databases
initialize all versions atomically. Current v4 requires the exact full schema; foreign application IDs,
unexpected objects, altered schemas and unsupported versions fail closed.
All DDL and version updates commit atomically. Record/history reads share a
consistent SQLite read transaction, so concurrent commits cannot mix revisions. No destructive migration, implicit
downgrade or schema repair is provided. Future versions need explicit reviewed
migrations and migration tests; this SQL schema is not an on-chain ABI.

- counters: primary key (kind, scope), next unsigned ID as fixed-width 20-digit
  decimal TEXT; NULL marks exhaustion. Internship scope is sponsor, milestone
  scope is internship PDA.
- reservations: public UUID primary key, kind/scope/value, globally unique
  derived address, unique (kind, scope, value), immutable public binding tuple
  and its SHA-256 consistency digest, state/revision, optional message digest
  and supplied public transaction identifier. SQL CHECKs constrain shapes/states.
- history: foreign key to reservation and unique (reservation_id, revision),
  retaining every committed state change. Records and counters have no delete
  or release API.

IDs stay bigint in the API. SQLite signed INTEGER is not used for u64 values:
20-digit TEXT covers the full 0..18446744073709551615 range losslessly. Allocation
updates a counter, inserts the unique reservation and inserts history in one
BEGIN IMMEDIATE transaction. Each success returns a different monotonically
increasing ID within that scope. Failed transactions roll back all three writes.
The maximum ID can be issued once, then id_exhausted; no wrapping or recycling.

reserveInternship(sponsor, minimumId=0n) and reserveMilestone(internship,
minimumId=0n) can raise, never lower, a scope's high-water mark. For a fresh scope,
the first default ID is 0. Existing scopes MUST be bootstrapped from a separately
validated historical/on-chain allocation inventory before use: a new/old backup
database cannot infer IDs previously issued elsewhere. Do not create a second
independent database to bypass exhaustion or conflicts. An on-chain collision
is still possible with outside writers and must be reconciled; it never grants
permission to reuse a local reservation.

## Reservation lifecycle and API

- reserveInternship / reserveMilestone atomically allocate and retain an ID.
- reserveFallback derives the exact existing client seeded destination from
  caller/seed and binds sponsor, student, internship ID, milestone ID and derived
  milestone. Same caller/seed/address conflicts even with different operation
  bindings or a failed prior operation. A seed is public coordination metadata,
  not signing material. This does not change settlement v2 or refund policies.
- get returns a frozen validated public record. listOutstanding provides bounded
  UUID-keyset pages (maximum 100); start a fresh scan after restart. Scans are not
  a work queue, lock, lease or globally consistent snapshot during new inserts.
- history returns accepted state revisions. transition requires exact expected
  revision and strict metadata, with transactionally enforced compare-and-swap.
- close is idempotent; each participating connection must be closed.

State transitions implemented:

    reserved -> prepared -> pending
    reserved/prepared/pending -> failed or reconciliation

Prepared binds a nonzero exact message digest once. Pending requires an existing
prepared binding and a syntactically valid public 64-byte transaction ID supplied
by trusted application code; the library never generates a signature. These
states report local coordination only, not proof of signing/submission.
Failed is a local failure classification, not a confirmed on-chain failure.

Timeouts/crashes/ambiguous external outcomes retain reservations and require
reconciliation. A crash may leave a record in its last committed local state;
discover it on restart, and do not infer no transaction was sent. No transition
out of failed/reconciliation, automatic retry, ID release or ID reuse exists.

Confirmed is an explicitly reserved schema/model state, but this phase provides
NO confirmed-state writer. A persisted confirmed claim is rejected as
corrupt_store: there is no independently verified transaction-evidence ingestion
adapter yet. Account observations alone cannot confirm this prepared operation.
A future reviewed confirmation/reconciliation integration must bind finalized
transaction evidence to the exact public operation/message and use atomic CAS;
it must not trust request JSON, caller booleans or a database status. The existing
verifier recovery classifier and process-local authorization tickets are
untouched and are not hydrated from this ledger.

Malformed rows, changed binding consistency digests and unknown states fail
closed. The digest is corruption detection, not protection against an attacker
who controls the database and can rewrite both data and digest. Host/database
security remains required; no reservation supplies signing authority.

## Lifecycle readers

Exports: decodeInternship, decodeMilestone, decodeSubmission,
decodeCompletionRecord and DevnetLifecycleReader.

Decoders require exact owner, non-executable data, canonical base64, exact
Anchor discriminator/length, canonical PDA and stored bumps. Milestone validation
binds internship/sponsor, approved DEMO mint, verifier/student roles, reward,
requirements hash, enum, deadlines, submission pointer and verification time.
Submission/completion validation binds the validated parent, student,
commitments and timestamps. Parents are frozen process-local decoded records;
serialized or manually constructed parent objects are not accepted as validated.
All IDs, rewards and signed timestamps are bigint. Structurally encoded negative
timestamps are rejected wherever the approved lifecycle requires positive times.

readInternship(sponsor,id) returns one validated account observation.
readMilestone(sponsor,internshipId,milestoneId) fetches internship, milestone,
submission and completion in ONE final batch and validates their relationships.
Missing required accounts yield missing_account; malformed accounts yield
invalid_account. Inactive future PDAs may be absent or empty System-owned
prefunded accounts; they are not treated as program records.

RPC is fixed to the existing approved Devnet endpoint and checks the approved
genesis on each read. Only getGenesisHash/getMultipleAccounts are available;
there is no endpoint substitution or arbitrary-method helper. Default commitment
is confirmed; finalized is supported explicitly. Each response is bounded to
16384 bytes and each request to 10 seconds, with redirects refused. JSON-RPC
version/ID, error envelope, response length and context slot are checked.
Transport/malformed RPC failures are rpc_failure; wrong genesis is wrong_cluster.
Slots are safe integers, account u64/i64 fields remain bigint.

These snapshots can become stale immediately; even finalized account state does
not identify or confirm a particular prepared transaction. Readers do not
validate escrow token balances or replace financial instruction checks.
On-chain ownership, authorization, lifecycle and financial invariants remain
authoritative. No production verifier, signer, transaction policy, recovery
classifier or finance-client builder behavior is changed.

## Crash recovery, backup and limits

Rollback journaling plus synchronous=EXTRA and transactional uniqueness protect committed
allocations across ordinary process crashes, subject to correct OS/filesystem
sync behavior. Tests kill isolated processes after committed writes and during
uncommitted counter updates, then reopen the real database. They are not a
power-loss, disk-corruption, network-filesystem or malicious-storage proof.
Uncommitted writes roll back; committed IDs and history remain consumed.

Use a consistent SQLite backup mechanism, or quiesce ALL writers/connections and
close before copying. Do not copy only the main file while live database
transactions or recovery journals exist. Protect and retain backups. Restoring an older backup can
lose later reservations: halt new allocation, reconcile external/on-chain
history and restore high-water marks/outstanding operations before resuming.
Lost/corrupt storage fails operationally; it must not trigger a fresh-ID reset.

No private keys, seed phrases, GitHub tokens, raw evidence, nonces, API secrets or
private acceptance logs are stored. APIs accept only public keys/IDs/seeds,
digests and coordination state. No generic JSON/blob/log persistence API exists.
Stable errors contain codes rather than SQL, paths, credentials or row contents.

Hosted CI runs this suite in the existing verifier job, the compiled layout
comparison in the existing ABI job, and the package audit in the Node security
job. All databases/processes are isolated fixtures; no production service,
credential, wallet or blockchain transaction is required.

References: [Node 24 SQLite](https://nodejs.org/download/release/v24.14.0/docs/api/sqlite.html),
[SQLite WAL](https://sqlite.org/wal.html).

See [durable offline authorization](../../docs/OFFLINE_AUTHORIZATION.md) for the
server-internal composition, journal API semantics and conservative crash recovery.
Journal metadata grants no signing authority.

## Offline transaction intents (schema v4)

[Transaction intent design and APIs](../../docs/TRANSACTION_INTENTS.md) add immutable
offline preparation bookkeeping to the same database. V4 validates the exact v3
schema and adds two tables/four integrity triggers while retaining all prior
records. Direct metadata assertions grant no authorization. Created/uncertain
intents remain consumed and the separate preparer never resumes an existing row.
