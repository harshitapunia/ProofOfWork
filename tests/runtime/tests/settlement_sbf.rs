//! Successful SBF settlement lifecycle; compile only until separately authorized.
//! Signature verification is disabled explicitly: this does not test cryptographic authentication.
mod support;

use support::{finance::*, PROGRAM_ID};

/// Pays exact principal and surplus via real Token CPIs and creates the exact completion payload.
#[test]
fn verified_milestone_settles_principal_surplus_completion_and_vault_rent() {
    let mut f = Fixture::new();
    let target = f.scope(1);
    let other = f.scope(2);
    f.create_and_fund(&target);
    f.create_and_fund(&other);
    f.assign(&target);
    f.submit_and_attest(&target);
    f.donate_surplus(&target);
    f.set_time(NOW + 30);
    assert!(f.svm.get_account(&target.completion).is_none());
    let unrelated = f.snapshot(&[
        f.internship,
        target.submission,
        other.milestone,
        other.vault,
        other.authority,
        other.submission,
        other.completion,
        f.sentinel,
        f.verifier,
        f.student,
        MINT,
    ]);
    let sponsor_tokens = f.token_amount(f.sponsor_ata);
    let student_tokens = f.token_amount(f.student_ata);
    let sponsor_sol = f.account(f.sponsor).lamports;
    let caller_sol = f.account(f.caller).lamports;
    let vault_rent = f.account(target.vault).lamports;
    let mut expected_milestone = f.account(target.milestone);
    expected_milestone.data[272] = SETTLED;
    let meta = f.settle(&target);
    assert_token_cpis(&meta, 2, 1);
    assert_eq!(f.token_amount(f.student_ata), student_tokens + REWARD);
    assert_eq!(f.token_amount(f.sponsor_ata), sponsor_tokens + SURPLUS);
    assert!(
        f.svm.get_account(&target.vault).is_none(),
        "zero-lamport closed vault must be removed"
    );
    assert_eq!(f.account(f.sponsor).lamports, sponsor_sol + vault_rent);
    assert_eq!(f.account(target.milestone), expected_milestone);
    f.assert_status(&target, SETTLED);

    let completion = f.program_account(target.completion, 249, COMPLETION_DISC);
    let mut expected = COMPLETION_DISC.to_vec();
    for key in [
        target.milestone,
        f.student,
        f.sponsor,
        f.verifier,
        target.submission,
    ] {
        expected.extend_from_slice(key.as_ref());
    }
    expected.extend_from_slice(&REQUIREMENTS);
    expected.extend_from_slice(&EVIDENCE);
    expected.extend_from_slice(&(NOW + 20).to_le_bytes());
    expected.extend_from_slice(&(NOW + 30).to_le_bytes());
    expected.push(target.completion_bump);
    assert_eq!(completion.owner, PROGRAM_ID);
    assert_eq!(completion.data, expected);
    assert_eq!(
        f.account(f.caller).lamports,
        caller_sol - completion.lamports - meta.fee
    );
    eprintln!(
        "settled PDA {}; completion {}; vault rent {}; completion rent {}; fee {}",
        target.milestone, target.completion, vault_rent, completion.lamports, meta.fee
    );
    f.assert_unchanged(&unrelated);
    f.assert_conserved();
}

