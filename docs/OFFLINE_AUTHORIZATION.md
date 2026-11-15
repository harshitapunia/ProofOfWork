# Durable offline attestation authorization

## Status and trust boundary

IMPLEMENTED: a server-internal, offline-only composition in
services/verifier/src/durable-offline-coordinator.ts. It reuses VerifierService,
AttestationAuthorizer, AttestationTransactionPolicy and
AttestationTransactionCoordinator. It is not imported by the HTTP server.
No signer, signing credential, broadcast adapter or production signing route is
implemented. Existing future signer interfaces remain non-operational.

The request contains only the existing exact evidence-request fields. Durable
bindings come from validated request commitments and a fresh trusted Devnet
account read, not caller-supplied job metadata. Numeric GitHub identities, pinned
commit, manifest commitment, sponsor, internship, milestone, submission, student,
designated verifier and program identity become immutable job bindings.
The verification specification identity remains the requirements commitment;
no commitment algorithm or acceptance specification changes.

Trusted dependencies, configuration, worker identity, database and recovery
control are server capabilities. Request callers must never supply them.
The separate fee payer remains unsigned and is distinct from the verifier.
This component does not grant payer or verifier custody.

## Sequence and asynchronous checkpoints

1. Clone and validate the evidence request using the existing parser. Check the
   manifest and evidence commitments against fresh authoritative state.
2. Create or retrieve the permanent program/milestone operation; claim it using
   identity, revision and generation. A new creation label cannot bypass it.
3. Transition to verification_running. Re-run trusted verification through the
   existing authorizer. Its existing complete result validation remains authoritative.
4. A synchronous trusted callback, after result validation and before ticket issue,
   records verification_completed then authorization_pending with current CAS/fence.
5. Continue the existing fresh-state, ticket, canonical transaction, blockhash and
   single-use policy checks. The coordinator checks the durable claim after each
   awaited composition stage. Chain/blockhash adapters check before and after
   every wrapped read. The service adapter checks before/after the complete
   verification call. Internal GitHub/sandbox work may finish after revocation;
   its result cannot advance the job or handoff. Cancellation of internal
   verification work is not promised.
6. The boundary receives only the exact policy-consumed message, defensively
   copied by the existing coordinator. No request proposal or approved JSON enters it.
7. Record a permanent intent with the message SHA-256 under current identity,
   revision, worker and generation.
8. An optional test-only scheduling gate receives no message, metadata, ticket or
   approval. Its wait is bounded to at most 1000 ms. No database lock spans it.
9. Commit the sole mock effect, a local receipt, with the fencing check in the same
   SQLite BEGIN IMMEDIATE transaction. A revoked worker cannot record it.
10. Return an explicitly offline-mock process-local receipt. Only the issuing
    instance's WeakMap accepts that exact receipt object to return copied message
    bytes. Receipt IDs start with offline-mock: and are not transaction signatures.

Ticket and policy approval objects remain process-local, single-use WeakMap
capabilities. They are never serialized or reconstructed from storage.
All durable jobs and journal views retain signingAuthorization: not_granted.
Direct journal writes through the trusted storage facade are bookkeeping only;
they cannot mint a process-local receipt, authorizer ticket or policy approval.

## Schema v3 and crash semantics

V2 cannot distinguish pre-handoff intent from a known mock outcome.
V3 adds verification_offline_handoffs, one STRICT append-only table with
at most two entries per job, and no-update/no-delete triggers. The intent records
worker, generation, job revision and message digest. The optional outcome records
recorded/acknowledged, rejected/mock_rejected or uncertain/mock_failure/mock_timeout.
Entries are canonically encoded and hash chained to immutable job identity.
Reads verify the actual historical authorization_pending revision and its worker
and generation, including after recovery revokes that worker.

The migration validates the exact prior v1/v2 schema before adding v3 inside the
store's existing transaction. Reservation schemas, v2 job schemas and histories
remain unchanged. Existing strict validation, integrity triggers, bounded history,
permanent identities, CAS and generation fencing remain. Frozen approved-v2
fixtures create genuine reservation/job histories for migration tests; only import
paths and the provenance comment differ from main 0e7589f3 source.
Database journal_mode=DELETE, synchronous=EXTRA and Node 24.14.1 remain pinned.

| Crash/failure window | Retained evidence | Recovery |
| --- | --- | --- |
| Before a claim | Existing created job if already inserted | Ordinary claim rules apply |
| Claimed/running, before verified outcome | Retained claimed/running job | Explicit trusted revocation required before verification restart |
| Verification completed or authorization pending, before intent | Completed/pending job, no mock receipt | No automatic reclaim; reconciliation required |
| After intent, before receipt commit | Pending intent | Uncertain; no automatic reclaim or replacement job |
| During receipt transaction | SQLite rollback leaves intent | Uncertain; no inference from absent acknowledgment |
| Receipt committed, acknowledgment lost/process killed | Recorded mock receipt remains | Inspect retained evidence; no duplicate handoff |
| Mock rejection | Rejected outcome plus atomic recovery transition | Operation remains permanently reserved |
| Timeout/mock failure | Uncertain outcome plus atomic recovery transition | No blind retry, reset or ticket resurrection |
| Worker revoked during mock wait | Pending intent remains; stale worker cannot write outcome | Trusted reconciliation required |

