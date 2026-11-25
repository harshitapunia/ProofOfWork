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

The existing LifecycleStore migrates additively from v5 to v6, retaining all
prior tables and rows. Back up the operator's database before first opening it
with the updated app; older app versions reject the newer schema. Tests use
isolated databases. No existing operator database is modified by validation.

A durable operation/approval reservation is recorded before a Phantom request,
and a send reservation is committed before the single Devnet RPC invocation
(`skipPreflight:false`, confirmed preflight, `maxRetries:0`). The same operation
cannot be signed or sent again by obtaining a new review, racing requests or
restarting. Errors and timeouts remain Unknown, never successful by inference.
Local records are bookkeeping, never restored signer/policy authorization.

This conservative MVP does **not** automatically release a rejected, expired,
crashed or uncertain attempt. Stop for operator reconciliation. No force reset,
database deletion, re-signing or resending is a recovery procedure. Message and
partial-signature contexts remain process-local; a restart retains the fence
but requires manual read-only chain reconciliation. If the browser loses its session, sign in again with the same wallet, refresh
the scope and select the previous operation to recheck the recorded transaction.
Exact receipt checks require the original server review context. No private evidence preimages or credentials are
persisted in the new table. On-chain unverified-work lockup remains the approved
contract limitation; there is no new refund/recovery policy.

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