/// Full positive lifecycle; source accounts are never replaced with synthetic program state.
fn policy_v2_success(
    surplus: bool,
    fresh: bool,
    changed_authority: bool,
    prefund_completion: bool,
) {
    let mut f = Fixture::new();
    let target = f.scope(1);
    let other = f.scope(2);
    f.create_and_fund(&target);
    f.create_and_fund(&other);
    f.assign(&target);
    f.submit_and_attest(&target);
    if surplus {
        f.donate_surplus(&target);
    }
    if changed_authority {
        f.change_sponsor_ata_authority();
    }
    f.set_time(NOW + 30);
    if changed_authority {
        let before = f.settlement_snapshot(&target, f.sponsor_ata);
        let ix = f.settlement_instruction(&target, f.sponsor_ata);
        let failure = f.reject_many(f.caller, &[ix]);
        assert_token_cpis(&failure.meta, 0, 0);
        f.assert_rollback(&before, f.caller, failure.meta.fee);
    }
    let untouched = f.snapshot(&[
        other.milestone,
        other.vault,
        other.submission,
        other.completion,
        f.internship,
        target.submission,
        MINT,
        f.sentinel,
    ]);
    let sponsor_tokens = f.token_amount(f.sponsor_ata);
    let student_tokens = f.token_amount(f.student_ata);
    let caller_sol = f.account(f.caller).lamports;
    let sponsor_sol = f.account(f.sponsor).lamports;
    let vault_rent = f.account(target.vault).lamports;
    let (destination, mut instructions) = if fresh {
        f.provision_destination(&target, f.sponsor)
    } else {
        (f.sponsor_ata, vec![])
    };
    let destination_rent = if fresh {
        f.svm.minimum_balance_for_rent_exemption(165)
    } else {
        0
    };
    if fresh {
        assert!(f.svm.get_account(&destination).is_none());
    }
    if prefund_completion {
        instructions.push(f.system_transfer(f.caller, target.completion, 1));
    }
    instructions.push(f.settlement_instruction(&target, destination));
    let meta = f.execute_many(f.caller, &instructions);
    assert_token_cpis(&meta, if surplus { 2 } else { 1 }, 1);
    assert_eq!(f.token_amount(f.student_ata), student_tokens + REWARD);
    let returned = if surplus { SURPLUS } else { 0 };
    assert_eq!(
        f.token_amount(destination),
        if fresh {
            returned
        } else {
            sponsor_tokens + returned
        }
    );
    assert_eq!(&f.account(destination).data[32..64], f.sponsor.as_ref());
    if fresh {
        assert_eq!(f.token_amount(f.sponsor_ata), sponsor_tokens);
    }
    assert!(f.svm.get_account(&target.vault).is_none());
    assert_eq!(f.account(f.sponsor).lamports, sponsor_sol + vault_rent);
    f.assert_status(&target, SETTLED);
    let completion = f.program_account(target.completion, 249, COMPLETION_DISC);
    let mut expected = COMPLETION_DISC.to_vec();
    for key in [
        target.milestone,
        f.student,
        f.sponsor,
        f.verifier,
        target.submission,
    ] {
        expected.extend_from_slice(key.as_ref());
    }
    expected.extend_from_slice(&REQUIREMENTS);
    expected.extend_from_slice(&EVIDENCE);
    expected.extend_from_slice(&(NOW + 20).to_le_bytes());
    expected.extend_from_slice(&(NOW + 30).to_le_bytes());
    expected.push(target.completion_bump);
    assert_eq!(completion.data, expected);
    assert_eq!(
        f.account(f.caller).lamports,
        caller_sol - destination_rent - completion.lamports - meta.fee
    );
    f.assert_unchanged(&untouched);
    f.assert_conserved();

    // Logical replay uses a new transaction placeholder, so it must hit program state checks.
    let before = f.settlement_snapshot(&target, destination);
    let ix = f.settlement_instruction(&target, destination);
    let failure = f.reject_many(f.caller, &[ix]);
    assert_token_cpis(&failure.meta, 0, 0);
    f.assert_rollback(&before, f.caller, failure.meta.fee);
}

#[test]
fn canonical_zero_surplus_settlement() {
    policy_v2_success(false, false, false, false);
}
#[test]
fn fresh_sponsor_destination_zero_surplus() {
    policy_v2_success(false, true, false, false);
}
#[test]
fn fresh_sponsor_destination_positive_surplus() {
    policy_v2_success(true, true, false, false);
}
#[test]
fn changed_canonical_authority_zero_surplus_fallback() {
    policy_v2_success(false, true, true, false);
}
#[test]
fn changed_canonical_authority_positive_surplus_fallback() {
    policy_v2_success(true, true, true, false);
}
#[test]
fn prefunded_completion_pda_initializes_with_exact_rent() {
    policy_v2_success(true, true, false, true);
}

#[test]
fn invalid_fresh_authority_rejects_and_rolls_back_provisioning() {
    let mut f = Fixture::new();
    let target = f.scope(1);
    f.create_and_fund(&target);
    f.assign(&target);
    f.submit_and_attest(&target);
    f.donate_surplus(&target);
    let (destination, mut ixs) = f.provision_destination(&target, f.caller);
    let before = f.settlement_snapshot(&target, destination);
    ixs.push(f.settlement_instruction(&target, destination));
    let failure = f.reject_many(f.caller, &ixs);
    assert_token_cpis(&failure.meta, 0, 0);
    assert!(failure
        .meta
        .logs
        .iter()
        .any(|l| l == "Program log: Instruction: InitializeAccount3"));
    f.assert_rollback(&before, f.caller, failure.meta.fee);
    assert!(f.svm.get_account(&destination).is_none());
}