For an intent without outcome, listRecoveryRequired reports authorization_uncertain
while the job remains pending, or reconciliation_required after explicit interrupt.
The handoff journal must also be inspected. A recorded mock receipt leaves the job
authorization_pending because no on-chain action or confirmation exists.
A verification_failed rejection is recorded as verification_rejected; other
pre-handoff errors conservatively interrupt the current claim. A stale worker never
overwrites a newer worker's history.

## Threat model

| Threat | Existing protection | Gap and enforcement | Regression evidence |
| --- | --- | --- | --- |
| 1 Forged success | Authorizer validates trusted verification result and bindings | Never accept caller approved JSON; retain result checks | durable-offline forged service/result tests; attestation tests |
| 2 Stale claim | Durable generations and revision CAS | Check every composition checkpoint and atomic mock receipt write | durable-offline revocation tests; journal stale-field tests |
| 3 Worker replacement during verification | Explicit recovery increments fence | Discard old result; no old-worker history changes | worker-replaced integration test |
| 4 Job identity substitution | Canonical identity, immutable fields, unique operation | Derive bindings internally; journal checks current identity | lifecycle identity tests; journal identity mutation |
| 5 Different GitHub evidence | Provenance checks and evidence commitment | Reject changed request before new authorization | commit/repository/contributor/nonce integration cases |
| 6 Ticket reuse | Burn-before-await WeakMap ticket | Never hydrate from DB; rerun existing single-use checks | attestation replay tests; metadata reconstruction integration |
| 7 Mutated message | Exact canonical wire/message comparison | Boundary uses only consumed bytes and defensive copy | transaction-policy substitution tests; exact-message integration |
| 8 Extra instructions | Sole attestation instruction policy | No caller proposal input | transaction-policy injection tests; injected request rejection |
| 9 Wrong payer | Separate configured payer, exact account flags | Capture trusted config; retain exact policy | policy payer tests; durable payer escalation tests |
| 10 Changed blockhash | Trusted observation and lease matching | Fenced reads before/after awaits | policy lease tests; durable lease failure |
| 11 Expired authorization | Monotonic age and blockheight checks | Fail closed, retain operation | policy expiration tests; durable expiration case |
| 12 Changed chain state | Fresh authoritative snapshots | Compare initial bound state on all wrapped reads | chain/coordinator tests; durable state mutation |
| 13 Duplicate execution | Process reservations and permanent operation uniqueness | One intent/outcome pair; no replacement creation ID | duplicate same/creation/worker/restart tests |
| 14 Process crash | SQLite transactions and retained jobs | Explicit intent/outcome journal; no inferred no-effect | five owned-process crash tests |
| 15 Ambiguous failure | Recovery classification never authorizes retry | Persist uncertainty/rejection atomically with recovery | timeout/failure/rejection integration and rollback tests |
| 16 Concurrent workers | BEGIN IMMEDIATE, revision CAS, generation | Final effect in same fenced transaction | separate-connection coordinators and existing process claim tests |
| 17 Compromised request | Exact evidence parser, internal dependencies | No bytes/sign interface or HTTP route | request authority-field rejection; existing server auth/route tests |
| 18 Unauthorized DB access | File permissions, exact schema, integrity/hash checks | Fail on structural corruption; DB owner is a trust prerequisite | schema tamper, history tamper, journal immutability tests |

Hashes are integrity checks, not authentication against a database owner who can
rewrite data and recompute them. Private directory permissions, exclusive trusted
service ownership, backups and recovery access controls remain operational
requirements. Giving arbitrary code the store or dependency-injection capabilities
crosses the trust boundary.

## Exact-message and replay restrictions

All existing transaction-policy tests remain. They cover arbitrary programs, extra
instructions/accounts, account order, signer/writable metadata, unauthorized fee
payer, mutated arguments, changed milestone identity, blockhash/lease expiry,
noncanonical encoding, reused approvals, unsupported versioned formats and
durable nonce attempts. The durable layer does not reimplement those algorithms.
Its integration tests prove only the exact existing-policy-approved message
arrives at the mock and no caller transaction field is accepted.

The new tests also exercise same-generation revision changes, concurrent claims,
different workers/instances/creation IDs, restarted storage, corrupted authority
bindings, mock configuration replacement, changed requests during an await,
durable metadata reconstruction attempts and defensive message-copy behavior.
Owned-process tests use only temporary databases and explicit child PIDs.
Explicit unauthorized signing-route tests, existing HTTP authorization tests,
read-only RPC fixture guards and source review
cover no signing route, key loading or broadcast path. No live transaction test
or deployed-parity claim is made.

## PLANNED: operational signer prerequisites

An independent external signer is NOT fenced by a local check followed by an
asynchronous call. There is an unavoidable check/call race; a local SQLite lock
must not be held across an unbounded network call. This implementation avoids
that external effect entirely. It offers neither external exactly-once execution
nor production signing readiness.

A future operational design needs separate review and approval for signer custody,
independent authorization at the signer, durable idempotency/fencing at the
external effect, exact-message binding, verifier/payer segregation, blockhash
expiration, transaction observation/reconciliation, authenticated internal access,
safe deployment and incident recovery. Missing acknowledgment must remain
ambiguous. No future signer adapter is activated by this PR.

No Anchor instructions, ABI, layouts, PDA seeds, financial policies, settlement
v2 destinations, refund policy, finance-client serializers, GitHub provenance
rules or acceptance tests change.

The composition is not an authenticated application API: its caller must already
be trusted to reserve operations. Invalid credentials/evidence may permanently
reject a reserved operation. Exposing it to untrusted callers could cause denial
of service; authenticated orchestration and operator reconciliation remain planned.
