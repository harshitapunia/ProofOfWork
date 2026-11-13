# ProofOfWork finance client

Existing creation/funding exports remain unchanged. Settlement Destination Policy
v2 is approved and implemented by merged PR #24; this unsigned client is a separate
integration candidate. This package never receives keys, signs, sends, deploys or
creates wallets.

## Settlement API

- settleMilestoneInstruction serializes the no-argument settlement ABI. Inputs are
  caller, sponsor, assigned student, internshipId/milestoneId (bigint), and optional
  sponsorDestination. Without an explicit destination it uses the sponsor ATA.
  This pure serializer cannot authenticate account state; the program validates it.
- deriveSubmission, deriveCompletion and deriveStudentAta expose canonical addresses.
- deriveSponsorFallbackDestination derives a System seeded address from the caller,
  an explicit public ASCII seed (1-32 letters/digits/underscore/hyphen), and classic
  Token Program. It is not a ProofOfWork PDA or newly generated signing identity.
- prepareSettlementTransaction(input, rpc) checks the existing approved Devnet RPC
  endpoint/genesis, reads account state in one batch, and returns:
  transaction, sponsorDestination and destinationKind. The caller is the unsigned
  transaction's fee payer and only required signing identity.

The reader validates program ownership, sizes/discriminators, canonical PDAs and
stored bumps, parent/sponsor/student/submission bindings, Verified status and
attestation/submission timing, mint and token custody, sufficient reward backing,
and the canonical student destination. A completion collision fails closed.

## Destination selection and provisioning

A valid canonical sponsor ATA is preferred, even if an alternative is supplied.
If unusable, an explicit initialized sponsor-owned classic token destination can
be supplied. Otherwise fallbackSeed is required and the derived address is read.

- Absent address: CreateAccountWithSeed, InitializeAccount3, settlement.
- Prefunded zero-data, non-executable System-owned address: optional rent top-up,
  AllocateWithSeed (which allocates and assigns), InitializeAccount3, settlement.
- Initialized token accounts, foreign-owned/executable accounts or existing data
  at the fallback address are rejected. Choose a new seed; never overwrite them.

InitializeAccount3 assigns token authority to the recorded sponsor, never caller.
Every instruction must remain in the returned transaction. Splitting provisioning
and initialization permits account takeover and splitting settlement loses the
intended transaction atomicity. The destination is exposed for surplus discovery.
No sponsor signature is required for provisioning.

Seeds are caller-scoped public reservations. Reserve them in application storage.
Concurrent preparations with the same seed are deterministic, not a distributed
lease; if another transaction initializes it, the stale plan fails atomically.
RPC observations can become stale, including new prefunding after preparation.
Refresh and re-prepare after failure; never sign an altered replacement blindly.

The transaction deliberately has no recentBlockhash or signature. The application
must supply a fresh verified Devnet blockhash and pass the complete transaction to
the existing caller wallet. Do not substitute the fee payer or add unreviewed
instructions. This client is not a security boundary; on-chain checks still decide.

## Validation limits

Unit tests use mocked read-only RPC and compiled Rust ABI fixtures. Separate
local evidence records 26 client/runtime tests, including exact TypeScript wire
execution with signature verification, changed ATA authority, absent and prefunded
destinations, rollback and replay. Two cases are preflight-only rejections.
The portable harness lives in tests/runtime after that separate PR integrates.
These local VM tests do not establish Devnet parity or deployment readiness.

Run check, test, test:rust-abi and test:settlement-abi with pinned dependencies.
The cross-language exporter uses a standalone temporary workspace and compares
fixtures unless explicitly invoked with --write-fixture.