#[test]
fn unusable_or_wrong_mint_or_program_destinations_reject_before_transfers() {
    for kind in 0..5 {
        let mut f = Fixture::new();
        let target = f.scope(1);
        f.create_and_fund(&target);
        f.assign(&target);
        f.submit_and_attest(&target);
        let (destination, ixs) = f.provision_destination(&target, f.sponsor);
        f.execute_many(f.caller, &ixs);
        // Explicit malformed-account fault fixtures, not a claim these states arise naturally.
        let mut account = f.account(destination);
        match kind {
            0 => account.data[0..32].copy_from_slice(f.sentinel.as_ref()),
            1 => account.owner = solana_sdk_ids::system_program::ID,
            2 => account.data[108] = 2, // Frozen
            3 => account.data[108] = 0, // Uninitialized
            4 => account.data[109..113].copy_from_slice(&1u32.to_le_bytes()), // Native
            _ => unreachable!(),
        }
        f.svm.set_account(destination, account).unwrap();
        let before = f.settlement_snapshot(&target, destination);
        let ix = f.settlement_instruction(&target, destination);
        let failure = f.reject_many(f.caller, &[ix]);
        assert_token_cpis(&failure.meta, 0, 0);
        f.assert_rollback(&before, f.caller, failure.meta.fee);
    }
}

#[test]
fn cross_milestone_and_destination_aliases_preserve_both_scopes() {
    for kind in 0..6 {
        let mut f = Fixture::new();
        let target = f.scope(1);
        let other = f.scope(2);
        f.create_and_fund(&target);
        f.assign(&target);
        f.submit_and_attest(&target);
        f.create_and_fund(&other);
        f.assign(&other);
        f.submit_and_attest(&other);
        let other_before = f.snapshot(&[
            other.milestone,
            other.vault,
            other.submission,
            other.completion,
        ]);
        let before = f.settlement_snapshot(&target, f.sponsor_ata);
        let mut ix = f.settlement_instruction(&target, f.sponsor_ata);
        let (slot, key) = match kind {
            0 => (6, other.vault),
            1 => (7, other.authority),
            2 => (3, other.submission),
            3 => (4, other.completion),
            4 => (9, target.vault),
            5 => (9, f.student_ata),
            _ => unreachable!(),
        };
        ix.accounts[slot].pubkey = key;
        let failure = f.reject_many(f.caller, &[ix]);
        assert_token_cpis(&failure.meta, 0, 0);
        f.assert_rollback(&before, f.caller, failure.meta.fee);
        f.assert_unchanged(&other_before);
        f.assert_conserved();
    }
}

#[test]
fn exact_transaction_replay_is_rejected_by_runtime_history() {
    use solana_address::Address;
    let elf = support::verified_program_elf();
    // LiteSVM 0.18.2 gates history rejection on sigverify. Use only its authorized
    // internal ephemeral airdrop signer; no private key is read, exported or logged.
    let mut svm = support::svm_with_placeholder_signatures()
        .with_lamports(1_000_000_000)
        .with_transaction_history(64)
        .with_sigverify(true);
    svm.add_program(PROGRAM_ID, &elf).unwrap();
    assert!(svm.get_sigverify());
    let recipient = Address::new_from_array([99; 32]);
    let first = svm
        .airdrop(&recipient, 1_000_000)
        .expect("first local signed transfer");
    assert!(first.compute_units_consumed > 0);
    let recipient_before = svm.get_account(&recipient);
    let payer = svm.airdrop_pubkey(); // Public address only.
    let payer_before = svm.get_account(&payer);
    // Same recipient, amount, blockhash and internal signer produce the exact same transaction.
    let failure = svm
        .airdrop(&recipient, 1_000_000)
        .expect_err("exact replay must fail");
    assert!(
        format!("{:?}", failure.err).contains("AlreadyProcessed"),
        "must reject history replay; actual error: {:?}",
        failure.err
    );
    assert_eq!(failure.meta.compute_units_consumed, 0);
    assert!(
        failure.meta.logs.is_empty(),
        "must reject before instruction execution"
    );
    assert_eq!(svm.get_account(&recipient), recipient_before);
    assert_eq!(
        svm.get_account(&payer),
        payer_before,
        "duplicate must not charge another fee"
    );
    eprintln!(
        "signed local history replay rejected before execution: {:?}",
        failure.err
    );
}
