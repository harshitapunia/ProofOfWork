# Offline execution and reconciliation (Phase 8C-1)

## IMPLEMENTED OFFLINE design

The v5 ledger is bookkeeping, never authorization. It retains one attempt per
immutable v4 intent (and therefore per permanent protected operation). Its identity
includes canonical job/intent/preparation identity, fee payer and a pinned independent
test-observation public key. Historical v4 preparations and mock receipts remain
unchanged and cannot become executable. No live observation adapter is implemented.

Submission intent, invocation marker, acknowledgment, processed, confirmed and
finalized evidence are distinct. The invocation marker precedes the local test
double; its absence never proves absence of effects. Timeout/exception requires
reconciliation, never retry. Finality may only strengthen matching transaction,
slot, error and outcome. Transaction success is not resulting account-state proof.

Only independently signed offline test statements and fully verified canonical
two-signature legacy transactions can produce one-use process-local observation
tokens. The injected offline fixture validator must rebuild the existing attestation
instruction. Test authority signatures prove fixture provenance, NOT RPC authenticity.
No signatures or raw wire bytes are stored or returned by the ledger. Public
transaction identifiers are explicitly test-only. Stored events cannot restore tokens.

Ordinary worker writes validate current job identity/revision/worker/generation and
original intent fence inside BEGIN IMMEDIATE. A separate trusted recovery facade
requires an explicit current job fence and operator identity, even after revocation.
It cannot create an attempt, invoke transport, release reservations or grant authority.
Keep this control capability away from workers and application requests.

Schema v5 adds strict attempt and append-only history tables. Versions 1-4 must
match their exact historical schemas before transactional migration; no repair.
DELETE journal, EXTRA synchronization, bounded busy waiting and one same-host
database remain required. History replay, immutable headers, revision CAS and
permanent uniqueness protect concurrency. SQLite cannot fence an external signer
or RPC. A malicious database owner remains outside the threat model.

Existing verifier tickets, exact-message policy, dual-signature simulation,
intent journal, mock handoff and RecoveryObservation brands remain separate.
The new model never hydrates existing recovery authorization tokens from SQL.
Unknown outcomes retain identity and evidence across restart. No automatic recovery
call signs, sends, recreates authorization or releases consumed identities.

## PLANNED OPERATIONAL (separately approved Phase 8C-2)

Required: approved Devnet program ID; approved verifier public key; approved separate
fee-payer public key; approved RPC/genesis configuration; isolated signer custody;
exact-message enforcement; durable signing-attempt records; external idempotency
and fencing; authenticated RPC status observations; confirmation/finalization policy;
authenticated resulting account-state reconciliation; expiry policy; crash-safe
recovery; operator approval/shutdown; root dependency-security remediation; and
end-to-end validation with nonmonetary DEMO tokens. Values are not invented here.

No deployment, credentials, operational signing, blockchain send, public execution
endpoint or automatic retry is implemented. Test evidence is not operational
authority. Existing root dependency exceptions and Rust maintenance notices remain.

## Review and storage limits

History is bounded at 32 mutations per attempt and exhausts closed; this is an
offline safety limit, not an operational retention policy. A separate reviewed
capacity policy is required before activation. Original v4 reconciliation flags
are never cleared. A finalized modeled result may resolve only the new ledger's
modeled uncertainty; worker revocation remains visible as reconciliation required.

The test-authority key is pinned when the audit record is created by a current
worker. It is an independent ephemeral fixture public key, not an approved RPC
identity. Trusted composition must segregate fixture observer and recovery-control
capabilities from client requests. No authentication from a mode string is claimed.
Test statements bind the canonical full job tuple digest, intent/preparation
identity, exact wire digest and transaction ID plus event, revision, heights,
slots, outcome and error. Both actual transaction signatures are verified and
the existing attestation builder reconstructs the message before tokens issue.

V1/v2/v3 fixtures remain byte-preserved; genuine v4 source fixtures pin the approved
main storage/schema SHA-256 after import reversal. Existing migrations now assert
v5, and unsupported-version tests use v6. DDL denial and owned SIGKILL tests prove
rollback. Crash coverage includes before/during/after create, submission intent,
invocation test double, acknowledgment, confirmed/finalized bookkeeping,
revocation and restart. Lost uncommitted evidence stays unknown. Independent test
observations may reconcile missing local invocation markers without fabricating
an invocation event. Ack is never execution success; program account-state
reconciliation remains unimplemented.

Lifecycle test files run serially to prevent unrelated suites from exhausting
bounded SQLite busy waits on loaded CI hosts. Tests still explicitly race actual
connections, worker threads and Node processes internally; no assertion, busy-timeout
limit or crash checkpoint is weakened. This follows one observed inherited allocator
storage_busy failure during concurrent local SBF compilation; it is reported rather
than erased from the validation history.

Recovery control may attach independently verified signed identity to an existing
created audit attempt after revocation. It still requires the explicit current job
fence, pinned test authority, complete canonical two-signature wire and message
validation. This fills a lost-bookkeeping window only. It never creates an attempt
or records an invocation, and cannot authorize signing/submission/retry. A later
status observation may establish a modeled result with invocationRecorded=false;
absence of the local marker is never proof that no effect occurred.

The allocator test also uses a deterministic barrier for each round of four
concurrent connections, retaining all 80 unique/contiguous-ID assertions and the
original 5000 ms worker busy timeout. File serialization alone did not eliminate
writer starvation under local compilation load; that second failed run is retained
in evidence. No production allocator retry or lock-policy change was introduced.

Review correction: if uncertainty was recorded before signed identity, only the
trusted control may attach independently verified identity. The phase remains
submission_uncertain, so invocation stays blocked. Ordinary worker identity writes
still require execution_record_created, enforced both at mutation and history replay.
Matching independent status evidence may then strengthen the modeled outcome.
