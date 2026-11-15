# Offline signer and separate fee-payer architecture

## IMPLEMENTED scope

This phase adds an internal, explicitly ephemeral-test authorization adapter.
It does not implement a production signer, credential loader, wallet integration,
external signing service, broadcaster or signing HTTP route. Actual Ed25519 key
generation/signing exists only under services/verifier/test. Runtime source uses
public-key verification only. Nothing imports private keys from environment or disk.

The existing flow remains authoritative:

    GitHub evidence -> VerifierService -> single-use AttestationAuthorizer ticket
    -> AttestationTransactionPolicy -> consumed exact message

The durable path remains separate evidence:

    verification job -> current identity/revision/worker/generation fence
    -> immutable v4 transaction intent / preparation -> retained reconciliation

The new optional test path connects these only while a genuine policy-consumed
capability is alive. A job state, stored digest, old preparation, old mock receipt
or reconstructed matching byte buffer cannot create that capability.

## Original policy, single-use consumption and exact messages

AttestationTransactionPolicy retains its validation algorithm. Its existing
consume revalidation body is shared by a private validator: same original issue
time/deadline, current chain bindings, exact instruction/wire/message, approved
payer, Devnet lease and blockhash. Revalidation never creates/renews an approval.

Only the ORIGINAL Buffer returned by consume is privately registered in a
WeakMap. takeOfflinePolicyMessage burns its provenance before checks/awaits,
rejects mutation/clones/serialized metadata, and returns a private defensive
snapshot plus revalidation closures tied to that original record/deadline.
Those closures are process-local and never persisted. The proven program/milestone
operation identity is also checked against the current durable job before writes.

AttestationTransactionCoordinator retains its default offline-mock boundary.
Its optional offline-policy-simulation mode forwards only that original consumed
object. It never accepts a caller transaction, approved JSON, arbitrary signing
bytes or persisted authorization. Existing policy tests remain unchanged.

OfflineDualSignatureSimulation consumes provenance once, requires the exact
configured separate verifier/payer, and checks the legacy message's two required
signer positions. Each role gets an opaque one-shot request, not caller bytes.
takeOfflineRoleMessage burns the request, checks role/key/freshness/current fence,
then returns a defensive copy. Clones/replays/wrong-role/wrong-key requests fail.

The adapter permanently reserves each proven operation for its instance lifetime,
including failure/timeout. A later independent genuine approval cannot renew it.
Durable job/intent uniqueness supplies cross-instance/process exclusion; the
bare test adapter alone is not a global coordination service.

Both returned 64-byte Ed25519 signatures must verify over the exact private
message snapshot against their respective public keys. Missing, altered, reordered,
duplicated or wrong-key signatures do not yield completed simulation evidence.
The policy revalidates before each role, after each response and before acceptance.
Its original deadline is not restarted by these stages.

The adapter returns only frozen, explicitly ephemeral test evidence with two
verified roles, operationalSigningAuthorized:false and submissionAuthorized:false.
It returns no signed transaction or signature bytes. Test fixtures retain local
signatures solely to assert cryptographic/legacy transaction behavior.
Signature validity is not authorization to execute or submit.

