# Controlled ProofOfWork live Devnet rehearsal

Status: **NOT LIVE DEMO VERIFIED.** This is an execution runbook, not approval to
operate. Offline test success is insufficient. No deployment, funding, minting,
live transaction signing, attestation, settlement or broadcasting is authorized
by the pre-deployment stabilization task. No automatic PR merge is authorized.

## Fixed identities and current evidence

- Repository baseline: `4076e80c8f8eca7d0cdc8a21d705499c33ea9944`.
- Devnet RPC: `https://api.devnet.solana.com`; expected genesis:
  `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`.
- Program: `J2FkqDuuuHT14gxjVMhSryrX3Bs4Knct45NMLA79dGdZ`.
- Classic SPL DEMO mint: `GoXZxB3gErYYQ3UPKghpTwNPkcqWH1qoNbyU2VTD8Bty`;
  six decimals; no freeze authority.
- Approved artifact SHA-256:
  `1711e2dbbd2f0129f34be5d70e3e48867c42a849b2beea7d36cfbddaf2ed64e1`;
  396,328 bytes. The keyless stabilization build reproduced this pin.
- Read-only local environment evidence on 2026-11-21 observed the program absent,
  DEMO raw supply zero, and no DEMO token accounts for the checked mint authority
  or authenticated Phantom wallet. These are dated observations, not guarantees
  of future state or a complete global token-account inventory.
- The existing program key's public identity matches the configured program.
  The configured payer/mint authority is
  `249mMS9awYGUyMe22zabsSCo8cH4RDo3MeN3mAHFdy69`; observed balance
  0.9989232 Devnet SOL. The separately authenticated browser wallet
  `CK2c5adEEPBGWv56MgpRAaPuqRtYKDo3ZX12tfdxq886` had 5 Devnet SOL.
  Neither observation authorizes selecting a payer or financial role.
- At the observed rent schedule, exact-size ProgramData plus program metadata
  requires 2.0150582 SOL, before fees. A corresponding temporary buffer requires
  2.01418444 SOL rent. Recalculate allocation, CLI buffer funding/reclamation,
  current fees and a capped budget immediately before authorization. Verify active Devnet loader/SBPFv3 support without skipping feature checks; LiteSVM feature-profile success does not establish Devnet parity. The
  configured payer was insufficient even for permanent program storage.

Never generate, expose, copy into Git or request operational private keys or
seed phrases. Existing secret storage remains outside the repository.

## First-operation approval packet

Before any write, Harshita must explicitly approve the operation, exact public
payer, source/destination, amount or cap, program/artifact, Devnet genesis, timing
and stop conditions. Confirm who controls the existing program identity and
select/record the deployment and upgrade-authority policy. `TEAM_APPROVAL.md`
still records that configuration as outstanding. The application reviewer blocks
an unapproved mutable upgrade authority. Do not silently make the program
immutable: relinquishing upgrade authority is an irreversible policy decision.

If the existing payer is retained, its SOL provisioning is a prerequisite to
deployment, even though deployment verification is stage 1 below. Approve that
funding action separately; do not infer permission to airdrop, transfer or use
the browser wallet as payer. Read-only refresh and cost estimation may precede it.

The first controlled write can only be the specifically approved SOL provision
or deployment once its prerequisites are met. Its approval does not authorize
DEMO minting, workflow transactions or enabling application execution.

## Stage-by-stage execution and evidence

Every transaction stage requires fresh review, explicit approval for that action,
and confirmation before the next stage. For rows referring to browser execution,
the current implementation is preparation/review only; enabling the reviewed
specific action and transport is a prerequisite, not something this PR activates.

