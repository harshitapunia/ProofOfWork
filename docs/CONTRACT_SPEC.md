# ProofOfWork smart-contract specification

**Approved for Devnet MVP implementation by Harshita and Palak.** The account layouts, seeds, signer sets, lifecycle rules, security requirements, and team ownership below form the implementation baseline. Scope is structured internships with predefined milestones for fictional sponsors and students on Solana Devnet, using non-monetary DEMO tokens. Listings, applications, sponsor vetting, identity links, repository URLs, source code, logs, and private evidence stay off-chain. The chain stores public keys and commitments. Public keys and digests are public data.

## MVP limits and deployment configuration

The MVP allows one submission per milestone and has no dispute-resolution mechanism. Verifier silence triggers no automatic payout. A timely submission without successful verification may remain locked indefinitely. Use only non-monetary DEMO tokens on Solana Devnet.

Implementation may proceed against the approved design. The Devnet program ID is recorded in the [shared foundation](SHARED_FOUNDATION.md). The classic SPL DEMO mint address and deployment and upgrade authority configuration are still required. This design approval does not authorize deployment or key generation.

## Accounts and serialization

Use Anchor accounts with the default 8-byte discriminator and Borsh serialization in the field order below. Sizes include the discriminator. There is no alignment padding. Timestamps are signed Unix seconds from the Clock sysvar. Token amounts are raw units. An unset public key is all zero bytes and an unset timestamp is zero. No state account is closed or reused in the MVP.

| Account and space | Ordered fields and types | Write authority and invariants |
|---|---|---|
| `Internship` (49 bytes) | `sponsor: Pubkey`, `internship_id: u64`, `bump: u8` | Sponsor signs creation. All fields immutable. Sponsor wallet is the organization authority for this internship. |
| `Milestone` (276 bytes) | `internship: Pubkey`, `sponsor: Pubkey`, `student: Pubkey`, `verifier: Pubkey`, `reward_mint: Pubkey`, `submission: Pubkey`, `requirements_hash: [u8; 32]`, `milestone_id: u64`, `reward_amount: u64`, `assign_by: i64`, `submit_by: i64`, `verified_at: i64`, `status: MilestoneStatus`, `bump: u8`, `vault_bump: u8`, `vault_authority_bump: u8` | Sponsor creates under its internship. Immutable terms are parent, sponsor, verifier, mint, requirements hash, ID, reward, deadlines, and bumps. Sponsor sets student once, student sets submission once, verifier sets verification time once. Only allowed instructions change status. |
| `Submission` (113 bytes) | `milestone: Pubkey`, `student: Pubkey`, `evidence_hash: [u8; 32]`, `submitted_at: i64`, `bump: u8` | Assigned student signs creation. All fields immutable. One timely submission per milestone. The milestone stores this exact PDA. |
| `CompletionRecord` (249 bytes) | `milestone: Pubkey`, `student: Pubkey`, `sponsor: Pubkey`, `verifier: Pubkey`, `submission: Pubkey`, `requirements_hash: [u8; 32]`, `evidence_hash: [u8; 32]`, `verified_at: i64`, `settled_at: i64`, `bump: u8` | Initialized only by successful settlement. All fields immutable and copied from validated state. A record exists only if payment and vault closure succeeded in the same transaction. |

`MilestoneStatus` is a fieldless Borsh enum in this order, with one-byte discriminants 0 through 6: `Created`, `Funded`, `Assigned`, `Submitted`, `Verified`, `Settled`, `Refunded`. The `Verified` state and `verified_at`, together with the immutable verifier, requirements, student, and linked immutable submission, fully identify the accepted attestation. A separate Verification account would duplicate these bindings.

## Addresses and escrow

Derive each address under the configured ProofOfWork program ID. Labels are literal ASCII bytes. Public keys use their raw 32-byte representation and numeric IDs use exactly 8 bytes little-endian.

| Address | Seeds before bump |
|---|---|
| Internship | `[b"internship", sponsor, internship_id.to_le_bytes()]` |
| Milestone | `[b"milestone", internship, milestone_id.to_le_bytes()]` |
| Vault token account | `[b"vault", milestone]` |
| Vault transfer authority | `[b"vault_authority", milestone]` |
| Submission | `[b"submission", milestone]` |
| Completion record | `[b"completion", milestone]` |

