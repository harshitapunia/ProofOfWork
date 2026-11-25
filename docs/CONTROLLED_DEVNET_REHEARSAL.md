# Controlled Devnet rehearsal

This connects the existing HTTPS frontend, wallet reviewer, finance client,
independent verifier, exact attestation policy and confirmation readers. It does
not authorize a live action or establish a completed Devnet demonstration.
No production Anchor code, IDL, account layouts, PDA seeds, financial policy or
finance-client code changes are needed.

## Denied by default

Without `APP_DEVNET_APPROVAL_FILE`, transaction signing/submission and production
verifier dispatch remain unavailable. No approval file is shipped, generated,
or populated with operational identities. The generic API envelope's read-only
permission flags are not executable capabilities; only the exact action gate
may issue a signing review. Authentication messages remain read-only and do not
authorize a transaction.

The optional file must be an absolute path outside Git to an owner-controlled
regular file with mode 0600 (no symlinks). It is reloaded before each action
boundary. Revocation, expiry, changed identities, changed scope or exceeded caps
refuse the action. Configuration is trusted operator input, never HTTP JSON.
Do not configure it until Harshita approves the specific action and identities.

Top-level fields are exactly `version` (`proofwork-controlled-devnet-v1`),
`programId`, `mint`, `genesis`, `artifactSha256`, `upgradeAuthority` and `actions`.
The first four identities must match the existing configured program, DEMO mint,
Devnet genesis and approved ELF pin in `tests/runtime/artifact-provenance.json`.
`upgradeAuthority` is the specifically approved public key, or null **only if
immutability was explicitly approved**. Matching deployed program bytes and
classic SPL mint configuration are still required.

Each action has exactly these fields:

| Field | Required binding |
| --- | --- |
| `id` | Unique operator approval ID, never reused |
| `operationKey` | Exact operation and internship/milestone PDA; no wildcard |
| `scopeDigest` | Canonical SHA-256 of the validated proposal terms/commitments, or submitted attestation snapshot and approved payer |
| `wallet` | Required sponsor/student/settlement caller, or separate attestation payer |
| `additionalSigner` | Null for ordinary actions; recorded independent verifier for attestation |
| `expiresAt` | Explicit UTC ISO expiry |
| `maxFeeLamports` | Approved maximum transaction fee, integer lamports |
| `maxRentLamports` | Approved maximum account-provisioning rent, integer lamports |

The ordinary review returns its operation key and scope digest for operator
comparison. Attestation scope is derived by `attestationScope` from an actual
Submitted state read and the explicitly approved separate payer. The operator
must inspect the public bindings and exact repository/manifest/commit before
approving it; the application never selects roles or approves evidence.
Blockhashes remain fresh and immutable within each review. Settlement's strictly
validated fallback destination can have a fresh seed; its sponsor ownership,
mint, reward, surplus entitlement and rent cap remain enforced.

## Browser sequence

1. Use the existing real same-origin HTTPS app and personally approve its exact
   read-only Phantom sign-in message. A session is not spending permission.
2. For each approved operation, review current deployment, accounts, raw amounts,
   fee and rent. Click **Approve transaction in wallet**, inspect Phantom, then
   separately click **Broadcast signed transaction**. No sign-and-send method,
   message-signing fallback, automatic retry or RPC endpoint override is used.
3. Check confirmation explicitly if the first response is uncertain. Rechecking
   reads only: it cannot refresh the message, sign or resend it. Refresh the
   existing milestone observation after confirmation to display genuine state.
4. For submitted work, the student validates the private handoff and requests
   independent verification. Configure the existing server-local contributor
   admission (`APP_GITHUB_USER_TOKEN_FILE` and exact milestone/repository/user/
   commit bindings), `VERIFIER_PUBLIC_KEY`, Devnet RPC and approved
   `TRUSTED_RUNNER_IMAGE`. The existing GitHub provenance checks and DockerRunner
   run afresh; a submitted commitment or a caller's "passed" JSON never attests.
5. Give the resulting public job ID to the designated verifier and **separate**
   attestation payer. Each uses their own authenticated Phantom session in the
   **Independent attestation approvals** section. Both sign the same immutable
   transaction message. The payer submits only after both signatures verify.
   The existing policy expires within 30 seconds; coordinate the two humans
   before dispatch, preferably in separate browser profiles. Expiry refuses the
   action; no stale result or mock receipt restores authority.
