//! Standalone host-only dependency foundation for ProofOfWork SBF runtime tests.
//!
//! No VM, keys, transactions, or test fixtures are constructed in this library.
//! The integration test targets use the separately supplied reviewed SBF artifact.
//! Execution constructs an internal ephemeral LiteSVM airdrop keypair; see the
//! README for explicit signature limitations and the remaining validation work.
