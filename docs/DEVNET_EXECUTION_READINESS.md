# Devnet execution readiness

**Result: NOT READY for activation.** Implemented here: read-only integration
acceptance checks. Operational custody, admission, signing, broadcasting and
authenticated live observation are not implemented or activated.

**Passing offline checks does not authorize operational signing,
transaction submission or deployment.**

## Implemented and reused

The internal `reviewDevnetExecutionReadiness(store, input)` accepts exactly
`mode: "offline-review"`, an existing `OfflineReadPlan`, two existing role
requests/outcomes, an optional existing submission-outcome claim, and raw offline
observation bundles. There is no provider, signer, sender, endpoint, credential,
activation flag or generic callback input. It is not registered with an HTTP route.

The assessment performs these concrete checks without writing storage:

1. Revalidate the original plan with `validateOfflineReadPlan`, then correlate it
   through the existing `correlateExecution` against a real `LifecycleStore` v5
   attempt, including immutable job/intent/preparation, message, roles, program,
   Devnet/genesis and complete signed-wire identity. Reject missing/stale attempts.
2. Check the actual job identity/bindings and current worker/revision/generation
   independently of the immutable intent view. Recheck the worker after comparison;
   this is a local read check, not an external-effect fence.
3. Reuse `validateSigningOutcome` for historical role-state/signature evidence;
   preserve incomplete/ambiguous role reports after expiry. Reuse
   `validateAdmission` for supplied freshness/epoch comparisons. When those data
   comparisons pass and both signatures exist, `validateSubmission` verifies the
   exact wire-to-role evidence binding. Never rewind the comparison clock, renew a
   deadline or substitute an epoch to make historical evidence appear fresh.
4. Reuse `validateSubmissionOutcome` for reported acknowledgment/uncertainty and
   `reconcileOfflineReadEvidence` for raw status, exact transaction, finality,
   account ownership/layout/PDA/postcondition and context/conflict checks.
5. Return completed comparisons, reported state labels and fixed unmet control
   requirements. Every result is `NOT_READY`; no checklist or `approved: true`
   input can activate anything. No signed wire, signature or approval reference
   is returned. Secret-bearing exception messages/codes are not forwarded.

This consumes the records already produced by
[secure offline integration](SECURE_ATTESTATION_INTEGRATION.md). The existing
`SecureOfflineAttestationIntegration`, `DurableOfflineCoordinator`, authorizer,
exact-message policy, `OfflineDualSignatureSimulation`, observation adapter and
all their authority semantics remain unchanged. The pure reconciler is reused
directly because this PR needs no reader callbacks or additional simulation.
There is no new verifier, transaction builder, execution state machine or journal.

## Trust distinctions and disabled controls

| Evidence | What these checks establish | What remains unavailable |
| --- | --- | --- |
| Protocol admission and approval references | Canonical message and internally consistent bindings | Fresh process-local authorization, authenticated issuer/operator and one-use custody admission |
| Role reports and signatures | Existing state shape and public cryptographic verification | Independent payer consent, authenticated custody receipts, durable at-key uniqueness and original-deadline enforcement |
| Supplied clock/height/epoch | Agreement with the original comparison interval | Authenticated current time, external epoch, shutdown/revocation linearization and anti-rollback |
| v5 attempts/history | Actual trusted-local-store correlation, integrity checks and current local job fence | Operational provenance, signing admission or first-send reservation |
| Submission/acknowledgment claim | Bound identity and outcome shape | Durable sender admission, proof of invocation or permission to resend |
| Matching raw fixture | Existing decoder/PDA/finality/postcondition comparisons | Approved RPC provenance, consensus truth, verified deployment or authenticated resulting state |

All results retain false operational, submission, retry, reservation-release,
RPC-authentication, on-chain-verification and operational-state-mutation flags;
signing authorization is `not_granted`, and reconciliation stays required.

The constructor/source mode of a trusted injected reader is not authentication.
Existing `DevnetBlockhashSource` validates its pinned read-only genesis/lease
responses; `DisabledDevnetExecutionRpc` bounds fixed RPC reads and hard-denies
submission; existing chain readers validate canonical account structure. They
are inspected and unchanged here, **not invoked on live RPC**. These existing
readers alone do not provide authenticated custody, durable effect fencing,
full exact-transaction provenance or an approved provider trust model.
No public RPC fallback or invented endpoint is introduced.

## Schema-v5 blocker and required design decision