6. Check the attestation confirmation, refresh Verified state, then separately
   approve settlement from the sponsor or assigned student session for this
   rehearsal. The browser follows the existing participant-only scope policy.
   Only correlated transaction bytes, actual raw token
   deltas, completion bindings and closed vault/rent postconditions establish
   the exact reward receipt. Merely seeing Verified or a signature is insufficient.

## Persistence and recovery limits

The LifecycleStore migrates forward to SQLite v7. Back up the database with the
application stopped before starting the updated version. The migration preserves
all v5/v6 tables and rows. Older versions reject v7. A pre-migration backup is
not a safe way to roll back after the updated app records an attempt.

Each approval ID and transaction attempt remains in the ledger. A reservation
is recorded before Phantom opens. If a complete wallet signature is received,
the app records its signature separately from the send reservation. A reservation
with no recorded signature does not prove that a wallet never signed. The app
commits a send reservation before making its single Devnet RPC request. A
timeout, crash, malformed response, or expired session never releases that
reservation. Any attempted, submitted, unknown, confirmed, or failed send
must be reconciled read-only.

For a prior attempt whose ledger proves no app send was reserved, an operator
can approve a new attempt by assigning a fresh approval ID and adding
`reopensAttempt` with the exact previous attempt ID. Use **Recheck a previous
transaction** to retrieve the ID. Keep the same operation, scope, and signers.
Finalized Devnet must report a block height beyond the obsolete transaction's
last valid height and explicitly report its blockhash invalid. This check keeps
a previously handed-out signed message from landing after reopening. Fresh
chain state and the original program's state checks still have to allow the
operation. The new reservation atomically supersedes the prior one and retains
its row. Legacy v6 rows without a recorded message lease stay closed to
reopening, since their expiry cannot be established from the ledger.

For attestation recovery, add `reopensJob` as `<job UUID>:<generation>` to the
new approval entry and add `reopensAttempt` only if that job has an existing
transaction attempt. Read the generation and attempt from the authenticated job
view. If no transaction attempt exists, no signing permission was issued for
that job. A new generation invalidates old workers and runs GitHub verification,
the trusted runner, and attestation policy again. Both wallet signatures must be
obtained anew. A prior send reservation blocks job recovery even after expiry.

Message and partial-signature contexts remain process-local. Exact receipt
reconciliation after a restart can require manual read-only chain checks. No
private evidence preimages or credentials are stored in the transaction ledger.
The contract's existing unverified-work lockup and refund policy still apply.

## Evidence and deployment prerequisites

The new browser-to-LiteSVM case executes actual classic SPL and ProofOfWork SBF
instructions with real disposable in-memory signatures through the production
approval controls and real HTTPS/SQLite. Phantom providers, transport, GitHub
and runner outcomes are explicit test doubles. Deployment loader metadata,
approved mint authority and RPC context/lease are explicitly synthetic local
observations; financial account states and transaction balance postconditions
come from the VM. These tests are not Devnet execution, real Phantom transaction
compatibility evidence, a Docker sandbox run or proof of RPC authenticity.

Before the first live operation, approve the deployment payer/funding source,
upgrade authority and policy, total Devnet SOL spending cap, sponsor, student,
independent verifier, separate attestation payer and settlement caller. Approve
the genuine GitHub repository numeric ID/owner/name, contributor provenance,
exact compact manifest bytes/test hashes/pinned runner image and intended commit.
Approve DEMO raw mint amounts/recipients and canonical source/student ATAs.
Confirm Docker daemon availability and the approved image already present;
the existing runner uses `--pull=never` and does not silently install an image.

The first proposed write is deployment of the existing pinned ELF to the existing
program identity, after read-only payer/authority/balance, artifact, program-data
and fee/rent checks. Obtain separate action-specific approval; no deployment key
is generated here. If deployment tooling requires unavailable signing material
or identities, stop. Minting, funding, verification dispatch, attestation and
settlement require their own subsequent approvals. Preserve actual signatures,
public addresses and confirmed postconditions as non-secret evidence. Label the
project LIVE DEMO VERIFIED only after the entire authorized browser journey.