| Stage | Actor and authority | Existing code and required configuration | Expected state and frontend | Confirmation evidence and failure/recovery |
| --- | --- | --- | --- | --- |
| 1. Verified deployment | Approved deployer, existing matching program signer, approved payer and chosen upgrade policy | Existing keyless builder, approved artifact, Solana CLI; funded payer, explicit allocation/budget and recorded authority policy | Program executable under upgradeable loader; canonical ProgramData and approved authority. Frontend must remain blocked until deployment review passes | Record deployment signature, slot, genesis, loader/ProgramData, authority and exact deployed-byte comparison (only zero allocation padding allowed). On timeout inspect program/buffer and transaction status; do not generate a replacement identity or redeploy blindly |
| 2. Devnet SOL provisioning | Approved funding source/operator and exact recipient payer; any transfer needs source authority | Existing Solana tooling and fixed Devnet endpoint; approved recipient, amount/cap and source | Payer is a system account with current rent/fee budget. Browser balance is not evidence that another payer is funded | Retain funding signature if applicable and confirmed balance before/after. A faucet denial or ambiguous transfer stops the flow; inspect status before any further provision |
| 3. DEMO provisioning | Existing approved mint authority for minting; approved payer for ATA rent | Existing classic SPL/ATA tooling and client derivations; approve exact supply increment, recipient sponsor, student ATA and rent | Approved mint remains six decimals/no freeze; sponsor canonical ATA is usable and sufficiently funded; student canonical ATA exists; surplus destination validates Policy v2 | Preserve mint/ATA signatures, owners, authorities, raw supply and balances. On failure inspect each account and signature; never replace the mint, loosen validation or repeat ambiguous minting |
| 4. Real Phantom authentication | Existing sponsor/student wallet owner personally approves exact read-only message | Existing trusted HTTPS launcher, Phantom raw-message adapter and secure-cookie session; legitimate local TLS/DB | Authenticated wallet identity only, not global role, assignment or transaction authority. Logout removes private UI | Observe challenge, successful backend proof, Secure/HttpOnly/SameSite=Strict session, expiry and logout. Reject altered message/transaction requests; get a new challenge after rejection/expiry |
| 5. Internship creation | Sponsor signs and pays rent | `prepareWorkflow`, `createInternshipInstruction`, matching on-chain handler; coordinator-reserved increasing internship ID and sponsor consent | Canonical internship PDA contains immutable sponsor/ID. UI may say Confirmed only after reviewed wire and account checks | Retain exact signed-message digest, signature, confirmed slot, PDA/owner/discriminator/49-byte layout. On collision inspect existing account; reserve a new ID only after reconciliation, never overwrite |
| 6. Milestone creation | Same sponsor signs and pays rent; verifier must be independent | `createMilestoneInstruction`; approved positive raw reward, exact manifest hash, fixed mint, reserved milestone ID, future assignment/submission cutoffs and verifier identity | Canonical milestone is Created with immutable terms, zero student/submission/verification and expected vault bumps. UI distinguishes preparation from confirmation | Confirm all 276-byte decoded fields against the approved proposal and signature. Invalid terms or duplicate ID stops; reconcile without silently changing the agreed commitment |
| 7. Escrow funding | Recorded sponsor signs from its canonical DEMO ATA | `fundMilestoneInstruction`; Created state, before assign_by, usable canonical source, enough DEMO and rent | Funded; vault is classic SPL, correct authority PDA/mint, exact reward principal, no delegate/independent close authority. UI shows observed escrow only | Confirm source debit and vault credit equal reward in raw integers, status, owner/authority and signature. Insufficient balance/missing ATA requires separately approved provisioning; ambiguous send must be reconciled before any retry |
| 8. Student assignment | Sponsor signs; intended student consent supplied off-chain | `assignStudentInstruction`; Funded, before assign_by, nonzero on-curve student distinct from sponsor/verifier | Assigned with exact immutable student binding. UI must not infer assignment from imported JSON | Confirm signature and decoded student/status with unchanged terms/vault balance. Wrong wallet/deadline fails closed; do not bypass consent or reassign |
| 9. GitHub evidence submission | Assigned student signs and pays submission rent | Existing student form, commitment helpers and `submitMilestoneInstruction`; approved repo ID, contributor ID, exact commit/PR, manifest bytes and privately retained nonce; before submit_by | Submission PDA initialized once, exact evidence hash and student, milestone Submitted. Preparation alone is not submission | Save signature, slot, submission PDA/timestamp/commitment and milestone pointer. Keep source/nonce/GitHub credential out of public evidence. Duplicate/late submission fails; inspect committed state, never replace it |
| 10. Independent GitHub verification | Authorized contributor's GitHub authentication plus independent trusted verifier operator | Existing `/verify`, `GitHub`, `VerifierService`, manifest/source checks and `DockerRunner`; approved repository/commit, genuine credential supplied privately, exact pinned trusted image and available sandbox | Passing result is off-chain acceptance of agreed tests; milestone stays Submitted and no payout is established. Scoped browser dispatch requires separate contributor admission and an approved working sandbox | Retain sanitized acceptance result, commitment bindings and pinned runner/test identifiers. Wrong identity/commit, timeout, changed chain snapshot or failed tests yields no authorization. Do not run untrusted source outside the sandbox or infer approval from a fixture |
| 11. On-chain attestation | Recorded independent verifier signer plus approved fee payer/consent | Existing `AttestationAuthorizer`, exact-message policy/coordinator and unsigned attestation builder; separately reviewed operational signer/transport admission is missing | Verified with exact student/requirements/evidence and positive verification time; UI must still say reward not established | Retain signature, exact message, confirmed account snapshot, submitted/verified times and unchanged evidence. Never accept caller-supplied approval JSON. On uncertainty stop for signature/account reconciliation; no fresh authorization or send merely because a process restarted |
| 12. Settlement | Explicitly approved permissionless caller signs and pays completion rent; no sponsor/student/verifier signature required | Existing `prepareSettlementTransaction` and settlement handler; Verified state, sufficient vault, student canonical ATA and validated sponsor destination. Atomic seeded fallback is supported by client; approved action transport/UI is not active | Settled only with exact reward, sponsor surplus, vault closure and completion in the same transaction. UI must await transaction and account proof | Preserve signature/message, pre/post raw balances, completion and vault/rent checks. Failed CPI/init rolls back state and token movements (fees may remain). Unknown confirmation prohibits automatic retry; reobserve before a new reviewed authorization |
| 13. Student reward confirmation | Read-only observer, no signing authority | Existing token decoders/RPC reads and confirmed settlement transaction | Student canonical ATA gains exactly reward; Verified alone never means paid | Correlate exact mint/authority, pre/post raw amounts and confirmed settlement transfer. Unexpected credits/debits or missing transaction evidence stop the demo; investigate, never label a guessed balance as payment |
| 14. Completion confirmation | Read-only observer | Existing completion decoder and canonical derivation | Immutable 249-byte completion binds milestone/student/sponsor/verifier/submission, both hashes and timestamps | Retain decoded record, owner/discriminator/PDA/bump, slot and matching settlement signature. Missing or mismatched fields are failure, not an opportunity to fabricate a record |
| 15. Escrow postconditions | Read-only observer | Existing vault/token decoders and settlement constraints | Vault absent after closure; exact surplus credited to sponsor-owned destination and vault rent returned to recorded sponsor; mint supply conserved | Correlate vault closure, token transfers and lamport return with the settlement transaction; account for caller fees/completion rent separately. Inconsistent or stale reads remain Unknown and stop progression |
| 16. Real application status | Authenticated authorized sponsor/student; trusted coordinator for durable job ingestion | Existing HTTPS read routes, lifecycle queries and UI; genuine job ID/metadata, reviewed confirmation ingestion/status integration needed | UI must render real correlated chain evidence and provenance, survive refresh/logout, and never promote offline/unsigned data to payment | Browser-test the whole authorized journey, including error/empty/loading/expiry states. Compare API responses/screenshots to signatures and account snapshots. Missing job writer, confirmation ingestion or payout projection is a blocker; do not seed fake jobs or mislabel the demo ledger |

