//! First real SBF transaction smoke test, implemented and compiled without execution approval.
//!
//! Running this test constructs LiteSVM and generates its internal ephemeral keypair.
//! Zero placeholder signatures are accepted only because signature verification is
//! explicitly disabled. This is not cryptographic signer authentication coverage.
//! The transaction still carries the approved signer/writable privileges and executes
//! through the VM; there is no native handler, mocked processor or snapshot restore.

mod support;

use {
    solana_account::Account,
    solana_address::Address,
    solana_message::Message,
    solana_sdk_ids::system_program,
    solana_transaction::Transaction,
    support::{
        create_internship_instruction, svm_with_placeholder_signatures, verified_program_elf,
        INTERNSHIP_DISCRIMINATOR, INTERNSHIP_SPACE, PROGRAM_ID,
    },
};

/// Executes create_internship from the reviewed ELF and checks exact initialized state and rent.
/// Execution needs separate approval because LiteSVM internally creates an airdrop keypair.
#[test]
fn create_internship_executes_reviewed_sbf_and_initializes_canonical_pda() {
    // Verify the artifact before any constructor that generates an internal keypair.
    let elf = verified_program_elf();
    let mut svm = svm_with_placeholder_signatures();
    assert!(
        !svm.get_sigverify(),
        "this fixture uses placeholder signatures"
    );
    svm.add_program(PROGRAM_ID, &elf)
        .expect("reviewed ProofOfWork ELF must pass the real SBF loader");

    // Public-only fixtures reuse the deterministic values in seeds.rs tests.
    // No external wallet, signer, secret material or airdrop helper is used.
    let sponsor = Address::new_from_array([11; 32]);
    let internship_id = 0x0807_0605_0403_0201u64;
    let sponsor_lamports = 1_000_000_000u64;
    svm.set_account(
        sponsor,
        Account {
            lamports: sponsor_lamports,
            data: Vec::new(),
            owner: system_program::ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .expect("fund public sponsor fixture directly in the isolated VM");

    let (instruction, internship, bump) = create_internship_instruction(sponsor, internship_id);
    assert!(
        svm.get_account(&internship).is_none(),
        "PDA must start absent"
    );
    let expected_rent = svm.minimum_balance_for_rent_exemption(INTERNSHIP_SPACE);

    let message =
        Message::new_with_blockhash(&[instruction], Some(&sponsor), &svm.latest_blockhash());
    // Sponsor and PDA are writable; only sponsor signs. The System Program and
    // ProofOfWork program ID are read-only. Do not weaken message privileges.
    assert_eq!(message.account_keys.len(), 4);
    assert_eq!(message.account_keys[0], sponsor);
    assert_eq!(message.account_keys[1], internship);
    assert_eq!(message.header.num_required_signatures, 1);
    assert_eq!(message.header.num_readonly_signed_accounts, 0);
    assert_eq!(message.header.num_readonly_unsigned_accounts, 2);

    // This API creates one zero signature per required signer without generating keys.
    // It is suitable only for this explicitly documented sigverify-disabled smoke test.
    let transaction = Transaction::new_unsigned(message);
    assert_eq!(transaction.signatures.len(), 1);
    let execution = svm.send_transaction(transaction).unwrap_or_else(|failure| {
        panic!(
            "create_internship failed: {:?}; consumed {} CUs\n{}",
            failure.err,
            failure.meta.compute_units_consumed,
            failure.meta.pretty_logs(),
        )
    });
    eprintln!(
        "create_internship consumed {} CUs; fee {} lamports\n{}",
        execution.compute_units_consumed,
        execution.fee,
        execution.pretty_logs(),
    );
    assert!(execution.compute_units_consumed > 0);
    for expected in [
        format!("Program {PROGRAM_ID} invoke [1]"),
        "Program log: Instruction: CreateInternship".to_owned(),
        format!("Program {} invoke [2]", system_program::ID),
        format!("Program {PROGRAM_ID} success"),
    ] {
        assert!(
            execution.logs.contains(&expected),
            "missing execution log: {expected}"
        );
    }

    let account = svm.get_account(&internship).expect("PDA must be committed");
    assert_eq!(account.owner, PROGRAM_ID);
    assert!(!account.executable);
    assert_eq!(account.data.len(), INTERNSHIP_SPACE);
    // Internship has no separate initialized flag: its discriminator, program
    // ownership and exact serialized fields establish successful initialization.
    assert_eq!(&account.data[..8], &INTERNSHIP_DISCRIMINATOR);
    assert_eq!(&account.data[8..40], sponsor.as_ref());
    assert_eq!(&account.data[40..48], &internship_id.to_le_bytes());
    assert_eq!(account.data[48], bump);
    assert_eq!(account.lamports, expected_rent);

    let sponsor_after = svm
        .get_account(&sponsor)
        .expect("sponsor must remain funded");
    assert_eq!(sponsor_after.owner, system_program::ID);
    assert!(sponsor_after.data.is_empty());
    assert_eq!(
        sponsor_after.lamports,
        sponsor_lamports
            .checked_sub(expected_rent)
            .and_then(|balance| balance.checked_sub(execution.fee))
            .expect("fixture funding must cover rent and transaction fees"),
    );
}
