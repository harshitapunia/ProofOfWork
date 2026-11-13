//! Successful Funded/Assigned SBF refunds; no tests execute during compilation-only validation.
//! Public fixture roles and placeholder signatures do not establish cryptographic authentication.
mod support;

use support::finance::*;

/// Exercises the same real refund lifecycle with either permitted starting state.
fn refund_from_state(assigned: bool) {
    let mut f = Fixture::new();
    let target = f.scope(1);
    let other = f.scope(2);
    f.create_and_fund(&target);
    f.create_and_fund(&other);
    if assigned {
        f.assign(&target);
    }
    f.assert_status(&target, if assigned { ASSIGNED } else { FUNDED });
    f.donate_surplus(&target);
    // Exact >= boundary, using the actual Clock sysvar account/cache, not modified program state.
    f.set_time(SUBMIT_BY);
    let unrelated = f.snapshot(&[
        f.internship,
        other.milestone,
        other.vault,
        other.authority,
        other.submission,
        other.completion,
        f.student_ata,
        f.student,
        f.verifier,
        f.caller,
        f.sentinel,
        MINT,
    ]);
    assert!(f.svm.get_account(&target.submission).is_none());
    assert!(f.svm.get_account(&target.completion).is_none());
    let tokens = f.token_amount(f.sponsor_ata);
    let sol = f.account(f.sponsor).lamports;
    let vault_rent = f.account(target.vault).lamports;
    let mut expected = f.account(target.milestone);
    assert_eq!(&expected.data[168..200], &[0; 32]);
    assert_eq!(&expected.data[264..272], &[0; 8]);
    expected.data[272] = REFUNDED;
    let meta = f.refund(&target);
    assert_token_cpis(&meta, 1, 1);
    assert_eq!(f.token_amount(f.sponsor_ata), tokens + REWARD + SURPLUS);
    assert_eq!(f.account(f.sponsor).lamports, sol + vault_rent - meta.fee);
    assert!(f.svm.get_account(&target.vault).is_none());
    assert!(f.svm.get_account(&target.submission).is_none());
    assert!(
        f.svm.get_account(&target.completion).is_none(),
        "refund must not create CompletionRecord"
    );
    assert_eq!(f.account(target.milestone), expected);
    f.assert_status(&target, REFUNDED);
    eprintln!(
        "refunded PDA {}; assigned {}; principal {}; surplus {}; vault rent {}; fee {}",
        target.milestone, assigned, REWARD, SURPLUS, vault_rent, meta.fee
    );
    f.assert_unchanged(&unrelated);
    f.assert_conserved();
}

/// Refunds expired unassigned escrow with surplus and correct rent/fee accounting.
#[test]
fn funded_milestone_refunds_principal_surplus_and_vault_rent() {
    refund_from_state(false);
}

/// Refunds assigned but unsubmitted escrow at the exact submission cutoff.
#[test]
fn assigned_milestone_refunds_principal_surplus_and_vault_rent() {
    refund_from_state(true);
}

#[test]
fn refund_boundaries_and_canonical_destination_remain_enforced() {
    for kind in 0..3 {
        let mut f = Fixture::new();
        let target = f.scope(1);
        f.create_and_fund(&target);
        let destination = if kind == 1 {
            let (destination, ixs) = f.provision_destination(&target, f.sponsor);
            f.execute_many(f.caller, &ixs);
            destination
        } else {
            f.sponsor_ata
        };
        if kind == 2 {
            f.assign(&target);
            f.submit_and_attest(&target);
        }
        f.set_time(if kind == 0 { SUBMIT_BY - 1 } else { SUBMIT_BY });
        let before = f.settlement_snapshot(&target, destination);
        let ix = f.refund_instruction(&target, destination);
        let failure = f.reject_many(f.sponsor, &[ix]);
        assert_token_cpis(&failure.meta, 0, 0);
        f.assert_rollback(&before, f.sponsor, failure.meta.fee);
    }
}

#[test]
fn refund_replay_does_not_pay_twice() {
    let mut f = Fixture::new();
    let target = f.scope(1);
    f.create_and_fund(&target);
    f.set_time(SUBMIT_BY);
    f.refund(&target);
    let before = f.settlement_snapshot(&target, f.sponsor_ata);
    let ix = f.refund_instruction(&target, f.sponsor_ata);
    let failure = f.reject_many(f.sponsor, &[ix]);
    assert_token_cpis(&failure.meta, 0, 0);
    f.assert_rollback(&before, f.sponsor, failure.meta.fee);
    assert!(f.svm.get_account(&target.completion).is_none());
}

#[test]
fn unauthorized_refund_and_cross_milestone_vault_are_rejected() {
    for unauthorized in [true, false] {
        let mut f = Fixture::new();
        let target = f.scope(1);
        let other = f.scope(2);
        f.create_and_fund(&target);
        f.create_and_fund(&other);
        f.set_time(SUBMIT_BY);
        let before = f.settlement_snapshot(&target, f.sponsor_ata);
        let other_before = f.snapshot(&[other.milestone, other.vault]);
        let mut ix = f.refund_instruction(&target, f.sponsor_ata);
        let payer = if unauthorized {
            ix.accounts[0].pubkey = f.caller;
            f.caller
        } else {
            ix.accounts[4].pubkey = other.vault;
            f.sponsor
        };
        let failure = f.reject_many(payer, &[ix]);
        assert_token_cpis(&failure.meta, 0, 0);
        f.assert_rollback(&before, payer, failure.meta.fee);
        f.assert_unchanged(&other_before);
    }
}