## Implementation gaps that remain before the full browser rehearsal

- The six-operation wallet review/controller exists, but production signing and
  broadcasting are hard-disabled. There is no authorized transport to enable by
  setting an environment flag. Any narrow activation requires a reviewed change
  and action-specific approval; never weaken the gates to make a demo pass.
- No public ID allocation/listing or durable operational transaction-ingestion writer exists.
  Admitted Submitted scopes can create real verifier job metadata in the existing
  v5 store. Job reads require the returned authorized job ID. Neither a job nor
  an empty database is a confirmed-transaction or payment ledger.
- Independent verification retains GitHub credential and sandbox boundaries.
  Wallet login cannot authorize `/verify`; it rejects browser Origin. The
  offline authorizer/policy composition is not operational custody or dispatch.
- Attestation/settlement live signing and correlated real payout/frontend status
  are not implemented as a complete browser journey. CLI-only success would
  not satisfy the requested browser rehearsal.
- Existing pending-work policy permits timely unverified submissions to remain
  locked indefinitely. No rejection/refund override, resubmission or verifier
  rotation is approved. Preserve refund eligibility and canonical refund ATA
  policy; do not invent a recovery transaction after submission.

## Evidence, stop conditions and final designation

Keep non-secret evidence outside Git: commit/build hash, genesis, exact public
roles/account addresses, approved action and budget, signature/message digest,
confirmed slot/status, decoded pre/post accounts and raw token/lamport deltas.
Never retain private keys, session cookies, GitHub tokens, seed phrases or private
evidence preimages in public reports. Existing offline wire logs are explicitly
local simulation evidence, not Devnet transaction signatures.

Stop on wrong genesis/program/mint/artifact/authority, changed review/message,
failed preflight, stale blockhash/RPC, missing approvals/accounts, failed
verification or uncertain confirmation. Diagnose and repair before proceeding.
Read-only observation may be repeated; an uncertain write may not be blindly
resent. Resume only after reconciliation establishes the actual committed state
and a human approves any necessary new action. Do not loosen financial policy.

Only call the project **LIVE DEMO VERIFIED** after all sixteen stages succeed
with genuine Devnet evidence and the complete browser journey is observed.
The stabilization PR neither grants those approvals nor claims that result.


## Browser integration follow-up

