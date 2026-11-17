# Operational journal and admission foundation

**IMPLEMENTED MODEL. PROPOSED DURABLE STORAGE. NOT OPERATIONAL.**
No migration, operational database writer, custody, key access, sender, live RPC,
public execution route, deployment or token operation is implemented here.
Passing model tests does not authorize any external effect or approve this schema.

## 1. Implemented model and reuse

`operational-journal-model.ts` supplies pure `proposeJournalModel`,
`appendJournalModel`, `replayJournalModel` and `validateJournalCollection` functions.
These perform real validation/transitions, not another readiness checklist.

They reuse the existing operational admission, role, signature, submission and
observation validators, classifications, canonical job bindings/message builder
and domain-separated `protocolDataDigest`. The sole protocol addition,
`validateHistoricalAdmission`, exposes the existing historical validation branch:
it returns the same non-authorizing data envelope and never renews authorization.
Existing fresh validators, authorizer, transaction policy, schema-v5 execution
reducer, offline coordinator and readiness assessment are unchanged.

See [protocol contracts](OPERATIONAL_PROTOCOL_CONTRACTS.md),
[operational architecture](OPERATIONAL_EXECUTION_ARCHITECTURE.md),
[readiness](DEVNET_EXECUTION_READINESS.md) and
[offline integration](SECURE_ATTESTATION_INTEGRATION.md) for their original scope.

## 2. Immutable identity and evidence separation

The immutable context contains the existing canonical `ProtocolAnchor` and
`AdmissionRequest`, original preparation identity and original comparison snapshot.
It binds Devnet/genesis/program, permanent operation, job/intent identities,
preparation, exact canonical message/digest, blockhash/lease, original deadline,
distinct verifier/payer, policy version, original epoch and admission identity.
The preparation digest is a supplied identity assertion, not independently
authenticated preparation provenance. Tests use a clearly synthetic digest over
the existing public fixture; no operational identity is invented.

An event contains exact revision, unique scoped event ID, kind, epoch, evidence
digest, bounded public projection, previous digest and digest. The initial previous
digest binds the version and immutable context; later events chain to their
predecessor. Projections contain labels/IDs/digests, never signatures or complete
signed wire. The protected reference is represented by its digest, not a bearer
retrieval URL/token. The context contains the original **unsigned** message.

Non-initial event payloads are **detached transient evidence inputs**. They are
not returned by model functions. Replay requires the complete sidecar and reruns
the existing validators, including actual signature and complete-wire validation;
it recomputes every projection and hash. Missing evidence fails closed rather
than trusting stored `signature_observed` labels. Keep any future real sidecar in
approved protected custody/evidence storage, never general logs or public results.
The tests' sidecar contains only pre-existing public test vectors.

The model is bounded at 128 events and collections at 32 journals. Payload bounds
are inherited from the existing validators; no unbounded arbitrary JSON is accepted.
Capacity exhaustion rejects; it never prunes, resets or releases an operation.

## 3. Admission, roles and signing claims

The first event is `admission_intent`/proposed. One `admission_outcome` may record
`accepted_claim`, `rejected_claim` or `uncertain_claim`. Only an accepted claim
permits further model admission. Rejection/uncertainty permanently blocks it.
References must agree with the original anchor, but agreement is not authentication.

Each independent role has one consumed request identity and admission claim.
`role_admission` reuses `CustodyRoleRequest` and `SigningOutcome`; a signature
cannot precede that role's admission. The existing `not_admitted`,
`admission_accepted`, `signing_rejected` and `signing_uncertain` vocabulary is kept.
An accepted role can record one terminal `signing_outcome`, including a genuinely
verified `signature_observed`. Repeated requests/outcomes reject. Verifier evidence
cannot satisfy payer admission/consent or vice versa. Ambiguity blocks further
admission, including the other role. This conservative model does not offer a
late second terminal role-outcome/re-sign recovery operation; that policy needs
separate review. Read-only historical receipt evidence for an already admitted
role can be inspected after expiry/revocation without reactivating anything.

New role, wire and first-send admissions use existing fresh comparison checks;
historical outcomes use existing historical checks. Supplied event snapshots
cannot regress clock/height, change source/margin policy, or substitute an epoch.
Replay of the original saved snapshot is deterministic history validation, not
permission to reuse its expired deadline for a new action.

## 4. Protected wire and first-send reservation

