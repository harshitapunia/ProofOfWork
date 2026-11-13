//! Wire-level helpers for the reviewed SBF artifact; no native ProofOfWork handler is linked.
//!
//! Calling the VM helper creates LiteSVM's internal ephemeral airdrop keypair.
//! Execute only as an authorized local test; no persistent wallet is created.

pub mod finance;

use {
    agave_feature_set::{
        create_account_allow_prefund, enable_sbpf_v3_deployment_and_execution,
        replace_spl_token_with_p_token,
    },
    litesvm::LiteSVM,
    sha2::{Digest, Sha256},
    solana_address::{address, Address},
    solana_instruction::{AccountMeta, Instruction},
    solana_sdk_ids::system_program,
    std::{env, fs, path::PathBuf},
};

/// Approved identity from the program's declare_id! and the compiled combined IDL.
pub const PROGRAM_ID: Address = address!("J2FkqDuuuHT14gxjVMhSryrX3Bs4Knct45NMLA79dGdZ");

/// Reviewed Policy v2 build; see tests/runtime/artifact-provenance.json.
const PROGRAM_ELF_SHA256: &str = "1711e2dbbd2f0129f34be5d70e3e48867c42a849b2beea7d36cfbddaf2ed64e1";

/// Compiled IDL discriminator for global:create_internship, followed by its u64 argument.
const CREATE_INTERNSHIP_DISCRIMINATOR: [u8; 8] = [27, 117, 48, 0, 70, 215, 145, 229];

/// Compiled IDL discriminator for the initialized Internship account.
pub const INTERNSHIP_DISCRIMINATOR: [u8; 8] = [54, 95, 247, 2, 71, 139, 125, 206];

/// Approved allocation: discriminator (8), sponsor (32), ID (8), canonical bump (1).
pub const INTERNSHIP_SPACE: usize = 49;

/// Reads and hashes the existing ELF before any VM construction; never rebuilds or writes it.
pub fn verified_program_elf() -> Vec<u8> {
    let path = PathBuf::from(env::var_os("PROOFWORK_SBF_PATH").expect(
        "set PROOFWORK_SBF_PATH to the reviewed combined ProofOfWork SBF ELF; see tests/runtime/README.md",
    ));
    let elf = fs::read(&path)
        .unwrap_or_else(|error| panic!("cannot read reviewed SBF ELF {}: {error}", path.display()));
    assert_eq!(
        format!("{:x}", Sha256::digest(&elf)),
        PROGRAM_ELF_SHA256,
        "refuse to load an artifact with different provenance"
    );
    assert_eq!(
        &elf[..7],
        b"\x7fELF\x02\x01\x01",
        "expected ELF64 little endian"
    );
    elf
}

/// Builds the pinned local feature profile with classic SPL and placeholder-signature support.
///
/// Starts with LiteSVM 0.18.2's bundled mainnet feature snapshot, then explicitly
/// disables p-token substitution before loading programs. This is a local Agave
/// 4.3 profile, not a claim of matching current Devnet or the intended 4.1 runtime.
/// Financial fixtures disable signature verification; blockhash, rent, privilege,
/// ELF and CPI checks remain enabled. LiteSVM gates duplicate-history rejection
/// on sigverify; a separate internal-airdrop test enables it for signed replay.
/// The constructor generates an internal keypair; signed-history coverage uses local airdrop.
pub fn svm_with_placeholder_signatures() -> LiteSVM {
    let mut features = LiteSVM::mainnet_feature_set();
    assert!(features.is_active(&enable_sbpf_v3_deployment_and_execution::ID));
    assert!(features.is_active(&create_account_allow_prefund::ID));
    features.deactivate(&replace_spl_token_with_p_token::ID);
    assert!(!features.is_active(&replace_spl_token_with_p_token::ID));

    LiteSVM::default()
        .with_feature_set(features)
        .with_builtins()
        .with_sysvars()
        .with_feature_accounts()
        .with_default_programs()
        .with_sigverify(false)
        .with_blockhash_check(true)
}

/// Derives the approved PDA and encodes its three-account, single-u64 Anchor instruction.
pub fn create_internship_instruction(
    sponsor: Address,
    internship_id: u64,
) -> (Instruction, Address, u8) {
    let id_bytes = internship_id.to_le_bytes();
    let (internship, bump) =
        Address::find_program_address(&[b"internship", sponsor.as_ref(), &id_bytes], &PROGRAM_ID);
    let mut data = CREATE_INTERNSHIP_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&id_bytes);
    let instruction = Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(sponsor, true),
            AccountMeta::new(internship, false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        data,
    };
    (instruction, internship, bump)
}