The client allocates IDs from monotonically increasing counters off-chain, scoped to the sponsor for internships and the internship for milestones. Persist reservations and never intentionally reuse an ID. If two creations race for the same ID, `init` rejects the second. Refresh and retry with a new ID. Different scopes can safely use the same integer. Use canonical bumps on creation, persist them in the indicated fields, and validate with `seeds` and stored `bump` on subsequent calls. At milestone creation, derive both future vault bumps. The authority PDA has no allocated state account. Only the program signs CPIs using the validated authority seeds. [Solana PDA reference](https://solana.com/docs/core/pda)

Funding creates a dedicated token account with `init`, paid for by the sponsor. The **classic SPL Token Program owns the account**. The vault's internal token owner is the milestone vault authority PDA. The vault permits no delegate or independent close authority. Use a team-approved Devnet DEMO mint once its address is supplied. Every mint account must match the recorded mint and approved mint, be owned by classic SPL Token, have no freeze authority, and be non-native. All movements use checked transfers and the mint's decimals. Token-2022 is outside this MVP.

Funding deposits exactly the positive recorded reward from the sponsor's existing canonical ATA. Treat reward principal and unsolicited surplus separately. Require the vault balance at disposal to be at least the reward. Compute surplus with checked subtraction. On settlement, pay exactly the reward to the assigned student's canonical classic SPL ATA and send any surplus to the sponsor's canonical classic SPL ATA. On eligible refund, return the reward and any surplus to the sponsor ATA. Reject vault aliasing with any source or destination. Validate ATA address, internal owner, mint, and token program. ATAs must exist before the instruction and can be created separately by a willing payer. A permissionless settlement caller may supply both canonical ATAs without sponsor or student signatures.

Only settlement or eligible refund may close the vault. Transfer all tokens first, reload and require zero, then close via classic SPL Token, returning rent lamports to the recorded sponsor account. All CPIs, record creation, and status updates succeed or roll back together. State accounts stay allocated to prevent reinitialization. No token or rent payout goes to the transaction caller by virtue of calling. [Solana token account closure](https://solana.com/docs/tokens/basics/close-account)

## Instruction interfaces

The signatures show the approved Anchor context and serialized arguments. Each returns `Result<()>`. Listed accounts are in approved IDL order. Accounts are read-only unless marked **W**. Signers are explicit. A payer is writable and must be able to pay rent. `system_program` is the typed System Program, and `token_program` is the typed classic SPL Token Program. Read current time via `Clock::get()`. Programs and PDAs always use validated addresses.

For all milestone instructions that accept both parent and child, validate both PDA derivations, `milestone.internship == internship.key()`, and `milestone.sponsor == internship.sponsor`. Sponsor-authorized calls also constrain the sponsor signer to that stored key. A supplied submission must be its canonical PDA, equal `milestone.submission`, and bind the same milestone and student. Account initializations use the spaces above.

| Signature | Accounts and constraints | Preconditions, effects, and expected failures |
|---|---|---|
| `create_internship(ctx: Context<CreateInternship>, internship_id: u64)` | Sponsor **W**, signer and payer, internship **W** initialized with sponsor and ID seeds, system program. | Write immutable sponsor, ID, and bump. No token movement. Reject existing PDA or missing signer. |
| `create_milestone(ctx: Context<CreateMilestone>, milestone_id: u64, reward_amount: u64, requirements_hash: [u8; 32], assign_by: i64, submit_by: i64, verifier: Pubkey)` | Sponsor **W**, signer and payer, internship, milestone **W** initialized from parent and ID, reward mint, token program, system program. | Require positive reward, nonzero hash, nonzero on-curve verifier distinct from sponsor, approved mint, and `0 < now < assign_by < submit_by`. Store terms and canonical bumps, initialize `Created` and zero unset fields. Reject bad terms, wrong sponsor or mint, or existing PDA. No token movement. |
| `fund_milestone(ctx: Context<FundMilestone>)` | Sponsor **W**, signer and vault payer, internship, milestone **W**, reward mint, sponsor ATA **W**, vault **W** initialized at vault PDA, vault authority PDA, token program, system program. | Require `Created` and `now < assign_by`. Transfer exactly reward and verify funded vault balance equals reward after reloading. Move to `Funded` atomically. Reject late or repeated funding, invalid vault/authority, wrong source/mint/program, or insufficient funds. |
| `assign_student(ctx: Context<AssignStudent>, student: Pubkey)` | Sponsor signer, internship, milestone **W**. | Require `Funded` and `now < assign_by`. Require nonzero on-curve student distinct from sponsor and verifier. Record student and move to `Assigned`. Application and consent are handled off-chain. Reject reassignment, wrong signer, and invalid or late assignment. No token movement. |
| `submit_milestone(ctx: Context<SubmitMilestone>, evidence_hash: [u8; 32])` | Student **W**, signer and submission payer constrained to assigned key, internship, milestone **W**, submission **W** initialized at canonical PDA, system program. | Require `Assigned`, `now < submit_by`, nonzero evidence hash, and unset submission pointer. Store immutable submission with clock time, link it and move to `Submitted`. Reject wrong signer, late or duplicate submission, bad hash or PDA. No token movement. |
| `attest_milestone(ctx: Context<AttestMilestone>, expected_student: Pubkey, expected_requirements_hash: [u8; 32], expected_evidence_hash: [u8; 32])` | Verifier signer constrained to milestone verifier, internship, milestone **W**, linked submission. | Require `Submitted`, a timely submission with positive timestamp, now >= submitted_at, unset verification time, and exact equality of all three expected values with stored state. Record current time and move to `Verified`. Reject wrong verifier, mismatched scope/commitment, replay, or invalid state. No token movement. |
| `settle_milestone(ctx: Context<SettleMilestone>)` | Caller **W**, signer and completion payer, internship, milestone **W**, linked submission, completion record **W** initialized at canonical PDA, reward mint, vault **W**, vault authority PDA, student ATA **W**, sponsor ATA **W**, recorded sponsor rent destination **W**, token program, system program. | Require `Verified`, validated submission and student, timely submission and `verified_at >= submitted_at > 0`. Transfer principal and surplus as above, close the vault, initialize completion from checked state, move to `Settled`. Reject insufficient backing, missing or invalid bindings, wrong destination, unfunded or terminal state, existing completion, or CPI failure. Anyone may pay and trigger settlement. Sponsor, verifier, and student have no required signature. |
| `refund_unclaimed_milestone(ctx: Context<RefundUnclaimedMilestone>)` | Sponsor **W**, signer and rent destination, internship, milestone **W**, reward mint, vault **W**, vault authority PDA, sponsor ATA **W**, token program. | Require `Funded` or `Assigned`, `now >= submit_by`, unset submission and verification fields, and sufficient backing. Return principal and surplus to sponsor ATA, close vault, and move to `Refunded`. Reject unauthorized or early refund, any timely submitted or verified milestone, bad vault or destination, and any terminal state. No completion record. |

## Lifecycle and failure cases

The table enumerates every permitted status change. Every other source and destination pair is forbidden, including same-state repeats and any transition out of `Settled` or `Refunded`. Failed calls leave state and balances intact. There is no expiry state or background execution.

| Transition | Trigger and clock boundary |
|---|---|
| Absent → Created | Sponsor creates, before assignment cutoff. |
| Created → Funded | Sponsor deposits full reward before `assign_by`. |
| Funded → Assigned | Sponsor assigns one student before `assign_by`. |
| Assigned → Submitted | Assigned student submits once strictly before `submit_by`. |
| Submitted → Verified | Designated verifier attests success for the exact timely submission. Verification has no deadline. |
| Verified → Settled | Any payer triggers settlement. Settlement has no deadline. |
| Funded or Assigned → Refunded | Sponsor requests refund at or after `submit_by` and there is no submission. |

If the student never submits, the sponsor can reclaim funds at the cutoff. At the exact cutoff the submission fails and refund can become eligible. A late submission never changes state. An unfunded milestone that expires remains `Created` with no escrow. Invalid work or verifier silence leaves timely submissions in `Submitted` with funds locked. The MVP has no rejection, resubmission, override, dispute, or recovery instruction. Resolving those cases requires a later approved design. Sponsor silence never proves completion. It cannot block settlement once verification succeeds. Duplicate submission, repeat attestation, a sponsor refund after submission, and second settlement all fail. Transaction write locks and revalidation serialize competing changes to the same milestone and vault.

## Automated verification and trust

Example: an assigned student implements a JavaScript function in a registered GitHub repository. A versioned requirements manifest identifies the registered repository by immutable numeric ID, expected function interface, exact pinned tests and runner image digest, acceptance rules, and resource limits. The sponsor commits before funding. For the MVP encoding, `requirements_hash = SHA256(ASCII("proofwork:requirements:v1") || exact_manifest_bytes)`. Distribute the exact manifest bytes off-chain and verify the digest before parsing. The verifier implementation must define the versioned manifest schema and serialization policy consistently with this commitment.

For a v1 SHA-1 Git repository, define `evidence_hash = SHA256(ASCII("proofwork:submission:v1") || program_id[32] || milestone[32] || student[32] || requirements_hash[32] || repo_id_u64_le || contributor_id_u64_le || commit_sha_raw[20] || nonce[32])`. All fields after the prefix are fixed-width. The student generates the nonce off-chain and provides the evidence preimage privately to the verifier. The service authenticates the linked contributor through GitHub, checks the authenticated immutable user and repository IDs and authorized provenance of the exact submitted commit. Git author text alone does not authenticate a contributor. Recompute the commitment and compare it with the linked on-chain submission. Run the pinned tests against the exact checkout in an isolated, resource-limited worker with no signing credentials or ambient network access. The signing service attests only after receiving an authenticated successful result for that exact job.

The verifier submits an ordinary signed instruction with the milestone and submission accounts and the three expected binding values. Solana's transaction signature covers the accounts and instruction data. The program checks the verifier signer, links, status, digests, and student against persisted state. There is no detached reusable attestation. Cross-milestone replay fails because addresses and evidence preimages are milestone-specific. A repeat attestation fails the state gate. The verifier cannot choose a payout recipient. The chain trusts the designated verifier to report accurately. A compromised or dishonest verifier can misattest for its assigned milestones. Sponsor selection does not by itself prove verifier independence. The chain checks authority and bindings, while GitHub execution and test quality remain off-chain.

A future eligibility check may validate the completion PDA, program ownership and discriminator, student, accepted verifier or sponsor policy, and optionally the linked settled milestone. It establishes verified completion of agreed requirements. It provides no claim of universal skill, genuine employment history, or a transferable credential. The MVP includes no NFT or token extension.

## Security acceptance tests

Prefer typed `Account<Internship>`, `Account<Milestone>`, `Account<Submission>`, and `Account<CompletionRecord>` for program-owned state. Use classic `Account<Mint>`, `Account<TokenAccount>`, and `Program<Token>` for SPL ownership and program identity. Use `Signer`, `seeds` and `bump`, `has_one` or address constraints, and token and ATA constraints. Use a seed-checked unchecked account only for the unallocated authority PDA and an address-checked writable account for the rent destination. Avoid duplicating ownership checks already enforced by the types. [Anchor account constraints](https://www.anchor-lang.com/docs/references/account-constraints)

| Negative test or invariant | Enforcement |
|---|---|
| Incorrect PDA or cross-milestone account | Canonical seeds and bumps, typed ownership, parent and stored-key constraints. Mutating a neighboring milestone's vault must fail with both balances unchanged. |
| Unauthorized sponsor, student, verifier | Role-specific `Signer` and stored-key constraints. Check each role with valid unrelated signers. |
| Wrong mint, token program, vault authority or delegate | Typed classic SPL accounts/program, approved and stored mint constraints, vault PDA, internal authority, delegate and close-authority validation. Reject Token-2022 and non-approved mints. |
| Wrong payout or refund ATA, rent destination, or account alias | Canonical ATA derivation and internal mint/owner checks, sponsor address check, explicit source/vault/destination inequality where funds move. Check that an unrelated caller can settle but cannot redirect funds. |
| Unfunded or duplicate settlement, refund conflict, unauthorized refund | Exact state gates, positive principal and sufficient backing, time and missing-submission checks, completion `init`, immutable terminal state. Test both settlement/refund call orders and repeated calls. |
| Replayed attestation or incorrect submission commitment | Canonical linked submission, signer binding, equality checks on supplied student and digests, timely immutable submission, and one-way status transition. |
| Arithmetic overflow, shortfall, or surprise surplus | Checked arithmetic, exact funding delta, checked SPL CPI amounts, reloaded balances. Test max amounts, a shortfall, unsolicited tokens, close failure rollback, and token supply conservation across funding, refund, and settlement. |
| Invalid transition or deadline boundary | Enum state preconditions and clock comparisons. Table-driven tests for each disallowed instruction/state pair and timestamps one second before and at each cutoff. |

Shared domain errors include `InvalidState`, `DeadlinePassed`, `RefundTooEarly`, `InvalidTerms`, `InvalidRole`, `BindingMismatch`, `InvalidMint`, `InvalidVault`, `InvalidDestination`, `InsufficientEscrow`, and `ArithmeticOverflow`. Anchor constraints or token CPIs may return their own failures. Record numeric error ordering in the shared foundation before parallel implementation.

## Approved module ownership

- Palak owns `instructions/finance/` for `create_internship`, `create_milestone`, `fund_milestone`, `settle_milestone`, and `refund_unclaimed_milestone`. Palak also owns escrow and token-transfer helpers, completion records, financial security tests, and the finance TypeScript client.
- Harshita owns `instructions/verification/` for `assign_student`, `submit_milestone`, and `attest_milestone`. Harshita also owns the GitHub automated verification service, verification authorization and replay protection, verification security tests, the student and verification TypeScript client, and end-to-end integration coordination.
- Ganga owns the complete frontend, including the organization and student dashboards, internship opportunities, Proof Vault, and frontend UI testing and integration. Ganga consumes the reviewed IDL and TypeScript interfaces.
- Joint review is required for `lib.rs` entry points and public instruction contexts, `state/` layouts and enum, `seeds.rs`, `errors.rs`, and the interfaces for `escrow.rs` helpers. Assign a single editor for each shared change. Palak implements approved vault constraints and helpers, including checked transfers and closure used by settlement and refunds. Keep finance and verification handler files separate.

See the [approval record and implementation sequence](TEAM_APPROVAL.md).

## Approved Settlement Destination Policy v2

Harshita's approval is confirmed. Harshita has communicated that Palak
approved Settlement Destination Policy v2, its associated shared smart-contract
changes, the settlement/refund integration approach, and the related
ABI-preserving implementation changes. Palak's approval is recorded through
Harshita's communication, not as a direct statement or GitHub approval from
Palak. No approval timestamp is attributed to Palak.

This amendment supersedes the baseline's canonical sponsor ATA requirement
for settlement only. Funding and refunds retain their canonical ATA policies.
Team policy approval does not waive required GitHub reviews, status checks or
branch-protection rules.

For settlement only, the existing mandatory `sponsor_ata` account slot may hold
any initialized, usable classic SPL token account whose internal token authority
is the milestone's recorded sponsor. The account must use the approved reward
mint, be owned by classic SPL Token, be neither frozen nor native, and not alias
the student destination or vault. The canonical sponsor ATA remains preferred.
The authority check is retained; canonical address derivation alone is never
accepted as proof of current token authority.

A caller may create and initialize a fresh sponsor-owned destination before
settlement in the same transaction without gaining authority over its tokens.
The program correction does not itself provision destinations. The separate
client candidate provisions them atomically. Local evidence records 98 native,
112 client, 23 core runtime and 26 client/runtime tests passing against the
corrected artifact. Native rollback models alone do not prove transaction
atomicity; the SBF suites exercise actual token CPIs and rollback. Bridge
settlement transactions enable signature verification. These results do not
establish Devnet runtime parity or authorize deployment.

The `sponsor_ata` name, mandatory slot, account order, signer/writable flags,
serialized arguments, discriminator, PDA derivations, stored layouts, exact
student reward, sponsor surplus entitlement, vault closure/rent destination,
completion provenance and replay protections remain unchanged. Funding and
refunds retain their canonical sponsor ATA requirements. Team policy approval
does not authorize publication, deployment, key generation or external blockchain
transactions.