One `wire_reference` requires both recorded role signatures, unchanged role
request/outcome digests and the existing complete canonical transaction validator.
The model stores only protected-reference digest, wire digest and transaction ID.
It neither creates signatures nor returns the wire.

One `first_send_intent` then binds that exact submission digest and original
submission approval reference. A `submission_outcome` is invalid before it.
Existing states remain distinct: `not_admitted`, `intent_recorded`,
`invocation_potentially_occurred`, `acknowledgment_received`, `submission_uncertain`.
Outcomes cannot be replayed; an intent claim cannot follow possible invocation.
An acknowledgment may arrive without a local invocation marker, but must match
the precomputed transaction ID. A missing marker/ack is not non-execution proof.
Uncertainty remains latched after a later acknowledgment. No second reservation,
replacement message, signing retry, resubmission or reservation release exists.

## 5. Fencing, shutdown and recovery requirements

The model enforces consistency of supplied epochs, immutable admission/policy,
role consumption and monotonic comparison snapshots. `shutdown` strictly advances
the epoch, latches stopped/blocked state and preserves original admission identity.
`recovery_requirement` records the original operator reference and need for review;
it never unstops, reopens or clears uncertainty. No recovery capability is issued.

These are data comparisons. They are **not** local database CAS, authenticated
operator approval, a real clock oracle, custody fencing or sender-side enforcement.
The collection validator rejects duplicate operation/admission IDs only within
the supplied collection. Omitting old history can produce a valid model again;
no cross-process durable uniqueness or anti-rollback protection is claimed.

## 6. Observation and reconciliation claims

Observation events reuse existing `ObservationContract`, `validateObservation`
and `classifyObservation`. They bind exact signed transaction context, provenance,
status/finality/outcome and account metadata. Their source/event pairs are unique
within a model. Processed/confirmed/finalized, missing/timeout, conflict, failed
execution, mismatched account metadata and matching finalized claims remain
inspectable. This layer does not add a raw account decoder or live RPC reader.
Metadata consistency is not actual ownership/PDA/account-state authentication.

All claims remain append-only. Conflicting outcomes/errors/landing slots latch a
conflict; lower-finality or lower-trust data cannot erase prior claims. A matching
claim never clears ambiguity. Any transaction-history observation blocks new
admissions, including a later first-send reservation if its local marker was lost.
`offline_fixture` and `unverified_reference` are never promoted to authenticated RPC.

## 7. Security flags and limitations

Every journal and replay summary retains `operationalAuthorization:false`,
`signingAuthorization:"not_granted"`, `submissionAuthorized:false`,
`retryAuthorized:false`, `reservationReleaseAuthorized:false`,
`rpcAuthenticated:false`, `onChainStateVerified:false`,
`operationalStateMutationAuthorized:false`, `reconciliationRequired:true`.
Serialization restores only revalidated **claims**, never WeakMap/WeakSet authority.
Unknown fields, authority flags, altered identity/history, missing evidence and
invalid signatures reject with bounded error codes. No signer/sender interface,
network request, SQL writer, credential loader or environment fallback is added.

Hash chains detect changes against retained digests, not hostile-owner forgery.
A party controlling the entire history, evidence and comparison context can create
another consistent model or roll back to an internally consistent prefix. Neither
is authenticated operational history. Missing protected evidence blocks replay.
The host, custody/provider trust, complete durable history, external epochs,
retention and authenticated original authorization remain future requirements.

## 8. Interruption/restart tests — MODEL ONLY

Sixteen named prefix cases cover before accepted admission, proposed admission,
role admission, before signing, first/both signatures, before/after reservation,
possible submission, missing/before/after acknowledgment, observation, conflicts,
shutdown and restart. They serialize a retained prefix plus public fixture
sidecar, revalidate it and assert no capability/retry/release. They do not kill a
real custody/sender process or prove storage crash durability. The existing real
schema-v5 process-crash suites remain unchanged and run in full regression.

## 9. PROPOSED DURABLE STORAGE — approval required

Schema **v6 is necessary** for actual persistence: v5 explicitly stores offline
test executions and cannot encode authenticated operational provenance and
durable admission/effect records honestly. **No v6 migration is implemented or
applied.** The following is the exact proposed additive DDL, subject to approval.
Existing v1–v5 SQL definitions/migrations must remain byte-identical.