Schema v5 is explicitly an `offline-test-model`. Its test observation authority,
test-only transaction identity, invocation markers and trusted offline observation
brands cannot represent operational custody or live RPC evidence. V4 preparation
does not durably preserve original operational authorization time/epoch/consent;
v5 does not retain authenticated per-role custody admission, protected signed-wire
references, one-use first-send reservation or durable authenticated source history.
An existing row or matching digest cannot supply those missing facts.

**No schema v6 or operational journal is implemented.** Preserve Node 24.14.1,
built-in SQLite, schema 5, DELETE journal, EXTRA synchronization, existing CAS,
append-only histories and permanent uniqueness. No second database is added.

The smallest storage design requiring separate approval is an additive,
explicitly operational-purpose journal in the existing database, with:

- Permanent operation uniqueness spanning legacy reservations and new admission;
  no recycling an offline job/intent or clearing its hold to obtain a new effect.
- Authenticated fresh issuer/policy provenance, canonical identities/message
  digest, immutable original deadline/lease, distinct role identities/consents and
  control epoch, with current external fence authority recorded separately.
- Unique role-specific admission/consumption/receipt references and ambiguous
  outcomes; protected signed-wire custody reference and verified transaction ID.
- Unique first-submission reservation committed before possible invocation,
  explicit authenticated first-send approval and retained acknowledgment/unknown.
- Append-only source/context/finality/account evidence, conflict retention and
  authenticated operator recovery, bounded capacity/retention, migration/backup
  and anti-rollback rules. No persisted record recreates a process-local ticket.

Review the schema and capability contract **before implementing a migration**.
Provider-side durable consumption/fencing is a separate required guarantee;
SQLite CAS cannot fence key access or a network send. The detailed acceptance
requirements already exist in
[operational architecture](OPERATIONAL_EXECUTION_ARCHITECTURE.md) and
[protocol contracts](OPERATIONAL_PROTOCOL_CONTRACTS.md); they are not redefined here.

## Failure and recovery acceptance

Before/after admission, before signing, partial signatures, both signatures,
before/during/after possible submission and missing acknowledgment must retain
ambiguity. Existing `SigningOutcome` and `SubmissionOutcome` vocabularies represent
those **claims**; new tests correlate them with retained v5 rows without inventing
an operational event sequence or performing an effect. Expiry, stale local worker,
changed comparison epoch, unknown/timeout reads, conflicting sources, finalized
failure and success with wrong raw state never authorize retry or release.

Restart/repeated assessment is read-only and cannot consume/replay an admission,
sign or send. Review duplication is allowed because it grants no capability; it
is **not** operational replay protection. Existing permanent job uniqueness and
v5 histories remain intact. A self-consistent invented epoch/approval can pass
comparison but remains unauthenticated and blocked. A missing shutdown control
cannot be replaced by a caller's boolean.

The new tests do not prove real custody crash safety, external freshness,
at-most-one signing/submission, effective emergency shutdown or live RPC
authentication: those boundaries do not yet exist. Existing process-crash tests
from the offline integration run in the unchanged full suite. Future external
admission tests must use actual approved durable effect-boundary state and kill
processes at admission/effect/receipt windows before operational activation.
Read-only observation retries must remain separate from submission retries.

## Missing configuration, approvals and next PR

Obtain team-approved custody/provider selection and caller/receipt authentication;
operational verifier and independent payer public identities and fee-consent
policy; operator approval/revocation roles; external fencing/anti-rollback and
shutdown enforcement; approved RPC/provider/history/transport trust configuration;
deployed program/artifact/upgrade authority verification; and reconciliation,
retention and recovery policies. Existing approved program/mint identities are
preserved; this PR does not verify their deployment or authorize token setup.
No missing public identity, URL or credential format is invented or inferred from
test fixtures. Never request private keys in chat.

Harshita authorized this offline implementation and review PR, not a merge or
operational activation. No new Palak approval is inferred. Shared Rust/ABI/PDA or
financial-policy changes retain joint-review requirements and are unchanged here.
Operational journal/schema approval, custody/security approval, deployment/key
generation authorization and first-rehearsal approval are separate gates.

The smallest next implementation depends on approval of the concrete operational
journal/provenance contract above and selection of a custody/effect boundary that
can enforce permanent exclusion and epoch revocation. Implement that approved
durable admission with adversarial concurrency/crash tests and effects disabled;
do not add a live signer or sender merely to satisfy this assessment.

Permission for a first controlled Devnet rehearsal requires explicit human
authorization naming its exact scope, approved public bindings, reviewed build,
funded payer/consent, custody/issuer/fence controls, authenticated RPC and verified
deployment, first-send/recovery/shutdown runbook and passing operational acceptance
evidence. Offline review success or merging this PR is not that permission.
