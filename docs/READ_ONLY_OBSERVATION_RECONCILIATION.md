# Read-only observation and reconciliation

## Status and existing architecture

**IMPLEMENTED OFFLINE — Phase 8C-2C.** This internal verifier module reads injected deterministic fixtures and a projected execution lookup. It compares evidence and returns immutable non-authorizing data. It has no endpoint selection, environment fallback, network client, signing dependency, send method, browser route or persistence writer.

The baseline is main fedb4e2a0b688f68037e666e29f6551eec7f56c0 (merged PR #39). [Operational protocol contracts](OPERATIONAL_PROTOCOL_CONTRACTS.md) remain the canonical validation boundary. [Execution reconciliation](EXECUTION_RECONCILIATION.md) remains the schema-v5 offline ledger. [Operational execution architecture](OPERATIONAL_EXECUTION_ARCHITECTURE.md), [signer architecture](SIGNER_ARCHITECTURE.md), [transaction intents](TRANSACTION_INTENTS.md) and [offline authorization](OFFLINE_AUTHORIZATION.md) retain their existing meanings.

No protocol version, existing enumeration, WeakSet capability, account decoder, instruction, ABI, financial policy or database schema changes. No Palak approval is claimed. Shared Rust/interface or financial-policy changes require the joint review specified in [team approval](TEAM_APPROVAL.md) and [team workflow](TEAM_WORKFLOW.md).

## Offline adapter contract

The internal entry point is services/verifier/src/read-only-observation.ts. Construct OfflineReadOnlyObservationAdapter with:

- One to eight plain own-data sources: mode offline_mock, sourceId, readStatus, readTransaction and readAccounts.
- A plain projected lookup with only get(attemptId). Wrap the existing executionAttempts.get; do not pass its writer facade.
- Explicit readTimeoutMs in 1..10000. There is no implicit endpoint or timeout configuration.

observe takes a plan containing the existing admission, complete signed submission, protocol anchor, snapshot, execution reference, request identity, minimum context slot, one event per selected source, and up to 32 caller-supplied prior events. Missing/extra fields, accessors and noncanonical data are rejected. These expectations are structurally validated through Phase 8C-2B before any source read. Synthetic missing-evidence DTOs used to validate expectations are never presented as observed source evidence.

Each source receives an immutable query binding operation, transaction, execution attempt, request, event, context floor and the four canonical account addresses. It returns explicit status, transaction-details and account-read DTOs, or missing-result DTOs. Status is read first, then corroborating transaction details; account reads occur only for a consistent success claim. Every read is bounded and performed once. A timeout does not cancel arbitrary injected callback code; late completion cannot update the returned result. Callbacks are trusted composition code, while their returned data is untrusted. This interface cannot sandbox an arbitrary callback that itself performs unrelated effects.

The pure reconcileOfflineReadEvidence entry point revalidates raw bundles and execution views. It never trusts a caller-supplied classification or authority flag. Errors are reduced to stable reason codes; transport exception messages are not returned. Invalid plans/execution identities reject the call. Invalid source read bodies preserve known status and yield incomplete/unresolved evidence.

## Transaction identity and trust boundaries

Correlation binds operation key, verification job ID/identity, intent ID/identity, preparation format/message digest/blockhash/validity interval, fee payer, all approved job bindings, execution attempt ID/identity and revision, complete signed-wire digest and transaction signature.

The existing Phase 8C-2B validators verify the canonical complete signed transaction, both signatures, exact attestation instruction/message and original admission/submission linkage. Detail reads must supply the exact expected wire and transaction ID. Status and details must agree on outcome, error and landing slot. A complete signed transaction proves signature/message consistency; it does not prove that the transaction was submitted or exists on Devnet.

These properties remain separate:

| Property | Meaning in this phase |
| --- | --- |
| Structurally valid data | Checked using the existing protocol and strict new read envelopes |
| Cryptographically consistent wire | Checked with existing canonical transaction/signature utilities |
| Authenticated RPC evidence | Always false |
| Verified live resulting state | Always false |
| Authority to modify operational state | Always false |

The existing lookup validates genuine v5 records when composed with LifecycleStore. A caller-created view or mode string is not a trusted capability. The adapter does not independently authenticate a database supplied by its caller.

## Source limitations and context

Every accepted read identifies source, request, event, Devnet genesis context, context slot and commitment where applicable. Expected transaction identity remains bound by the query and transaction evidence. Source IDs must be configured in the existing protocol snapshot and selected plan; responses must echo their selected source/request/event.

offline_fixture and unverified_reference retain their protocol meanings. Neither is relabeled authenticated. No mock provider is operationally authenticated, including two providers that agree.

Within a source, context slots cannot regress between status, detail and accounts. Reads must satisfy the minimum context floor and caller-supplied prior context. Account context must cover the transaction landing slot. Block heights are canonical lossless integers and cannot predate preparation. Slot freshness is a lower-bound comparison, not authenticated time or proof of consistency across RPC reads.

Prior events are a bounded caller-supplied snapshot, not a durable replay journal. Duplicate source/event pairs are retained as conflicts; configured sources cannot be silently omitted. Losing that history cannot establish that an event is new. Distinct sources may use the same event string because identity is the pair (sourceId, eventId).

## Finality and classification

| Classification | Offline interpretation |
| --- | --- |
| missing_evidence | No usable status; timeout, null lookup and missing history remain distinct reasons |
| incomplete_evidence | Per-source read is partial, invalid or lacks corroborating transaction detail |
| conflicting_evidence | Contradictory outcome/error/landing slot, duplicate event, or differing otherwise matching raw account sets |
| provisional_observation | Corroborated processed claim only |
| confirmed_observation | Corroborated confirmed claim only |
| finalized_failure | Corroborated finalized failure claim |
| finalized_success_candidate | Finalized success claim without complete finalized matching raw state |
| account_state_mismatch | Raw data fails the approved layout/relationship/postcondition checks |
| matching_finalized_candidate | All selected sources provide matching finalized transaction claims and raw state |
| reconciliation_required | Missing provider, partial evidence, commitment regression or changed execution context |

An incomplete source keeps its own reason/classification; the aggregate holds reconciliation rather than treating another source as decisive. A single missing source yields missing evidence; a missing source alongside usable evidence holds reconciliation.

The aggregate uses the weakest corroborated transaction commitment across selected sources. Detail commitment regression holds reconciliation. Stronger detail evidence cannot upgrade an earlier weaker status. A finalized failure never becomes success. Timeout, null lookup, history loss and expiry do not prove non-execution, authorize retry or release uniqueness.

Every result permanently sets rpcAuthenticated, onChainStateVerified, operationalStateMutationAuthorized, submissionAuthorized, retryAuthorized, reservationReleaseAuthorized, settlementPermission and operationalUncertaintyClearAuthorized to false, signingAuthorization to not_granted, and reconciliationRequired to true. Even matching_finalized_candidate grants no authority.

## Raw account validation and postconditions

Read fixtures contain addresses plus owner, executable and canonical base64 data, rather than caller-decoded state assertions. The account comparison reuses unchanged lifecycle decodeInternship, decodeMilestone, decodeSubmission and decodeCompletionRecord, backed by approved Rust layouts and PDA derivations.

Validation covers owner/program identity, executable flag, discriminator, exact size, canonical base64, all canonical PDAs and bumps, sponsor/internship/milestone IDs and relationships, DEMO mint, student, verifier, requirements/evidence commitments, valid status and timestamp relationships. Missing required accounts remain insufficient. Raw account metadata supplied in place of bytes cannot satisfy the comparison.

The expected attestation postcondition is Verified. A later Settled fixture can also be compatible, provided a complete canonical completion record matches the milestone, submission, all parties, commitments and timestamps. At Verified, absent completion or a canonical prefunded empty non-executable System account follows the existing reader policy. Missing completion at Settled is insufficient; corrupted completion is mismatch.

No extra raw serializer or production decoder is introduced. Test-only buffers reuse existing account fixtures and the compiled Rust completion fixture with explicitly patched public bindings.

attest_milestone and settlement remain separate. Verified does not mean paid. A compatible later Settled fixture does not prove a token transfer. This layer does not inspect token balances or execute settlement/refunds.

## Multi-source reconciliation

Compatible different context slots are accepted when raw content and factual transaction identity agree. Outcomes, execution errors and landing slots cannot be selected by majority or highest finality. Contradictions are retained as conflicts.

Otherwise-valid differing raw account content holds a conflict, including potentially legitimate lifecycle advancement between providers. This conservative hold is not an assertion that a provider is malicious. An operational policy must independently establish whether different reads represent authenticated compatible progression.

Partial or unavailable selected sources keep the result unresolved. No voting, implicit quorum, fallback endpoint or authenticated-source preference is implemented. A future operational adapter must never let a higher unauthenticated finality claim override lower authenticated evidence.

## Failures, crashes and recovery

Execution views are read before and after source reads. Different attempt revisions or changed visible intent context hold reconciliation. This is an observation-time check, not an external custody fence; it does not close races after return or independently authenticate worker state. A read after revocation remains allowed and non-authorizing. It cannot revive worker authority or clear existing uncertainty.

The adapter writes no jobs, intent history, execution facts, observation history or reservations. It creates no recovery tokens. Restart does not hydrate capabilities from JSON. Caller-supplied history can improve duplicate/freshness checks but cannot become durable authority.

Tests kill an owned child process at ten checkpoints: before read, during status, after status, during accounts, between status/accounts, after complete comparison, inside classification, after revocation, after restart and with missing history. After reopening the same v5 ledger, committed rows/history and uniqueness remain intact; missing evidence stays unknown. These are real process interruptions, not mocked crash return values.

A future approved read retry must be separated from transaction execution retries. This implementation performs no automatic read retry and no submission retry.

## Proposed operational journal — design only

**PROPOSED OPERATIONAL.** No schema-v6 migration or second database is implemented. Preserve Node 24.14.1, built-in node:sqlite, schema v5, rollback DELETE, synchronous EXTRA, existing single-host fencing, revision CAS and permanent uniqueness.

Any separately approved operational journal design must specify:

| Concern | Required design |
| --- | --- |
| Immutable operation | Bind permanent operation/job/intent/preparation/execution identities; never recycle reservation |
| Transaction identity | Bind exact validated wire/message/signatures without treating wire existence as landing evidence |
| Source | Bind independently authenticated provider/config revision, Devnet genesis and request context |
| Event/revision | Append-only source/event uniqueness, bounded canonical payload, revision CAS and monotonic progression |
| Raw state | Retain owner/address/layout/content digest and complete read context sufficient for independent revalidation |
| Finality | Preserve processed/confirmed/finalized claims and contradictions; never overwrite lower-level provenance |
| Conflicts | Retain conflicting observations and explicit resolution rationale without silent winner selection |
| Crash recovery | Persist committed evidence atomically, preserve unknown outcomes and prohibit implicit execution retry |
| Reconciliation authority | Separately validated, fenced, operator-approved capability; a DTO or row cannot grant it |
| Retention | Explicit evidence/audit retention and size limits; no silent loss of uncertainty or reservations |
| Corruption | Strict schema/hash/history validation, fail closed; do not auto-repair authoritative facts |
| Backup/restore | Consistent same-host backup, verified restore, monotonic epoch and fence checks before activation |
| External fencing | Custody/sender must reject revoked epochs outside SQLite; no lock across network calls |
| Operator approval | Named public policy/config/approval references, independent role review and explicit activation gate |

If durable storage becomes necessary, obtain separate concrete schema approval and migrations/recovery tests. The existing offline test ledger must never be reinterpreted as an operational journal.

## Future public configuration and remaining gaps

**PROPOSED OPERATIONAL.** A live read-only adapter needs separately approved public endpoint identities, authenticated transport/provider policy, source allowlist/configuration revision, approved Devnet genesis/program IDs, commitment/freshness/timeout policies, maximum response sizes, history guarantees, archival availability, independent-source rules and operator approval references. Do not invent endpoints or public addresses. No credentials should appear in documentation, fixtures or frontend.

Further work must independently review source authentication, RPC trust and equivocation, account-slot consistency, durable provenance/retention, restart/backup fencing, external custody fencing and trusted reconciliation authority. No live adapter, operational signer/sender, execution route, deployment or autonomous financial operation is enabled here.

## Adversarial evidence and CI

New test files are read-only-observation.test.ts and read-only-ledger.test.ts; read-only-helpers.ts and read-only-process.ts are supporting fixtures. They run through the existing verifier test glob in hosted CI; all six backend-validation jobs, pinned actions, Node version, read-only permissions, reproducible locks, Rust/ABI/runtime coverage and provenance checks remain present.

Coverage includes complete signed public wire/raw account fixtures; all finalities; finalized failure; timeout/null/history; wrong signature/wire/message/program/genesis/fee payer/job/intent/execution identity; wrong account owner/executable/discriminator/layout/PDA/party/commitment/status/timestamp; missing and corrupt completion; missing accounts; conflicts, duplicate events, mixed finality, stale contexts and unavailable sources; source exceptions and partial bodies; forged authority/send/writer fields; real v5 compatibility, revocation and process restart. Existing capability consumers reject the new result and serialized copies. Real ledger snapshots/history remain unchanged and the operation reservation remains unique.

Local and hosted test counts, exact commits, SBF hashes and review results belong in the delivery report/PR evidence. Fixture success must never be described as live Devnet or complete application validation.
