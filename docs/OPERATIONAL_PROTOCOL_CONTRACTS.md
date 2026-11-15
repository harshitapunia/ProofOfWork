# Offline operational protocol contracts (Phase 8C-2B)

## Scope and version

**IMPLEMENTED: pure offline data validation and adversarial acceptance contracts.**
**UNIMPLEMENTED: operational authority, custody, signing, sending, live RPC
observation, persistence, replay prevention and activation.** This phase does not
approve any of those capabilities.

Baseline: main f53bd1bcbdb7d6638c7f4a4056b1e507fdb2ef6d after merged PR #38.
The [approved architecture](OPERATIONAL_EXECUTION_ARCHITECTURE.md) remains the design
baseline. Existing [v5 execution](EXECUTION_RECONCILIATION.md),
[signer simulation](SIGNER_ARCHITECTURE.md) and [v4 intents](TRANSACTION_INTENTS.md)
retain their behavior.

Protocol version is proofwork-operational-contracts-v1; policy vocabulary is
attest-canonical-legacy-v1. These identify this data format and its sole canonical
legacy attestation shape, not an approved deployed signer or authority identity.
Unknown versions/policies reject. Future format or policy changes need a separately
reviewed explicit version; do not silently upgrade a record or normalize an unknown
version into v1. There is no on-chain ABI/version/layout change.

Source:
[interfaces](../services/verifier/src/operational-protocol-types.ts) and
[validators](../services/verifier/src/operational-protocol.ts).
New contracts are not imported by HTTP routes or execution coordinators.
No generic sign/send/provider interface is introduced.

## Validation result and trust boundary

Every validate function returns a frozen envelope:
- kind: validated_offline_contract_data;
- data: a normalized, deeply frozen copy of the validated public contract;
- operationalAuthorization: false;
- authenticated: false;
- retryAuthorized: false;
- reservationReleaseAuthorized: false.

The result proves only internal shape, cryptographic consistency where specified,
and agreement with supplied comparison data. It is not a ticket, role capability,
worker claim, custody receipt authentication, RPC observation brand or permission
to execute. JSON serialization/deserialization never restores existing authorization.
The classifier additionally returns uncertaintyClearAuthorized: false.

The caller supplies BOTH an anchor and a comparison snapshot. Neither is fetched
from storage/RPC or authenticated by these functions. A caller controlling both
can invent consistent reference metadata; successful validation still grants
nothing. Tests explicitly demonstrate this limitation rather than claiming replay
prevention or genuine freshness from schema validation.

The only lifecycle change is additive exports of existing pure validators:
assertOwnDataFields (existing exact own-data-property checker) and validateJobBindings
(existing canonical JobBindings checker). Existing exports remain. No lifecycle
storage, SQL, v5 state machine, intent, recovery or fencing algorithm changes.

## Anchor and comparison snapshot

ProtocolAnchor binds:
- canonical JobBindings: Devnet/genesis/program, sponsor, internship/milestone IDs
  and canonical PDAs, immutable submission/student/verifier, requirements/evidence
  commitments, repository/contributor/commit and verification-spec commitment;
- jobId/jobIdentity and intentId/intentIdentity;
- feePayer, messageDigest, snapshotDigest, blockhash, lastValidBlockHeight and
  preparedAtBlockHeight;
- issuedAtUnixMs, deadlineUnixMs, epoch and policyVersion;
- operatorApprovalRef, verifierApprovalRef, payerApprovalRef and
  submissionApprovalRef.

These are public comparison assertions, not validation of a stored job/intent's
actual identity hash or authenticated evidence of approval. A future adapter must
obtain the canonical anchor from authenticated original admission/state under its
current control-plane fence. Passing an existing v4/v5 row directly as an anchor
rejects its incompatible shape and cannot create authority.

ProtocolSnapshot contains nowUnixMs, blockHeight, currentEpoch,
minRemainingBlockHeights and a bounded unique sourceIds list.
All numeric values use canonical decimal u64 strings; numeric JS values, leading
zeros, overflow and scientific notation reject. The positive remaining-height
margin has no operational default: the fixture uses test policy data only.
It must be team-approved and source-authenticated before future operational use.