Public-key DER encoding follows [RFC 8410](https://www.rfc-editor.org/rfc/rfc8410.html).
The [Solana transaction reference](https://solana.com/docs/core/transactions)
describes required Ed25519 signatures. Tests execute on pinned Node 24.14.1 with
the existing Web3 version; these documentation links do not authorize an upgrade.

## Durable integration and schema assessment

DurableOfflineCoordinator accepts an optional trusted OfflineDualSignatureSimulation
dependency, whose explicit public roles must match the existing trusted configuration.
Default behavior is preserved. Providers/configuration are never request inputs.

After genuine policy consumption and before any provider call, its synchronous
prepare callback, using existing fenced APIs:
1. Creates a NEW v4 intent for the same permanent job/operation and explicit payer.
2. Records exactly the consumed message digest, format and validated lease snapshot.
3. Moves it to reconciliation_required BEFORE any test cryptography.
4. Begins the existing v3 offline mock handoff journal.

Each write independently checks current job identity/revision/worker/generation
and intent CAS under BEGIN IMMEDIATE. A crash between these commits leaves a
permanent created/prepared/reconciliation record; no path resumes it.
An existing v4 intent is always rejected by this path, even if its digest matches.
In particular OfflineTransactionPreparer outputs cannot be promoted to signing.

The v4 reconciliation marker intentionally remains after known local test success:
v4 cannot represent durable signer-side effects or public signature evidence.
Schema v5 is NOT necessary for this offline scope. No historical schema, table,
trigger, migration, reservation, job transition or handoff interpretation changes.

V3 recorded still means a local mock receipt, never a blockchain signature or
submission. Only the issuing coordinator's WeakMap can return ephemeral simulation
evidence for its original receipt. JSON/restarted instances cannot restore it.

No persistent signing capability, signing secret or signature is stored. No
prepared message is replaced, no approval is automatically renewed and no
completed mock operation can start another simulation or real signing.

## Failure, crash and restart semantics

| Boundary | What is known | Retained result |
| --- | --- | --- |
| Invalid request / failure before authorization | No provider was called | Existing job rules; no signature intent |
| Verification rejection | No authorization ticket for signing | Existing rejection/recovery classification |
| After verification/approval creation | No provider was called yet | Job pending/blocked; process-local capabilities lost on crash |
| After approval consumption, before intent marker | Capability consumed, no durable provider marker yet | Job remains reserved; no metadata-based restoration |
| Marker committed, before provider | Local mock has not called provider | V4 reconciliation plus v3 intent; no retry |
| Known mock rejection before provider | No test provider called | V3 rejected, v4 retained, job recovery required |
| Provider exception/timeout | It may already have signed | V3 uncertain where current fence allows; v4 retained |
| Revocation during a provider | A signature may exist in provider memory | Stale worker cannot record receipt/failure or return accepted evidence |
| Both test signatures produced, before receipt commit | Local crypto may have happened | V4 retained, unfinished v3 intent; no assumed acknowledgment |
| Mock receipt committed, acknowledgment lost | Local acceptance known | V3 recorded plus retained v4 marker, not on-chain execution |
| Restart | Private capabilities and ephemeral keys are gone | Existing jobs/intents remain blocked; no reconstruction |

Provider waits are bounded by the configured test timeout (1..1000 ms) and the
remaining ORIGINAL policy deadline. Pending role requests are invalidated on all
exits. A late response cannot start the other role or update accepted evidence.
A provider that already received bytes may still finish; it cannot be undone.
There are no automatic retries, fresh attempts or approval recovery.

No DB lock spans async verification, RPC reads or provider work. Independent
processes serialize protected writes in the same local database. A local fence
followed by a provider call is not atomic external fencing. Cross-process
revocation can race an in-flight provider; post-call revalidation and atomic
receipt writes reject stale acceptance, not the existence of a signature.
No remote signer or blockchain exactly-once guarantee is claimed.

## Twenty-threat model

| Threat | Existing defense | Gap / new enforcement | Regression |
| --- | --- | --- | --- |
| 1 Forged verifier result | Authorizer validates trusted execution/outcomes/bindings | No result JSON input to adapter | forged real-service result integration |
| 2 Unauthorized payer | Explicit distinct payer in exact policy | Provider role must match exact message/config | wrong provider / payer mutation |
| 3 Identity substitution | Immutable on-chain/job roles | One-shot role/key checks and signature verification | wrong role/key/request and config tests |
| 4 Arbitrary message signing | Canonical single attestation policy | Original consume-object provenance only | arbitrary buffer / clone / metadata rejection |
| 5 Altered transaction | Exact wire/message checks | Private snapshot and defensive copies | original buffer mutation / post-snapshot mutation |
| 6 Extra instructions | Existing sole-instruction policy | No generic message/IX constructor | extra transfer policy and crypto mutation tests |
| 7 Account permissions | Existing exact account order/flags | Required signer positions checked | signer/writable/account mutation cases |
| 8 Changed blockhash | Trusted lease equality | Original record revalidated between roles | lease substitution / cryptographic invalidation |
| 9 Stale worker | Job CAS/generation checks | Fenced marker and accepted-receipt writes | replaced worker, stale revision, revocation barriers |
| 10 Reused ticket | Burn-before-await WeakMaps | Consumed-message and role request single use | replay/clone/concurrent consumption |
| 11 Conflicting intent | V4 permanent uniqueness | Existing intent never promoted or replaced | existing preparation / changed request / restart |
| 12 Crash after start | Durable jobs/intents | Reconciliation marker precedes provider | four actual owned-process crash checkpoints |
| 13 Unknown outcome | Recovery never authorizes retry | Invalidate role request; retain uncertainty | timeout before/after real test signature |
| 14 Duplicate requests | Global job/intent identity | One capability and one pair of roles | separate connections/coordinators and new IDs/workers |
| 15 Compromised requests | Exact evidence parser and no signing route | Providers/config never accepted as request data | injected fields / actual HTTP route rejection |
| 16 Credential misuse | No runtime credential provider | Signing implementation only ephemeral test fixture | wrong mode/credential fields; source/secret review |
| 17 Wrong cluster | Trusted Devnet RPC/genesis/lease policy | Revalidate original policy before each role | wrong genesis/invalid lease after first role |
| 18 Expired transaction | Original age/blockheight policy | No lifetime renewal at signing boundary | expiry before/during both roles |
| 19 Signature substitution | Exact message required | Verify both keys, lengths and request use | missing/reversed/duplicate/corrupt/wrong-key signatures |
| 20 Wrong milestone/commitment | Authorizer and fresh chain equality | Reuse exact builder/policy, never DB authority | student/requirements/evidence/account mutations and existing tests |

Tests use actual verifier/authorizer/policy classes, temporary SQLite, genuine
canonical messages and real Node Ed25519 signing/verification with in-memory keys.
They do not infer safety solely from mocked success values. Crash tests use owned
Linux children and deterministic pipe/SIGSTOP/SIGKILL checkpoints, not sleeps.

## PLANNED operational readiness checklist

None of these items is waived by passing offline tests:
- Obtain the real, approved verifier public key; test keys are never deployment identities.
- Obtain an explicitly approved, separate fee-payer public key and fee consent policy.
- Independently verify the approved Devnet program, deployed artifact/upgrade authority
  and approved RPC/genesis before any future operation; no deployment is authorized here.
- Keep exact-message and supported-format restrictions, including no added fee/spend IX.
- Review signer custody and key lifecycle with independent security review.
- Isolate credentials from verifier/runner/frontend; no chat secrets or prototype env loader.
- Authenticate/authorize narrow signer callers and separate verifier/payer roles.
- Implement signer-side external fencing and durable idempotency at the actual effect.
- Design durable attempt/public-signature records; justify explicit v5 migration if needed.
- Design acknowledgment, timeout, partial-signature and crash reconciliation.
- Preserve expiration and fresh chain checks without renewing consumed approvals.
- Define secret rotation/revocation and approved verifier-rotation implications.
- Provide emergency shutdown at signer custody/access-control boundaries.
- Audit public operation/message/role/fence evidence without keys or private work evidence.
- Enforce network isolation and trusted RPC/provenance sources.
- Define local backup/restore, same-host storage and hostile-owner controls.
- Verify both required signatures and all role-specific consent before transport.
- Separately authorize submission/confirmation integration and test it under its own scope.

Legacy Solana messages do not themselves encode a cluster identity. Trusted
RPC/genesis/blockhash enforcement remains essential, especially at a future
independent signer. Mode strings do not prove that a provider uses ephemeral keys;
provider construction/code ownership is a trust boundary. No real provider ships.

The host, injected trusted dependencies, clock, database owner and custody plane
remain trusted. Existing single-host limits, experimental node:sqlite behavior,
DELETE/EXTRA WAL-issue avoidance, root tooling advisory debt and reviewed Rust
maintenance notices remain unchanged. Passing agreed acceptance tests does not
prove arbitrary work quality or that a designated verifier is honest.