The application now provides session-authorized scope observations without a job
ID, explicit ID collision/absence checks and a private, commitment-checked
verifier-request handoff. These are transient reads/preparations. They do not
remove the durable ingestion, trusted verifier dispatch or live execution gates
above. Offline Chromium/real-HTTPS/LiteSVM integration is not a live rehearsal;
the sixteen-stage completion and separate action-approval requirements remain.

## Final integration readiness refresh — 24 November 2026

Implementation baseline: main `4076e80c8f8eca7d0cdc8a21d705499c33ea9944`.
Read-only Devnet observation at slot 525849231 (2026-11-24 16:24:57 UTC):
the existing program is absent; the existing classic SPL DEMO mint is initialized,
has six decimals, no freeze authority and raw supply zero. No deployment or token
provision was performed. Refresh these observations before approving a write.

The keyless build still produces the exact approved 396,328-byte artifact/hash
above. Current rent quotes in lamports: program account 833,120; ProgramData
2,014,225,080; temporary buffer 2,014,184,440; internship 899,160; milestone
2,052,320; token account 1,488,440; submission 1,224,280; completion 1,915,160.
Permanent deployment storage totals 2.0150582 SOL. If the chosen CLI deployment
path holds a separate buffer concurrently, the storage total is 4.02924264 SOL
before fees; confirm actual CLI allocation/reclamation and approve a capped budget.
Do not treat these rent floors as an approved payer balance or transaction budget.

For one fresh lifecycle, the sponsor's internship/milestone/vault rent is
4,439,920 lamports before fees; student submission rent is 1,224,280; settlement
caller completion rent is 1,915,160, plus up to 1,488,440 for a fresh fallback
destination when required. Each missing canonical ATA adds its separately
approved rent. Prefunding may reduce top-ups; fresh review determines exact costs.
The approved reward raw amount and DEMO supply increment have not been supplied.

The current candidate connects private contributor admission, genuine submitted
scope/job ingestion and existing verifier dispatch; it adds settlement review and
transaction-correlated reward/surplus/rent/completion evidence. It does not enable
live signing, sending or signer custody. The existing authorizer/policy remains
the sole attestation gate and must reverify afresh; a completed job is not authority.

Remaining prerequisites for the first controlled write:

1. Record the exact public deployment payer and chosen upgrade-authority policy.
   The reviewer still blocks an unapproved mutable authority. Do not silently
   choose immutability or use the previously authenticated browser wallet as payer.
2. Verify the existing program signer/public identity and active Devnet loader/
   SBPFv3 support against the approved artifact. Approve the exact allocation,
   fee/rent cap and buffer recovery plan. No replacement program identity is allowed.
3. Approve any needed SOL provision separately. Deployment approval does not
   authorize minting, account creation or workflow transactions.
4. The known configured payer candidate `249mMS9awYGUyMe22zabsSCo8cH4RDo3MeN3mAHFdy69`
   and previously authenticated Phantom wallet `CK2c5adEEPBGWv56MgpRAaPuqRtYKDo3ZX12tfdxq886`
   are NOT approved role assignments. Select the existing sponsor, student, independent verifier and separate
   attestation fee-payer public keys, confirm control/consent and verifier independence.
5. Approve the exact fictional internship terms, IDs, positive raw DEMO reward,
   deadlines, test repository numeric ID, contributor ID, manifest bytes and commit/PR.
6. Live verifier dispatch remains hard-disabled. Separately approve narrow activation
   and admit genuine contributor authentication outside Git via the scoped configuration
   in `LOCAL_APPLICATION.md`; approve/verify the pinned trusted runner image and
   working Docker sandbox. Docker daemon was unavailable during the local readiness
   inspection; test doubles are not evidence of a working operational sandbox.
7. Approve DEMO supply/source/recipient amounts and canonical sponsor/student ATAs;
   inspect mint authority, supply, accounts and balances before each provision.
8. Review and explicitly approve operational signer custody, distinct payer consent,
   durable first-submission/reconciliation/shutdown admission and narrow transport
   activation. Current hard-disabled boundaries are not bypassed by environment flags.

Then obtain separate action-specific consent in this order: deployment verification
(after any separately approved SOL provision), DEMO/ATA provisioning, read-only
Phantom login, sponsor creation/milestone/funding/assignment (four fresh reviews),
student submission, independent GitHub verification, verifier and separate payer
attestation approval, caller settlement approval, read-only balance/completion/vault
and browser status confirmation. Signing and broadcast each require deliberate
consent. Unknown confirmation stops progression and requires reconciliation; never
automatically resend, rebuild, reclaim or reauthorize an uncertain operation.

No live operation is authorized by this implementation task. The existing sixteen
stage evidence/stop-condition runbook remains binding. Public transaction signatures,
addresses and postconditions must be retained only after real authorized execution.