Fresh request validation checks supplied current time is within the original
issued/deadline interval (at most the existing policy's 30-second upper bound),
current epoch equals the original epoch, observed block height does not precede
preparation and remaining heights meet the explicit positive margin. Boundary
expiry and insufficient margin reject. This does not prove that the supplied
clock/height/epoch is real or current.

Historical signing, submission-outcome and observation audit validation intentionally
does not renew or require a still-live authorization. It binds the original context,
permits an explicitly supplied later epoch, and remains non-authorizing after
expiry/revocation. An old receipt may be inspectable while a new action is blocked.

## A. AdmissionRequest

validateAdmission(input, anchor, snapshot) validates:
- version and kind=offline_admission_data;
- admissionId (non-nil canonical UUID), permanent operationKey;
- jobId/jobIdentity, intentId/intentIdentity, full bindings and feePayer;
- messageDigest, messageBase64, snapshotDigest and policyVersion;
- issuedAtUnixMs/deadlineUnixMs, blockhash, lastValidBlockHeight,
  preparedAtBlockHeight, operatorApprovalRef and epoch.

operationKey uses the existing devnet:program:milestone identity. Job/PDA/commitment
checks reuse validateJobBindings. Verifier and payer must be separate, nonzero
on-curve public identities; payer cannot alias program/internship/milestone/submission.
The canonical message is rebuilt using the existing buildAttestMilestoneInstruction
and compiled Transaction serializer. Exact bytes and SHA-256 must agree, including
program, data, account order/flags, payer and blockhash. A changed message fails
even if the attacker updates the claimed digest in both input and anchor.
No alternate evidence commitment algorithm or finance serializer is added.

UUID shape does not establish admission uniqueness. Validation of the same admission
twice can succeed. Admission reference authentication, permanent external operation
exclusion and consumption are requirements for a future trusted effect boundary.

## B. CustodyRoleRequest

validateRoleRequest(input, admission, anchor, snapshot) supports exactly:
- kind=offline_verifier_request with role=verifier and recorded verifier;
- kind=offline_fee_payer_request with role=fee_payer and distinct recorded payer.

Each request contains version, requestId, admissionId/admissionDigest, operationKey,
role/publicKey, messageDigest/messageBase64, original deadlineUnixMs/epoch and the
matching roleApprovalRef. Every field must bind to the same validated admission
and anchor; role/key/consent substitution rejects. Freshness checks remain those
of the original admission, without a renewed deadline.

protocolDataDigest uses domain-separated canonical data serialization for these
cross-references. Object insertion order is irrelevant. Anyone can compute the
digest: it is not a signature, approval or authenticated issuer identity.
No custody caller, wallet loader, key-access method or signing endpoint exists.

## C. SigningOutcome

validateSigningOutcome(input, roleRequest, admission, anchor, snapshot) binds common
version, kind=offline_signing_outcome, state, requestId/requestDigest,
admissionId, operationKey, role/publicKey and messageDigest.

Strict state-specific fields:
| State | Additional data | Meaning/limitation |
| --- | --- | --- |
| not_admitted | reason | Reported classification, not proof that no key was accessed |
| admission_accepted | receiptRef | Admission claim only; no signature inferred |
| signature_observed | receiptRef, signatureBase64 | Actual 64-byte Ed25519 signature must verify over exact role message/key |
| signing_rejected | reason | Retained rejection claim, not permission to retry |
| signing_uncertain | reason, nullable receiptRef | Missing receipt does not prove absence of signing |

Unexpected fields reject in every variant. The implementation uses public-key
verification only; it never signs. A valid signature proves cryptographic message/key
identity, not approval authenticity or an authenticated custody receipt. One role's
valid signature is partial evidence and cannot satisfy the submission validator.
Input test signature/wire data remains internal offline DTO data, never exposed
through a new runtime route or generated from stored metadata.

## D. SubmissionRequest and SubmissionOutcome

validateSubmission(input, admission, roleRequests, outcomes, anchor, snapshot)
requires exactly two distinct, correctly ordered role requests (verifier then payer)
and two matching signature_observed outcomes. Complete wire signatures must match
the validated per-role evidence, not just arbitrary independently valid signatures.

SubmissionRequest contains:
- version, kind=offline_first_submission_data, senderAdmissionId;
- admissionId/admissionDigest, operationKey and messageDigest;
- wireBase64/wireDigest and transactionId;
- submissionApprovalRef, original deadlineUnixMs and epoch.

Wire is bounded, canonical legacy encoding with both verified signatures, the exact
original message and the full first-signature transaction ID. Missing/partial
signatures, changed bytes, transaction-ID conflicts, substituted approval, expired
time, stale epoch or insufficient height margin reject. A valid submission DTO
cannot call a broadcaster or consume a sender admission.

validateSubmissionOutcome binds version, kind=offline_submission_outcome, state,
senderAdmissionId, submissionDigest, expected transactionId,
acknowledgmentTransactionId and nullable reason. Supported states:
not_admitted, intent_recorded, invocation_potentially_occurred,
acknowledgment_received, submission_uncertain.

Only acknowledgment_received may contain an acknowledgment ID; it must match the
precomputed transaction ID and have no failure reason. Not-admitted and uncertain
claims require a bounded reason. Intent/possible invocation are distinct from ack.
Timeout/disconnect ambiguity is represented without an execution-success field.
Neither matching ack nor duplicate validation authorizes execution, retry or release.
Cross-event monotonicity and global deduplication require the future durable journal;
this validator checks individual bound outcomes, not a persisted history.

## E. ObservationContract

validateObservation(input, submission, admission, anchor, snapshot) validates
version, kind=offline_observation_data, senderAdmissionId, submissionDigest,
operationKey, provenance, transaction evidence and account evidence.

SourceProvenance includes kind (offline_fixture or unverified_reference only),
sourceId, Devnet cluster/genesis, requestId, eventId and contextSlot. The source
reference must appear in the supplied bounded sourceIds set. This is a membership
comparison, NOT source authentication. No endpoint or credential field exists.
authenticated_rpc, authenticated:true, verified:true and other injected claims reject.
No test authority can be relabeled as a trusted live observation.

TransactionEvidence:
- missing: reason null_lookup, history_missing or rpc_timeout;
- status_claim: expected transactionId, messageDigest/wireDigest, finality
  processed/confirmed/finalized, outcome success/failure, nullable errorCode,
  transactionSlot/contextSlot and observedBlockHeight;
- conflict: two validated status claims for the same exact transaction with a
  conflicting outcome/error/landing slot. Identical observations or ordinary
  finality strengthening alone are not conflict evidence.

Success requires no errorCode; failure requires a bounded non-null errorCode.
Context cannot precede transaction slot. Source context bounds the individual
evidence contexts. All heights/slots preserve full u64 decimal precision.
Conflicting provisional evidence is representable and held; no fork is silently
chosen. No live consensus/provenance truth is asserted by the data model.

AccountEvidence:
- not_supplied, incomplete or mismatched, each with a bounded reason;
- matching_candidate with programId, milestone, submission, student, verifier,
  requirementsHash/evidenceHash, milestoneStatus (Verified or Settled),
  submittedAt/verifiedAt, contextSlot, accountSetDigest and nullable completionDigest.

Candidate fields must match the canonical anchor. Time ordering and context bounds
are checked. Settled requires a completion digest; Verified requires it absent.
This metadata schema does NOT fetch or decode actual accounts, prove account
ownership/layout/PDA data, authenticate a snapshot digest or attribute an account
change to this transaction. Future approved RPC/account-decoding adapters must do
that work. A metadata claim must never be called verified account state.

classifyObservation revalidates the input and returns only one of:
missing_evidence, conflicting_evidence, provisional_claim, finalized_failure_claim,
awaiting_account_evidence or matching_finalized_claim.
Every classification retains authenticated=false, operationalAuthorization=false,
uncertaintyClearAuthorized=false. Finalized failure stays failure even with a matching
account candidate. Successful finalized status plus incomplete/mismatched accounts
does not become a matching claim. Even matching_finalized_claim cannot clear
uncertainty or mark an operation executed.

## Strict validation and failure behavior

All contracts reject unknown versions, unknown own fields, accessor/symbol-shaped
records, malformed/zero digests, invalid/noncanonical public keys, inconsistent
identities, unsafe numeric forms, wrong roles and altered immutable references.
Data is copied into fixed fields and deeply frozen; scalar strings and bounded
arrays prevent caller mutation from changing accepted output. Public errors use
invalid_offline_protocol_data without retaining caller payloads. Valid missing,
rejected, uncertain or conflicting evidence is kept distinct from malformed data.

There is no time service, replay store, SQL handle, reservation mutation,
credential loader, signer, transport/RPC adapter, external fence, authenticated
operator or generic provider interface. New source uses hashing and verification,
not signing. Existing storage, authorization-ticket lifecycle, offline brands,
financial/ABI behavior, teammate modules and frontend interfaces are unchanged.

Only a future, separately approved authenticated boundary can establish real
approval, source provenance, clock/epoch freshness, durable role/sender admission,
replay exclusion or account-state truth. It must not treat these plain immutable
objects or their hashes as credentials.

## Deterministic adversarial coverage

The protocol tests use a fixed PUBLIC test vector captured from the pre-existing
ephemeral offline execution helper. Its provenance records the base/helper hash.
No seed/private key was exported or persisted. The new suites load only the public
fixture and do not generate keys or sign during tests. Public fixture identities
are not approved operational identities or external configuration.

Coverage is in:
[admission/role tests](../services/verifier/test/operational-protocol.test.ts),
[outcome tests](../services/verifier/test/protocol-outcomes.test.ts),
[observation tests](../services/verifier/test/protocol-observations.test.ts) and
[isolation tests](../services/verifier/test/protocol-isolation.test.ts).

The tests cover message mutation even with recomputed digest, operation/program/
Devnet/commitment substitution, swapped roles, missing identities, strict shape,
expiry/policy/epoch/deadline and blockhash/margin failures, duplicate validation,
forged metadata, receipt absence, corrupt/partial signatures, ambiguous outcomes,
ack mismatch, processed/confirmed/finalized distinctions, conflicting provisional
evidence, missing history, failed execution and wrong/incomplete account candidates.
Isolation tests pass valid DTOs into the real authorizer/policy and offline
observation factory: none restores an existing brand or signing permission.

A test-only consumed-ID set demonstrates an external-state requirement. It is not
a production idempotency implementation, durable fence or multi-process replay proof.
Acceptance of repeated structurally valid requests is explicitly tested as a
limitation, not reported as replay protection. Existing durable concurrency/crash
tests remain separate and unchanged.

## Human approval and Phase 8C-2C dependencies

Harshita authorized this offline implementation. No additional teammate approval,
custody choice, issuer/operator identity or RPC endpoint is invented. Existing
joint review applies to any future shared on-chain or financial-policy change.

Before separately approving Phase 8C-2C, resolve:
1. Actual approved public verifier/payer/control identities and authenticated issuer,
   operator, custody, sender and observer protocols.
2. Approved RPC/genesis/provider trust and history access, with raw transaction and
   account decoding/provenance. These DTOs cannot substitute for those adapters.
3. Trusted clock/skew and freshness policy, remaining-height margin, fee consent,
   current epoch authority and original-deadline propagation.
4. Durable signing/sender admission, permanent operation exclusion, custody-side
   fencing/revocation linearization, backup/restore anti-rollback and capacity.
5. Separate-purpose operational journal and migration approval. Keep historical v5
   offline flags/state and v4 reconciliation immutable; do not relabel old records.
6. Independent security review, dependency-security readiness, emergency shutdown
   and explicit approval before any operational key access, blockchain send,
   deployment or activation.

Recommended next work is approved mocked/read-only adapter and operational journal
contract design, preserving the architecture's gates. This PR enables none of it.