Five tables share the existing same-host SQLite database. There is no second
backend database or WAL. Preserve Node 24.14.1, built-in SQLite, foreign keys,
DELETE journal, EXTRA synchronization, bounded busy waits and BEGIN IMMEDIATE.
TEXT epoch values use the existing lossless u64 convention padded to 20 digits
for SQL ordering; public model decimal strings remain canonical unpadded values.

```sql
CREATE TABLE operational_purposes(
  operation_key TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES verification_jobs(job_id)
    DEFERRABLE INITIALLY DEFERRED,
  purpose TEXT NOT NULL CHECK(purpose IN ('offline','operational')),
  UNIQUE(operation_key,job_id,purpose)
) STRICT;
CREATE TABLE operational_admissions(
  admission_id TEXT PRIMARY KEY CHECK(length(admission_id)=36),
  format_version TEXT NOT NULL CHECK(format_version='proofwork-operational-journal-v1'),
  operation_key TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK(purpose='operational'),
  intent_id TEXT NOT NULL UNIQUE REFERENCES transaction_intents(intent_id),
  context_json TEXT NOT NULL CHECK(json_valid(context_json)
    AND length(CAST(context_json AS BLOB))<=16384),
  context_digest TEXT NOT NULL CHECK(length(context_digest)=64),
  issuer_evidence_digest TEXT NOT NULL CHECK(length(issuer_evidence_digest)=64),
  operator_evidence_digest TEXT NOT NULL CHECK(length(operator_evidence_digest)=64),
  payer_evidence_digest TEXT NOT NULL CHECK(length(payer_evidence_digest)=64),
  fence_evidence_digest TEXT NOT NULL CHECK(length(fence_evidence_digest)=64),
  auth_policy_digest TEXT NOT NULL CHECK(length(auth_policy_digest)=64),
  head_revision INTEGER NOT NULL CHECK(head_revision BETWEEN -1 AND 127),
  head_digest TEXT NOT NULL CHECK(length(head_digest)=64),
  FOREIGN KEY(operation_key,job_id,purpose)
    REFERENCES operational_purposes(operation_key,job_id,purpose)
) STRICT;
CREATE TABLE operational_events(
  admission_id TEXT NOT NULL REFERENCES operational_admissions(admission_id),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 127),
  event_id TEXT NOT NULL CHECK(length(event_id) BETWEEN 1 AND 80),
  kind TEXT NOT NULL CHECK(kind IN ('admission_intent','admission_outcome',
    'role_admission','signing_outcome','wire_reference','first_send_intent',
    'submission_outcome','observation','reconciliation_required','shutdown',
    'recovery_requirement')),
  epoch TEXT NOT NULL CHECK(length(epoch)=20 AND epoch NOT GLOB '*[^0-9]*'
    AND epoch<='18446744073709551615'),
  projection_json TEXT NOT NULL CHECK(json_valid(projection_json)
    AND length(CAST(projection_json AS BLOB))<=4096),
  evidence_digest TEXT NOT NULL CHECK(length(evidence_digest)=64),
  evidence_reference_digest TEXT NOT NULL CHECK(length(evidence_reference_digest)=64),
  source_id TEXT, source_event_id TEXT,
  previous_digest TEXT NOT NULL CHECK(length(previous_digest)=64),
  digest TEXT NOT NULL CHECK(length(digest)=64),
  PRIMARY KEY(admission_id,revision), UNIQUE(admission_id,event_id),
  CHECK((kind='observation' AND source_id IS NOT NULL AND source_event_id IS NOT NULL
      AND length(source_id) BETWEEN 1 AND 80 AND length(source_event_id) BETWEEN 1 AND 80)
    OR (kind<>'observation' AND source_id IS NULL AND source_event_id IS NULL))
) STRICT;
CREATE UNIQUE INDEX operational_source_event_once
  ON operational_events(admission_id,source_id,source_event_id) WHERE kind='observation';
CREATE TABLE operational_role_consumptions(
  admission_id TEXT NOT NULL REFERENCES operational_admissions(admission_id),
  role TEXT NOT NULL CHECK(role IN ('verifier','fee_payer')),
  request_id TEXT NOT NULL UNIQUE CHECK(length(request_id)=36),
  request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
  first_event_revision INTEGER NOT NULL,
  PRIMARY KEY(admission_id,role),
  FOREIGN KEY(admission_id,first_event_revision)
    REFERENCES operational_events(admission_id,revision)
) STRICT;
CREATE TABLE operational_first_submissions(
  admission_id TEXT PRIMARY KEY REFERENCES operational_admissions(admission_id),
  sender_admission_id TEXT NOT NULL UNIQUE CHECK(length(sender_admission_id)=36),
  submission_digest TEXT NOT NULL CHECK(length(submission_digest)=64),
  wire_digest TEXT NOT NULL CHECK(length(wire_digest)=64),
  transaction_id TEXT NOT NULL UNIQUE CHECK(length(transaction_id) BETWEEN 64 AND 88),
  protected_reference_digest TEXT NOT NULL CHECK(length(protected_reference_digest)=64),
  first_event_revision INTEGER NOT NULL,
  FOREIGN KEY(admission_id,first_event_revision)
    REFERENCES operational_events(admission_id,revision)
) STRICT;
```

