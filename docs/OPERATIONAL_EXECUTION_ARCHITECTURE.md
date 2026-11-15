# Operational execution security architecture

**Phase 8C-2A: proposed architecture only.**
Reviewed baseline: main commit 911463d0e42362d8e3c157f6669e9434a079f892,
including merged [PR #37](https://github.com/harshitapunia/ProofOfWork/pull/37).
Prepared 16 November 2026 (Asia/Calcutta).

This document does not approve, implement or activate operational execution.
Every operational component and sequence below is **PROPOSED**, unless explicitly
marked **IMPLEMENTED**. Harshita authorized this design and documentation PR.
No additional approval from Palak or another reviewer is inferred.

This phase authorizes no operational signing, credential loading, wallet generation,
blockchain transaction, deployment, real funds or other cluster. It makes no frontend,
production Rust, financial-policy, ABI, account-layout, dependency or schema change.

Scope is future authorized attestation on Solana Devnet, with nonmonetary DEMO
tokens throughout the application. A verifier attestation does not transfer the
milestone reward; permissionless settlement is a separate existing instruction.
A distinct payer would pay Devnet transaction fees. This proposal does not add
settlement/refund automation, token-transfer instructions or new spending powers.

## 1. Existing architecture and guarantee inventory

Read this with [Execution and reconciliation](EXECUTION_RECONCILIATION.md),
[Signer architecture](SIGNER_ARCHITECTURE.md),
[Transaction intents](TRANSACTION_INTENTS.md),
[Contract specification](CONTRACT_SPEC.md),
[Team approval](TEAM_APPROVAL.md) and [Team workflow](TEAM_WORKFLOW.md).
Older phase-specific descriptions in those documents describe their original
scope; the Phase 8C-1 extension and current source establish schema v5.

| Boundary | IMPLEMENTED at the reviewed baseline | Still PROPOSED / blocked |
| --- | --- | --- |
| Evidence | VerifierService validates registered GitHub/repository/contributor/commit and committed requirements/evidence through trusted readers and isolated tests | Operational availability, credential custody and authenticated cross-process service composition need review |
| Authorization | AttestationAuthorizer issues and burns expiring process-local tickets; transaction policy checks and consumes the exact canonical message | Durable cross-process signing authority; SQL rows cannot recreate tickets |
| Transaction policy | One legacy attest_milestone instruction, exact program/accounts/flags/arguments, separate configured verifier/payer, approved Devnet lease, original deadline and fresh-state rechecks | Authenticated operational blockhash adapter and custody-side independent policy enforcement |
| Jobs/intents | Permanent operation identity, immutable canonical bindings, same-transaction revision/worker/generation fencing, retained v4 preparation records | External effects cannot be fenced by a local SQL check |
| Offline signing | Ephemeral dual-signature simulation checks genuine consumed-message provenance and actual public-key signature verification | Operational signer custody, durable signer-side attempts and secure signed-wire handling |
| v5 execution | One offline attempt per intent, append-only hash-chained events, CAS, bounded history, explicit uncertain/finality models | Operational signing/submission journal and authenticated live observations |
| Recovery | Separate current-fence executionRecovery control; post-revocation audit updates; uncertainty-before-identity can retain verified test identity without reopening invocation | Authenticated operational recovery and external custody reconciliation |
| Observation | Independent test-authority signature plus complete canonical two-signature transaction verification | Test provenance is not blockchain/RPC authenticity |
| Storage | Node 24.14.1 built-in SQLite, DELETE journal, EXTRA synchronization, bounded busy wait, exact historical migrations and same-host coordination | Operational backup/restore, anti-rollback and retention/capacity approval |
| CI | Six jobs cover finance, offline verifier/lifecycle, native Rust/advisories, compiled ABI, keyless SBF/LiteSVM and Node security/compatibility | No CI result proves custody security, live RPC authenticity or Devnet execution |

Source anchors:
- [Job fencing](../services/lifecycle/src/jobs.ts),
  [v4 intents](../services/lifecycle/src/transaction-intents.ts),
  [storage](../services/lifecycle/src/storage.ts) and
  [exact schema](../services/lifecycle/src/schema.ts).
- [v5 attempts/control](../services/lifecycle/src/execution-attempts.ts),
  [offline reducer](../services/lifecycle/src/execution-model.ts),
  [test observation verifier](../services/lifecycle/src/execution-observations.ts).
- [Authorization](../services/verifier/src/attestation.ts),
  [exact-message policy](../services/verifier/src/transaction-policy.ts),
  [durable offline coordinator](../services/verifier/src/durable-offline-coordinator.ts),
  [unsigned preparer](../services/verifier/src/offline-intent-preparer.ts),
  [signature simulation](../services/verifier/src/offline-signature-simulation.ts),
  [offline recovery](../services/verifier/src/attestation-recovery.ts) and
  [local invocation model](../services/verifier/src/offline-execution.ts).
- [Six-job security workflow](../.github/workflows/backend-validation.yml).

Schema-v5 execution outputs remain offline-test-model, rpcAuthenticated=false,
signingAuthorization=not_granted, submissionAuthorized=false and
retryAuthorized=false. A finalized test observation does not attest, settle or
pay a real milestone. Historical jobs, v3 mock receipts, v4 reconciliation records,
v5 events and test-authority identities remain permanently non-operational.
Process-local RecoveryObservation and authorization brands must not be hydrated
from SQL, JSON, another process or an operator's assertion.

## 2. Proposed operational architecture and trust boundaries

**PROPOSED; requires human security approval and approved public configuration.**
Use a narrow internal coordinator, an isolated custody boundary with two role
policies, a single controlled sender and a read-only observation/reconciliation
boundary. No browser-facing execution API. Student/sponsor clients, repository
code and test runners cannot reach custody or sender interfaces.

~~~mermaid
flowchart TB
  subgraph U["Untrusted application and execution inputs"]
    C["Client requests"]
    R["Student repository and isolated test runner"]
  end
  subgraph V["Existing trusted verifier boundary"]
    E["VerifierService and trusted evidence readers"]
    A["Single-use authorizer and exact-message policy"]
    D["Existing jobs, intents and offline v5 ledger"]
  end
  subgraph O["PROPOSED operator control boundary"]
    H["Authenticated operator: per-operation approvals and shutdown"]
    F["Durable effect authority: permanent operation and monotonic epoch"]
  end
  subgraph K["PROPOSED isolated custody and effect boundary"]
    G["Policy-enforcing signing admission"]
    S1["Verifier custody role"]
    S2["Separate fee-payer custody role"]
    T["Single sender admission and protected signed-wire reference"]
  end
  subgraph Q["PROPOSED trusted observation boundary"]
    P["Team-approved Devnet RPC transport and provider trust"]
    B["Exact transaction and finalized account-state validation"]
    X["Authenticated recovery control: observation only"]
  end
  C --> E
  R --> E
  E --> A
  A --> D
  A -->|"Fresh one-use admission, never stored-ticket restoration"| G
  H --> F
  F --> G
  F --> T
  G --> S1
  G --> S2
  S1 --> T
  S2 --> T
  T -->|"Explicitly approved first submission only"| P
  P --> B
  B --> X
  X -->|"Future operational audit projection; never test-token promotion"| D
~~~

Diagram boxes in O, K and Q are proposed trust domains, not shipped services.
The projection arrow requires a future reviewed operational storage interface;
it is not permission to feed live data to the offline v5 reducer.

### Custody and role separation (PROPOSED)

- A reviewed custody service/HSM boundary holds the verifier key and independently
  consented fee-payer key under distinct access policies. A specific provider,
  account identity, tenancy and authentication mechanism have not been selected.
  No environment/disk key loader is proposed for the verifier or runner.
- The verifier role may authorize only the canonical attestation for its recorded
  on-chain verifier. The payer role consents to those identical message bytes and
  approved Devnet fee limits; it cannot implicitly substitute its key or add an
  instruction. Separate keys alone do not prove independent custody or consent.
- Custody exports no private material. CI, application routes, GitHub workers,
  runner containers, support logs and chat receive no signing credentials.
  Authentication secrets belong in separately approved custody/configuration.
- Signed wire and even a verifier's partial signature are restricted capabilities:
  possession may enable completion/broadcast with the other role's cooperation.
  Store neither in general logs, public artifacts or frontend responses.
  Durable retrieval of an already accepted signature/wire is a separate,
  authenticated, audited operation; it must not cause another signing operation.
- The custodian must enforce message policy itself. A generic blind-sign endpoint
  with only a coordinator-side check is unacceptable. Selection must demonstrate
  durable deduplication, fencing and recovery at the actual key-access boundary.

### Authorization handoff (PROPOSED)

An operational admission request may be created only by a newly reviewed bridge
at genuine fresh policy consumption. This is a new authenticated protocol, not
serialization of a WeakMap ticket. Bind issuer/service identity, approved caller,
policy version, permanent operation/job/intent identity, exact message digest,
role/key pair, Devnet/genesis/program, blockhash/expiry, original deadline,
operator approval, payer consent, custody epoch and unique admission identity.

Cross-process authentication and durable one-use consumption must be specified
and tested before this protocol exists. Mode strings, job state, a digest, an
operator ID string or matching transaction bytes cannot authenticate the issuer.
Freshness must not restart at each hop; account for clock skew and rollback with
a separately approved clock/expiry policy. Loss of the issuing process does not
permit reconstruction of its ticket. Ambiguity blocks the operation.

No operational record may reference a historical offline preparation as authority.
If future operational records share canonical public bindings, their separate
provenance and purpose must be explicit, without clearing an existing reservation
to obtain a second attempt.

## 3. Exact-message and signing/submission sequence

**PROPOSED; no step is executable through this documentation.**

1. An authenticated operator explicitly selects a single eligible operation,
   approved policy/configuration version and fee-payer consent. Both signing and
   first submission require recorded approval; verification alone starts neither.
2. Run the existing trusted verification/authorization path afresh. Read current
   canonical program accounts and approved Devnet/genesis/blockhash context.
   Reserve the permanent operation; existing consumed/ambiguous identity blocks.
3. Build the sole permitted legacy attestation with the existing ABI builder.
   Independently recompile and compare the complete canonical unsigned wire and
   message: instruction discriminator/104-byte arguments, account order and
   signer/writable flags, program, PDAs, student, requirements/evidence, separate
   payer, blockhash and required signer positions. Reject versioned messages,
   address tables, nonce advance, extra/duplicate instructions, compute-budget
   additions, token transfers, unknown bytes and role/account aliasing.
4. Validate fresh authorization, current job revision/generation and external
   custody epoch. Atomically persist signing admission and permanent deduplication
   at the effect authority before requesting any role signature.
5. Custody validates the authenticated one-use request and exact policy, then
   durably consumes the role request before key access. Check shutdown/epoch at
   the same admission boundary. Preserve the original message/deadline.
   Each role has a distinct receipt. A partial signature is not permission to
   continue after revocation, expiry or uncertain custody completion.
6. Verify both returned Ed25519 signatures against their exact approved keys and
   original message. Assemble exactly one complete canonical transaction,
   serialize/deserialize/re-serialize it and check full wire equality.
   Bind message digest, signed-wire digest and the actual first-signature
   transaction ID. A digest or one signature is not a complete transaction.
7. Persist the complete signed identity and protected custody/wire reference.
   Custody acknowledgement means only that custody accepted its operation.
   A crash before a local receipt requires authenticated custody reconciliation,
   never re-signing.
8. Obtain explicit first-send approval for this exact wire/transaction ID.
   Recheck chain, remaining block heights, configuration, current control epoch,
   fee constraints and shutdown. Simulation/preflight may reject but never grants
   authorization or proves that a previous send did not happen.
9. Atomically consume the sender's one-use admission and commit submission intent
   before invoking the approved RPC once. The marker precedes the call: it proves
   intent/admission, not that packets reached the network. No SQL lock spans RPC.
10. Match any RPC acknowledgment to the already known transaction ID. Mismatch is
    a security incident. Acknowledgment alone proves no execution. Timeouts,
    disconnects, crashes and uncertain errors retain the signed identity and
    block every new signing/submission request.
11. The independent read-only observer obtains status, exact transaction and
    finalized resulting accounts. Recovery may append authenticated evidence
    under an explicit current control fence; it cannot re-sign, send, release
    resources or convert an old test observation into live evidence.

~~~mermaid
sequenceDiagram
  participant O as PROPOSED operator control
  participant V as Fresh verifier and exact policy
  participant F as PROPOSED durable effect authority
  participant K as PROPOSED isolated role custody
  participant T as PROPOSED one-use sender
  participant R as Approved Devnet RPC
  participant Q as PROPOSED read-only reconciler
  O->>V: Explicit operation approval
  V->>F: Fresh authenticated admission and exact identity
  F->>K: Consume fenced role requests before key access
  K-->>F: Authenticated role receipts or uncertainty
  Note over F,K: A lost response never authorizes re-signing
  O->>F: Explicit first-send approval for exact wire
  F->>T: One-use sender admission under current epoch
  T->>R: Proposed single approved invocation
  R-->>T: Matching acknowledgment or ambiguous response
  Q->>R: Read status, exact transaction and account evidence
  Q->>F: Authenticated evidence with current recovery fence
  Note over Q,F: No recovery path signs, sends or releases identity
~~~

The signed message does not encode a Devnet genesis identity. Custody, blockhash
provenance and approved RPC isolation must enforce cluster policy out of band.
Do not treat Ed25519 verification as chain selection or verifier authorization.

## 4. Durable signing bookkeeping and external fencing

**PROPOSED; schema-v5 behavior stays unchanged.** A future design must specify
an additive operational journal and migration/capability contract before code.
Do not add operational states to v5, relabel test observations or implement
RecoveryStore by reconstructing branded RecoveryAttempt objects.

Required public/audit fields include canonical operation/job/intent identity,
purpose/provenance version, approved message and policy digest, role public keys,
operator/payer consent references, original deadlines, blockhash lease, monotonic
external epoch, per-role request/receipt IDs, signing-intent/uncertainty events,
complete signed identity when known, sender admission, acknowledgments, status
evidence, resulting-account evidence and append-only revision/event identity.
Never persist private keys, seed phrases or private work preimages. Protect public
signature/wire references according to the capability sensitivity above.
Evidence must be attributable to an authenticated source, not merely hash-shaped.

Do not select a new backend database, ORM or distributed lock product here.
The backend remains on its existing same-host SQLite design. Independent custody
necessarily needs durable effect-boundary state; its storage/anti-rollback
mechanism is an unresolved provider/security decision, not a second backend
database introduced by this PR. No cross-store atomic commit is assumed.

External admission must satisfy these acceptance requirements:

- One permanent protected operation and one bound message; canonical role-specific
  idempotency keys include operation, message digest and role. Request IDs alone
  do not deduplicate. Conflicting bytes/roles under the same operation reject.
- Role signing and sender admission are durably consumed before their effects.
  Duplicate requests return only an authenticated existing outcome or uncertainty.
  They must not automatically perform a previously unrecorded effect.
- Current monotonic control epochs and stop state are enforced at custody and
  sender, not only by SQLite workers. Operator revocation must reach those
  admission points. A stale worker cannot overwrite the authority's higher epoch.
- The revoke-versus-admit decision has a defined linearization point. If revoke
  wins, the effect is denied; if admission already won, report it as potentially
  in flight. No design can retract a released signature or already forwarded
  transaction. A shutdown response must distinguish these cases.
- A fenced signing admission is not an unfenced transferable license to submit.
  The sender checks its own current epoch, exact wire and explicit send approval.
  Only the sender has approved network egress; no alternate library/fallback path.
- Effect authority failure, partition, uncertain crash, lost receipt or unavailable
  fencing storage denies further effects. Local worker leases or timeouts cannot
  stand in for positive custody-side enforcement.
- Rollback/restore cannot lower consumed-operation or epoch high-water marks.
  Backup recovery starts stopped and reconciles authoritative custody/sender
  history before any new admission. Hash chains alone do not prevent a hostile
  owner from rewriting history or an operator from restoring an older database.

The target is durable at-most-one admitted application invocation, not a claim of
exactly-once blockchain execution or atomic distributed effects. Disable SDK/HTTP
automatic retries for signing/submission, endpoint failover sends and implicit
resend loops. The future RPC request policy must explicitly disable controllable
RPC forwarding retries (for example, reviewed maxRetries=0 semantics); provider
internal behavior remains a trust/acceptance question. No automatic resubmission,
including identical signed bytes, is permitted by this proposal.

If the custodian cannot prove recoverable exact-request consumption at key access,
it is unsuitable. If consumption succeeded but no signature receipt is recoverable,
retain permanent uncertainty; do not call the key again. A different blockhash
would be a different signed message, not an idempotent retry.

## 5. RPC authenticity and observation contracts

**PROPOSED; requires approved endpoints, provider trust and security approval.**
An endpoint URL, getGenesisHash response or test signature is not a proof of
consensus. TLS authenticates the configured server, not the truth of its ledger.

The team must choose the trust policy: operator-controlled validator, approved
provider, or corroboration with independent approved providers. Independence,
archive retention and disagreement handling must be documented. Multiple providers
can share upstreams or collude; a quorum of JSON responses is not cryptographic
light-client verification. This proposal does not implement a light client or
claim to eliminate trust in validators/providers.

The adapter must enforce:
- Server-side allowlisted approved endpoint(s), TLS/host identity, controlled DNS
  and egress, bounded responses/deadlines, request/response correlation, and no
  redirects or caller-supplied URLs/credentials. Endpoint changes require review. The existing exact-message policy pins its
  Devnet endpoint/genesis; additional sources need an explicitly reviewed adapter
  contract and must not silently broaden that existing allowlist.
- Approved genesis at startup/reconnect/provider changes and for source-context
  validation; fail closed on wrong/unknown genesis, unavailable freshness checks
  or unexpected deployed program identity/upgrade configuration.
- Exact expected transaction ID, operation and message/wire identity, not an
  arbitrary caller's signature. Authentication of control-plane callers and
  operator identities is separate from RPC authentication.
- Bounded schema/encoding checks, lossless u64 heights/slots, result cardinality,
  commitment, execution error, transaction slot, observation context and source
  policy version. Preserve source disagreements rather than selecting a success.
- getSignatureStatuses with explicit historical search where required. A null
  status or pruned history is unknown, not proof of non-submission.
  [Official status reference](https://solana.com/docs/rpc/http/getsignaturestatuses).
- getTransaction at the required commitment to check exact signed bytes/message,
  both role signatures, format, slot and execution metadata. Missing transaction
  or metadata blocks positive classification.
  [Official transaction reference](https://solana.com/docs/rpc/http/gettransaction).
- Websocket notifications, if later approved, are provisional hints; reconnect
  gaps require authenticated historical reads. Never accept client-confirmed JSON.

Only a validated operational adapter may issue a new, separately branded live
observation. Bind event ID, attempt/revision, canonical public context, provider
identity, source request/context, transaction identity, commitment, error and
evidence digests. Consume it once under current recovery authority and revision
CAS. Persist accepted provenance for audit without treating a deserialized row
as a fresh trusted observation. No offline factory or test-authority key is
accepted by the operational consumer. Network authentication/provenance and
cryptographic transaction validation are separate checks.

## 6. Confirmation and resulting account-state reconciliation

**PROPOSED.** Track transaction outcome, finality, resulting program state and
uncertainty as separate dimensions. Suggested descriptive labels below are not
new stored v5 states or an approved migration.

~~~mermaid
stateDiagram-v2
  [*] --> Reserved
  Reserved --> SigningAdmission: explicit approval and valid custody fence
  SigningAdmission --> SignedIdentity: verified complete signing receipts
  SignedIdentity --> SendIntent: explicit first-send approval
  SendIntent --> AckObserved: matching RPC acknowledgment
  SendIntent --> ReconciliationRequired: timeout or crash
  AckObserved --> Processed: trusted provisional observation
  Processed --> Confirmed: matching stronger evidence
  Confirmed --> FinalizedTransaction: authenticated finalized outcome
  FinalizedTransaction --> AccountsVerified: success and matching finalized account evidence
  FinalizedTransaction --> ReconciliationRequired: missing or conflicting state
  AccountsVerified --> OperatorClosed: reviewed evidence-only close
  SigningAdmission --> ReconciliationRequired: lost signing outcome
  SignedIdentity --> ReconciliationRequired: expiry or shutdown
  ReconciliationRequired --> FinalizedTransaction: sufficient authenticated evidence
~~~

This is an illustrative flow, not an exhaustive transition table. Trusted evidence
may establish a finalized transaction without a prior local ack/processed marker.
Finalized failure is retained as failure, never routed to successful AccountsVerified.
OperatorClosed means audit classification only; no operation/resource is released.
No transition from reconciliation authorizes signing/submission. Factual evidence
may resolve uncertainty; unavailable evidence leaves the operation blocked.

Processed and confirmed observations remain provisional. Forks may legitimately
change a provisional landing slot or outcome. The offline v5 reducer conservatively
rejects conflicting outcomes/slots; do not silently reuse it as an operational
fork-resolution algorithm. A future event model must retain all source/fork
evidence, freeze effects on conflict and require authenticated finalized evidence
plus an approved resolution policy. Never erase an earlier event or silently
downgrade stronger evidence. Conflicting finalized sources trigger security review.

Proposed positive completion requires all of:
1. Finalized outcome with no execution error for the exact approved transaction.
2. Exact canonical message, valid signatures and intended program/instruction.
3. Finalized account evidence from an approved trusted source at a context no
   older than the finalized transaction slot, with a documented consistency rule.
4. Full owner/discriminator/layout/length/PDA/parent/role/commitment/state checks
   using the approved account decoders and contract invariants.
5. No unresolved source, identity, epoch, expiry or account-state contradiction.

For attestation, validate the same Internship, Milestone and immutable Submission,
recorded verifier/student, requirements/evidence hashes, timely submitted_at and
verified_at invariants. Expected milestone status is Verified. A later valid
Settled state can be consistent if its canonical immutable CompletionRecord and
all attestation provenance match; classify the later state separately. Do not
claim this attestation transaction paid a reward. An impossible Refunded state
after this submission, wrong linked account or mismatched completion blocks.

Batch related account reads at finalized commitment and a reviewed lower context
bound. minContextSlot is a freshness floor, not an exact historical snapshot or
proof of inclusion. Current account state alone cannot attribute a change to this
transaction; exact finalized transaction evidence is also required. If another
transaction produced a matching state, retain this transaction's actual outcome.
A finalized failed transaction plus a Verified account does not become success.
Missing accounts/data, null getTransaction, missing history or incomplete metadata
must not be explained away by an acknowledgment or a known signature.
[Official account-read reference](https://solana.com/docs/rpc/http/getmultipleaccounts).

A separate future settlement observer would additionally validate principal/surplus
and mint/authority protections, completion, vault closure and sponsor rent return.
That scope belongs to a separately reviewed design with the teammate owners; this
document changes none of those policies or completed components.

## 7. Blockhash, expiry and freshness policy

**PROPOSED.** Bind a single trusted blockhash with lastValidBlockHeight and its
source context before signing. Obtain coherent commitment/context observations
from approved Devnet sources, enforce original authorization time bounds and a
team-approved remaining-height safety margin before each irreversible admission.

Use block heights for expiry, slots for ledger context, and a trusted clock for
authorization freshness. Do not compare slots to block heights or substitute
elapsed wall time for expiry. Current policy rejects unsafe JS numbers; future
adapters must preserve integer precision rather than silently truncate u64 values.
[Blockhash reference](https://solana.com/docs/rpc/http/getlatestblockhash) and
[block-height reference](https://solana.com/docs/rpc/http/getblockheight).

Once observed height exceeds the bound last valid height, deny new signing/send
admission and continue read-only reconciliation. A transaction might already have
landed before expiry. Expiry plus null lookup is not proof it never landed.
No automatic blockhash refresh, replacement transaction, renewed approval, new
attempt, re-signing or resubmission. Durable nonce and alternative transaction
formats remain outside the approved policy. If safe liveness eventually requires
a new-message protocol, that is a separate explicit policy/design decision;
this proposal keeps the operation blocked instead.

## 8. Failure and crash-recovery matrix

All rows are **PROPOSED operational behavior**, not claims that live recovery exists.
Reservations and known evidence remain retained in every row.

| Failure/window | Conservative interpretation | Required action; forbidden inference |
| --- | --- | --- |
| Crash before fresh signing admission | Authorization may be lost; custody status must be checked if delivery was possible | Block; authenticate custody/effect history. No ticket reconstruction or automatic signing |
| Crash after admission but before key receipt | Custody may have signed even without a local signature | Query exact durable custody request read-only; no role re-sign |
| Partial signature or one-role timeout | A usable partial capability may exist | Retain role identity; stop the other role and sender pending reviewed reconciliation |
| Crash after both signatures | Wire may exist outside the coordinator | Retain protected identity/reference and custody receipts; no new message |
| Crash before submission invocation | An intent marker alone does not establish whether a call occurred | Consult sender admission/effect history; never infer no send from missing ack |
| Timeout/error during submission | Bytes may have reached RPC/validator | Block all sends/signing; query the precomputed exact transaction ID |
| Matching acknowledgment then crash | RPC acceptance only | Observe independently; do not label execution success |
| RPC disconnect or unavailable history | Source incomplete | Read-only recovery when trusted source returns; no fallback send or fabricated outcome |
| Unknown/null transaction outcome | Could be absent, pending, pruned or unseen by source | Keep reconciliation required; no release or retry |
| Duplicate request | Same permanent operation, possibly already consumed | Return only authenticated retained classification/reference, never execute again |
| Concurrent workers | One may already have won external admission | SQLite CAS and effect-boundary permanent uniqueness; stale requests denied |
| Stale/revoked worker reuses approval | A leaked signature may still exist | Deny custody and sender under current epoch; do not restore authorization |
| Expired blockhash | No new admission, but prior execution is possible | Read-only historical reconciliation; no refreshed blockhash or replacement attempt |
| Conflicting provisional observations | Possible forks, provider lag or false data | Freeze effects, retain all evidence, await reviewed finalized resolution |
| Conflicting finalized observations | Trust/consistency incident | Stop affected source/control scope; independent investigation, no success selection |
| Confirmed transaction, missing account change | Finality or semantic evidence incomplete | No operational success/settlement claim; await finalized exact account evidence |
| Finalized success, mismatched accounts | Attribution/state/security contradiction | Reconciliation/security hold; no resource release or new attempt |
| Finalized failure with matching state from elsewhere | This transaction still failed | Preserve distinct outcomes; do not attribute another actor's state change |
| Operator shutdown during uncertain send | Already admitted packets may still land | Revoke future admissions, retain uncertainty; read-only observation remains available |
| Journal full, busy, corrupt or restored old snapshot | Durable exclusion/freshness not established | Deny effects; no pruning, reset, secondary DB or retry-based bypass |

Recovery queries may be scheduled only under an approved bounded read-only policy;
they cannot invoke signing or transport side effects. Silence is never evidence
of completion or non-execution.

## 9. Operator approval and emergency shutdown

**PROPOSED; requires named approved public control identities and security review.**

- Default state is disabled. Enabling a feature flag is insufficient: independently
  approved custody identity, caller authentication, configured Devnet provenance,
  reviewed artifact, fee consent, external fencing and all acceptance gates apply.
- Approvals bind one permanent operation, one exact message/policy version, both
  role public keys, a deadline, and intended action (sign or first send).
  Authenticate the approver; an operatorId field is audit metadata, not a credential.
  Define who can approve, who can revoke, and whether dual control is required.
- A stop command durably advances the control epoch and denies new admissions at
  custody and sender. Require positive acknowledgments from each boundary; absence
  of one means shutdown effectiveness is unconfirmed, not successful.
- Stop affects queued requests and new role steps. Already admitted signatures or
  packets are potentially in flight and cannot be recalled. Restrict network egress
  as an additional control without pretending it revokes public signed bytes.
- Read-only observation/audit remains available during stop under separate
  credentials/capabilities. Recovery control cannot turn execution back on.
- Restart requires explicit approved review of uncertain operations and authoritative
  high-water marks. Re-enabling cannot clear reservations, renew consumed tickets or
  replay old approvals. Key rotation is not a workaround for immutable verifier
  bindings; current program verifier-rotation/recovery policy is unchanged.

## 10. Threat model

**PROPOSED controls require implementation and acceptance evidence.**

| Threat | Existing protection / proposed operational control | Residual risk or approval |
| --- | --- | --- |
| Malicious repository, runner or client | Existing trusted verification; no custody credentials or egress from untrusted execution | Runner isolation and evidence quality remain trusted assumptions |
| Forged result/SQL row/test receipt | Existing one-use policy brands; proposed authenticated fresh bridge and separate live observation types | Compromised trusted issuer remains a security boundary |
| Arbitrary-message or reward redirection | Existing canonical attestation policy; custody independently reconstructs exact bytes; no extra transfer instructions | On-chain ABI and financial policies must stay frozen |
| Verifier/payer substitution or fee abuse | Independent approved role keys/consent, exact signer positions and explicit fee limits | Custody selection, payer budget and role independence unresolved |
| Stale worker / revoke race | Existing local CAS; proposed monotonic authority at actual custody/sender admission | Already admitted effects cannot be recalled |
| Duplicate sends or hidden provider retries | Permanent external deduplication, one sender, explicit retry prohibition and provider acceptance tests | Network/provider internal forwarding is not app exactly-once execution |
| Forged, stale or malicious RPC evidence | Approved transport/server policy, genesis/transaction/context checks and source disagreement hold | TLS/genesis is not ledger truth; provider/validator trust persists |
| Provisional fork/reorg | Separate finality and account evidence, append-only conflict history and stop | Final resolution policy still needs approval |
| Signed-wire theft | Protected custody reference, least privilege and no logs/browser exposure | A leaked signed transaction can be broadcast outside local fencing |
| Custody compromise | Isolation, role-specific policy, authenticated callers, audit/revocation and fee limits | A compromised designated verifier can attest falsely; software cannot erase this trust |
| Database rollback or hostile owner | Same-host safeguards plus proposed independent custody high-water marks | Hash chains alone do not authenticate hostile-owner data |
| Fail-open shutdown / unbounded dependency wait | Positive boundary stop acknowledgments, bounded timeouts, uncertainty retained | Availability is intentionally sacrificed to safety |
| Dependency compromise / CI leakage | Preserve pinned actions/read-only permissions/locked installs/security gates; no signer secrets in CI | Root tooling advisory remediation remains an activation prerequisite |

## 11. Required public configuration and human decisions

**REQUIRES EXTERNAL CONFIGURATION.** Obtain approved values from Harshita/Palak
through the team process before an implementation depends on them. Do not infer
wallet identities from test fixtures, GitHub usernames, existing mint authorities,
a sponsor or process environment. No new identity, address or endpoint is supplied
by this document.

| Configuration/decision | Required confirmation |
| --- | --- |
| Devnet program and artifact | Reconfirm recorded program ID in SHARED_FOUNDATION.md, deployed artifact identity, upgrade authority and activation status; repository configuration is not deployment proof |
| DEMO mint | Reconfirm the approved classic SPL mint/decimals/no-freeze policy in TEAM_APPROVAL.md for any later token-related scope; no new mint invented |
| Genesis and RPC | Approved Devnet genesis, endpoint allowlist, transport/server/provider trust, independent/history sources and provider retry behavior |
| Verifier public key | Approved operational key matching the milestone's immutable verifier, custody provenance and revocation plan |
| Distinct payer public key | Explicit fee consent, approved Devnet fee budget, custody separation and funding responsibility; no payer fallback |
| Control identities | Authenticated issuer/coordinator/operator/reconciler/sender identities, approver/revoker roles, dual-control decision and rotation |
| Custody/effect authority | Policy enforcement, durable consumption, epoch/anti-rollback storage, authenticated receipts and exact-request recovery guarantees |
| Timing/finality | Original-deadline propagation, maximum skew, remaining-height margin, commitment policy, finality/account consistency and fork/conflict resolution |
| Storage/evidence | Operational journal design, migration approval, signed-material protection/retention, capacity beyond v5's 32 mutations, backup/restore and incident response |

**REQUIRES HUMAN SECURITY APPROVAL.** Harshita coordinates the proposed backend
work. Existing teammate ownership remains intact. Any future shared Rust,
instruction, account-layout, PDA, on-chain state or financial-policy change needs
the existing joint review; none is authorized here. Design approval, implementation
approval, custody provisioning, key generation, deployment and first Devnet
execution are separate approvals. No secret/seed phrase is requested in chat.

## 12. Security acceptance criteria for later implementation

All are **PROPOSED release gates**, not executed tests in this documentation PR:

1. Offline default and route/import tests prove no credentials, network send or
   signing effect can be activated by request input, environment fallback or test mode.
2. Real in-memory test crypto rejects forged/serialized/expired approvals, mutated
   canonical bytes, wrong program/accounts/flags/commitments, wrong roles, missing
   or corrupt signatures, alternate formats and wrong transaction IDs.
3. Fresh protocol admission is authenticated, one-use, original-deadline-bound and
   non-restorable from historical v3/v4/v5 records or offline observation tokens.
4. Actual separate-process custody/sender tests deterministically race duplicate
   requests, concurrent workers and epoch revocation at the key/send admission
   points. Prove one accepted effect, rejection of conflicting messages, and
   conservative uncertainty on lost receipts; an in-memory mock lock is insufficient.
5. Kill processes before/after each role admission/key response and submission
   boundary, including between durable commit and invocation. Restart never
   re-signs, re-sends, renews authority or releases protected identity.
6. Adapter tests reject wrong source/genesis, redirected URL, malformed/cardinality
   responses, stale context, unsafe integer coercion, mismatched exact transaction,
   missing history, conflicting errors/outcomes and forged confirmation JSON.
7. Test processed/confirmed/finalized distinctions, provisional fork disagreement,
   missing ack, historical null and expiry without execution-negative inference.
8. Test finalized exact transaction plus all canonical account checks; reject a
   successful status with wrong/missing program state and distinguish later valid
   settlement or state caused by a different transaction.
9. Prove stale workers and unavailable effect authorities fail closed; shutdown
   before admission denies effects, shutdown after admission reports uncertainty.
   Test that read-only recovery cannot obtain signing or sending capabilities.
10. Test backup rollback/high-water-mark recovery, retention exhaustion, corrupt
    history, bounded busy waits and migration interruption without schema-v5 repair,
    relabeling test provenance, pruning or database substitution.
11. Preserve all existing authorization, refund/settlement, ABI, lifecycle and
    runtime regression/security gates. Keep six CI jobs, pinned actions,
    read-only permissions, Node 24.14.1 and reproducible installs. No CI custody secrets.
12. Independent security review signs off on custody, protocol, provider trust,
    failure/recovery semantics and the dependency-security posture. Separately
    approved Devnet DEMO end-to-end validation is required before activation;
    none is executed or authorized by this PR.

## 13. Proposed implementation PR sequence and unresolved risks

| Proposed PR | Scope | Mandatory stop/gate |
| --- | --- | --- |
| 1: Phase 8C-2B offline acceptance contracts | Versioned operational protocol/event schemas and adversarial fixtures, no real credentials/keys/RPC sends | Human approval of this architecture, scope, threat model and acceptance contracts first |
| 2: Read-only observation/reconciliation adapters | Approved-source transport validation, exact transaction and finalized account decoders; mocked fixtures first | Explicit public configuration and authorization before any live reads; no signing or send imports |
| 3: Operational persistence and effect-authority contract | Separate-purpose additive journal design/migration, permanent operation bridge, custody epoch and anti-rollback tests | Review schema/capacity/backup design; keep v5 historical semantics unchanged |
| 4: Custody and dual-role admission | Authenticated fresh-policy bridge, independent custody message enforcement, durable signer-side idempotency | Separately approved custody and independent security review; no operational keys/signing in this phase's test build |
| 5: Sender/shutdown and crash integration | One-use first-send contract, disabled transport test double, revocation and complete cross-boundary crash tests | No real broadcaster enabled; all earlier gates pass |
| 6: Separately approved Devnet activation review | Configuration attestation, reviewed build, operational runbook and authorized DEMO-only end-to-end exercise | Explicit operator/team authorization for any operational signing, transaction or deployment; not authorized here |

PR numbering is a proposed dependency order, not GitHub PR numbers or an approved
implementation schedule. No automatic continuation from this documentation task.

Unresolved decisions that block safe activation:
- Which custody product can enforce exact message policy and durable idempotency
  at key access, rather than merely claim it at an upstream proxy?
- Who controls independent verifier/payer consent, operator approvals, epochs and
  emergency stop? What evidence proves revocation reached every effect boundary?
- Which provider/validator trust model and archive coverage can support a positive
  outcome? How will provisional forks and conflicting finalized sources be resolved?
- What operational journal/version and protected signed-material reference model
  preserves permanent operation identity without promoting historical offline rows?
- How are clock skew, fee limits, blockhash freshness, capacity and restore
  high-water marks enforced? There is no approved automatic replacement-message
  or retry policy, so permanent uncertainty may sacrifice liveness.
- A program upgrade can change behavior after an identity/artifact check. Approve
  upgrade-authority controls and execution-stop/change windows; preflight cannot
  remove that cross-boundary race. No deployment or upgrade is authorized here.
- How will current root developer-tooling advisory debt and reviewed Rust
  maintenance notices be remediated/reassessed before operational custody?
  Existing exceptions are not approval to use vulnerable tooling for signing.

The reviewed architecture intentionally retains uncertain operations indefinitely
when proof is unavailable. A requirement for guaranteed payout/execution liveness
would need separate recovery-policy approval; it cannot be achieved by weakening
authorization, reusing consumed identity, guessing non-execution or silently retrying.
No document can make leaked signatures revocable or untrusted JSON consensus proof.

### Reference and validation notes

Solana references reviewed for protocol semantics, 16 November 2026:
[transaction confirmation/expiry](https://solana.com/developers/cookbook/transactions/confirmation),
[submission acknowledgment](https://solana.com/docs/rpc/http/sendtransaction),
[status history](https://solana.com/docs/rpc/http/getsignaturestatuses),
[exact transaction retrieval](https://solana.com/docs/rpc/http/gettransaction),
[account context](https://solana.com/docs/rpc/http/getmultipleaccounts),
[blockhash lease](https://solana.com/docs/rpc/http/getlatestblockhash) and
[block height](https://solana.com/docs/rpc/http/getblockheight).
These are documentation URLs, not new configured RPC endpoints. They do not
authorize an SDK upgrade, operational call or deployment.

This PR changes this architecture document only. Applicable validation is
documentation structure/link-target checks, targeted credential/scope scans and
git diff --check; recorded execution results belong in the delivery report.
Prior phase test totals are not claims of test execution in this design task.