The trusted future writer must enforce exact existing canonical/cryptographic
validation and authenticated source/policy/receipt admission, not just SQL lengths
or a `purpose` string. Digest columns are audit bindings, **not authentication**.
`context_json` holds canonical unsigned identity/deadline/policy/epoch data only.
Actual signed wire, partial signatures, raw role receipts and sensitive retrieval
references require approved protected custody/evidence retention; never put the
model's raw detached sidecar into `projection_json` or general audit logs.
The durable proposal uses a **separate operational-purpose format/domain**; do
not insert a serialized model or reuse its head as authenticated history. Exact
proposed header hash preimage is `protocolDataDigest([format_version, context,
issuer_evidence_digest, operator_evidence_digest, payer_evidence_digest,
fence_evidence_digest, auth_policy_digest])`. Exact proposed event hash preimage is
`protocolDataDigest([format_version, admission_id, revision, event_id, kind,
canonicalUnpaddedEpoch, projection, evidence_digest, evidence_reference_digest,
source_id, source_event_id, previous_digest])`. First previous digest is the
header hash. Nullable source fields are explicit null. These domains do not
authenticate the provenance digests: the approved writer must verify their sources.

### Exact proposed constraints/triggers

All five tables deny deletion. Purpose, role-consumption, first-submission and
event rows deny every update. Admission headers are immutable; only the checked
head may advance. Proposed SQL (not executed):

```sql
CREATE TRIGGER op_purpose_no_delete BEFORE DELETE ON operational_purposes BEGIN SELECT RAISE(ABORT,'op_retained'); END;
CREATE TRIGGER op_purpose_no_update BEFORE UPDATE ON operational_purposes BEGIN SELECT RAISE(ABORT,'op_immutable'); END;
CREATE TRIGGER op_admission_no_delete BEFORE DELETE ON operational_admissions BEGIN SELECT RAISE(ABORT,'op_retained'); END;
CREATE TRIGGER op_admission_immutable BEFORE UPDATE OF admission_id,format_version,operation_key,job_id,purpose,intent_id,context_json,context_digest,issuer_evidence_digest,operator_evidence_digest,payer_evidence_digest,fence_evidence_digest,auth_policy_digest ON operational_admissions BEGIN SELECT RAISE(ABORT,'op_immutable'); END;
CREATE TRIGGER op_event_no_delete BEFORE DELETE ON operational_events BEGIN SELECT RAISE(ABORT,'op_retained'); END;
CREATE TRIGGER op_event_no_update BEFORE UPDATE ON operational_events BEGIN SELECT RAISE(ABORT,'op_immutable'); END;
CREATE TRIGGER op_role_no_delete BEFORE DELETE ON operational_role_consumptions BEGIN SELECT RAISE(ABORT,'op_retained'); END;
CREATE TRIGGER op_role_no_update BEFORE UPDATE ON operational_role_consumptions BEGIN SELECT RAISE(ABORT,'op_immutable'); END;
CREATE TRIGGER op_send_no_delete BEFORE DELETE ON operational_first_submissions BEGIN SELECT RAISE(ABORT,'op_retained'); END;
CREATE TRIGGER op_send_no_update BEFORE UPDATE ON operational_first_submissions BEGIN SELECT RAISE(ABORT,'op_immutable'); END;
CREATE TRIGGER op_job_purpose AFTER INSERT ON verification_jobs BEGIN
  INSERT OR IGNORE INTO operational_purposes VALUES(NEW.operation_key,NEW.job_id,'offline');
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM operational_purposes
    WHERE operation_key=NEW.operation_key AND job_id=NEW.job_id)
    THEN RAISE(ABORT,'op_purpose_conflict') END;
END;
CREATE TRIGGER op_admission_binding BEFORE INSERT ON operational_admissions BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM verification_jobs j
    JOIN transaction_intents i ON i.job_id=j.job_id
    WHERE j.job_id=NEW.job_id AND j.operation_key=NEW.operation_key
      AND i.intent_id=NEW.intent_id)
    THEN RAISE(ABORT,'op_binding_conflict') END;
  SELECT CASE WHEN NEW.head_revision<>-1 OR NEW.head_digest<>NEW.context_digest
    THEN RAISE(ABORT,'op_initial_head') END;
END;
CREATE TRIGGER op_event_order BEFORE INSERT ON operational_events BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM operational_admissions a
    WHERE a.admission_id=NEW.admission_id AND a.head_revision+1=NEW.revision
      AND a.head_digest=NEW.previous_digest)
    THEN RAISE(ABORT,'op_stale_head') END;
END;
CREATE TRIGGER op_event_head AFTER INSERT ON operational_events BEGIN
  UPDATE operational_admissions SET head_revision=NEW.revision,head_digest=NEW.digest
    WHERE admission_id=NEW.admission_id;
END;
CREATE TRIGGER op_head_guard BEFORE UPDATE OF head_revision,head_digest ON operational_admissions BEGIN
  SELECT CASE WHEN NEW.head_revision<>OLD.head_revision+1 OR NOT EXISTS(
    SELECT 1 FROM operational_events e WHERE e.admission_id=OLD.admission_id
      AND e.revision=NEW.head_revision AND e.previous_digest=OLD.head_digest
      AND e.digest=NEW.head_digest) THEN RAISE(ABORT,'op_invalid_head') END;
END;
CREATE TRIGGER op_role_binding BEFORE INSERT ON operational_role_consumptions BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM operational_events e
    WHERE e.admission_id=NEW.admission_id AND e.revision=NEW.first_event_revision
      AND e.kind='role_admission'
      AND json_extract(e.projection_json,'$.role')=NEW.role
      AND json_extract(e.projection_json,'$.requestId')=NEW.request_id
      AND json_extract(e.projection_json,'$.requestDigest')=NEW.request_digest)
    THEN RAISE(ABORT,'op_role_conflict') END;
END;
CREATE TRIGGER op_send_binding BEFORE INSERT ON operational_first_submissions BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM operational_events e
    WHERE e.admission_id=NEW.admission_id AND e.revision=NEW.first_event_revision
      AND e.kind='first_send_intent'
      AND json_extract(e.projection_json,'$.submissionDigest')=NEW.submission_digest)
    THEN RAISE(ABORT,'op_send_conflict') END;
END;
CREATE TRIGGER op_no_mock_handoff BEFORE INSERT ON verification_offline_handoffs
WHEN EXISTS(SELECT 1 FROM operational_purposes p WHERE p.job_id=NEW.job_id AND p.purpose='operational')
BEGIN SELECT RAISE(ABORT,'op_not_offline'); END;
CREATE TRIGGER op_no_offline_execution BEFORE INSERT ON execution_attempts
WHEN EXISTS(SELECT 1 FROM transaction_intents i JOIN operational_purposes p ON p.job_id=i.job_id
  WHERE i.intent_id=NEW.intent_id AND p.purpose='operational')
BEGIN SELECT RAISE(ABORT,'op_not_offline'); END;
```

The future authenticated writer must insert the validated event and associated
role/send-consumption row in one BEGIN IMMEDIATE transaction. It verifies the
current job revision/generation, exact context/evidence, epoch claim and head CAS;
failure rolls back both rows and the trigger-updated head. No network call or key
access occurs inside the SQLite lock. The external custody/sender must durably
consume its authenticated admission **before** its effect and enforce the current
external epoch itself. No cross-store atomic commit or exactly-once effect is assumed.
Opening/replay must also require exactly one consumption-index row for every
role-admission/first-send event, with matching projected identity/digests, and no
extra index rows. A partial event/index commit is corruption, not a repair or retry
opportunity; the future API must test rejection of such commits and fail closed on
reopen. DDL length/FK checks alone do not validate this whole semantic projection.

### Exact proposed migration and rollback procedure

1. Obtain explicit schema/security approval. Stop all existing binaries and effects;
   create/verify a consistent same-host backup under DELETE/EXTRA. Confirm application
   ID `0x504f574c`, user_version 5 and exact unchanged v1–v5 SQL definitions. Unknown,
   foreign or altered schemas abort without repair.
2. In one BEGIN IMMEDIATE, execute the above additive table/index/trigger DDL, then
   `INSERT INTO operational_purposes SELECT operation_key,job_id,'offline' FROM verification_jobs;`.
   Every pre-existing job/intent/execution remains permanently offline. Validate the
   complete exact proposed v6 schema and all row/FK/integrity checks, set
   `PRAGMA user_version=6`, then COMMIT. Any failure/kill rolls back all DDL, data,
   trigger changes and user_version to exactly v5. Existing migration code is unchanged
   in this PR; future code must implement/review the exact schema comparison.
3. New operational jobs require a **new approved authenticated writer**: reserve an
   operational-purpose row with a new job UUID before creating that job in the same
   transaction (deferred FK). Default job creation labels new work offline. Purpose
   cannot change. A later matching row/digest cannot convert an offline job. The current
   APIs do not supply this atomic writer and are not silently reused as one.
4. No automatic downgrade after a committed v6 migration. Old binaries must reject
   it. A failed release starts stopped and requires authenticated custody/sender
   reconciliation before any restore/restart decision; an old backup is not proof that
   an admission was unused. Retain all consumed operations and epoch high-water marks.

## 10. Required persistence acceptance tests and approvals

Before applying this proposal, test exact v5→v6 migration and fresh initialization,
every DDL/insert/commit kill window, rollback to byte-equivalent v5, unsupported/foreign
schemas, immutable headers and purpose, all PK/FK/unique/size/role/source constraints,
event/head CAS and hash/projection replay. Race separate connections/processes for
one operation/admission/role/first-send; verify legacy/offline jobs can never acquire
operational purpose and operational jobs cannot acquire offline handoff/execution.
Test corrupt/truncated/reordered evidence and missing protected sidecars, capacity
exhaustion, backup/restore high-water marks and external-provider receipt ambiguity.
These are **proposed tests, not tests executed against a v6 implementation**.

Retention proposal: indefinite consumed identities and audit digests; no automatic
deletion/release/pruning. Context ≤16 KiB, each projection ≤4 KiB, 128 events per
admission, at most two role-consumption rows and one first-send row. Exhaustion must
deny new effects. Host capacity, archival/protected-evidence lifetime, recovery from
missing evidence and whether a future version needs a larger bounded event budget
require explicit operator/team approval; the model limit is not approved live retention.
Hash chains do not authenticate a hostile owner or prevent rollback of all state.
Restore starts stopped and reconciles independent custody/sender consumption and
epochs. Conflicts or unavailable authority retain uncertainty, never automatic retry.

## 11. Custody, provenance and remaining work

Select a provider/control policy that authenticates fresh issuers, independent
verifier/payer consent, original expiry/message and durable role consumption at key
access; supports protected exact-request receipt/wire retrieval; and enforces monotonic
epochs and emergency shutdown. Sender-side first-send consumption/retry suppression
and approved RPC/history/account-state provenance need independent review. No provider,
public operator identity, endpoint, credential format or signing service is selected.

Harshita authorized this model and review PR only. No new Palak approval or schema,
custody, deployment, key-generation, token-operation or live-execution approval is
inferred. Shared Rust/ABI/PDA/financial changes retain joint review and are unchanged.
The smallest subsequent implementation is the separately approved additive migration
and atomic purpose/admission writer with real durability/concurrency/crash tests,
effects still disabled. It must not treat these model objects as authenticated input.

## 12. Actual test scope

New default verifier tests exercise real existing validators/public signature vectors,
event/identity/digest binding, admission/role/send exclusion, expiry/epoch/shutdown,
append-only conflicts, serialization/tamper/missing-evidence rejection, model prefix
recovery, capacity, safe errors and schema-v5 isolation. No private keys or signatures
are generated by the new tests. Existing full verifier/lifecycle/finance/Rust/ABI and
LiteSVM suites and all six pinned CI jobs remain. Actual local/hosted totals and review
results belong in the PR delivery evidence; none proves operational custody or Devnet
execution. This document's DDL and future acceptance matrix were not applied/executed.
