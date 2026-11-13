//! Runtime fault cases executed only under explicit local VM authorization. No native stubs or snapshot restoration.
//! Overflow prestate is deliberately synthetic and not claimed economically reachable.
mod support;
use support::finance::*;

fn verified() -> (Fixture, Scope) {
    let mut f = Fixture::new();
    let target = f.scope(1);
    f.create_and_fund(&target);
    let unrelated = f.scope(2);
    f.create_and_fund(&unrelated);
    f.assign(&target);
    f.submit_and_attest(&target);
    (f, target)
}

#[test]
fn surplus_transfer_failure_rolls_back_reward_completion_and_state() {
    let (mut f, target) = verified();
    f.donate_surplus(&target);
    f.synthetic_token_overflow(f.sponsor_ata);
    let before = f.settlement_snapshot(&target, f.sponsor_ata);
    let ix = f.settlement_instruction(&target, f.sponsor_ata);
    let failure = f.reject_many(f.caller, &[ix]);
    require_transfer_stage_failure(&failure, 2, 0);
    f.assert_rollback(&before, f.caller, failure.meta.fee);
    assert!(f.svm.get_account(&target.completion).is_none());
    f.assert_status(&target, VERIFIED);
}

#[test]
fn close_failure_rolls_back_both_transfers_completion_and_state() {
    let (mut f, target) = verified();
    f.donate_surplus(&target);
    f.synthetic_close_overflow();
    let before = f.settlement_snapshot(&target, f.sponsor_ata);
    let ix = f.settlement_instruction(&target, f.sponsor_ata);
    let failure = f.reject_many(f.caller, &[ix]);
    require_transfer_stage_failure(&failure, 2, 1);
    f.assert_rollback(&before, f.caller, failure.meta.fee);
    assert!(f.svm.get_account(&target.completion).is_none());
    f.assert_status(&target, VERIFIED);
}

#[test]
fn insufficient_completion_rent_fails_initialization_before_token_transfers() {
    let (mut f, target) = verified();
    let mut caller = f.account(f.caller);
    caller.lamports = 1_000_000;
    assert!(caller.lamports > f.svm.minimum_balance_for_rent_exemption(0));
    assert!(caller.lamports < f.svm.minimum_balance_for_rent_exemption(249));
    f.svm.set_account(f.caller, caller).unwrap();
    let before = f.settlement_snapshot(&target, f.sponsor_ata);
    let ix = f.settlement_instruction(&target, f.sponsor_ata);
    let failure = f.reject_many(f.caller, &[ix]);
    assert_token_cpis(&failure.meta, 0, 0);
    assert!(failure
        .meta
        .logs
        .iter()
        .any(|l| l == "Program log: Instruction: SettleMilestone"));
    assert!(
        failure.meta.logs.iter().any(|l| l.contains(&format!(
            "Program {} invoke [2]",
            solana_sdk_ids::system_program::ID
        ))),
        "must reach completion initialization System CPI"
    );
    f.assert_rollback(&before, f.caller, failure.meta.fee);
    assert!(f.svm.get_account(&target.completion).is_none());
}

#[test]
fn later_instruction_failure_rolls_back_atomic_provisioning_and_entire_settlement() {
    let (mut f, target) = verified();
    f.donate_surplus(&target);
    let (destination, mut ixs) = f.provision_destination(&target, f.sponsor);
    let before = f.settlement_snapshot(&target, destination);
    ixs.push(f.settlement_instruction(&target, destination));
    ixs.push(f.system_transfer(f.caller, f.sentinel, u64::MAX));
    let sentinel_before = f.snapshot(&[f.sentinel]);
    let failure = f.reject_many(f.caller, &ixs);
    assert_token_cpis(&failure.meta, 2, 1);
    assert!(
        failure
            .meta
            .logs
            .iter()
            .any(|l| l == &format!("Program {} success", support::PROGRAM_ID)),
        "settlement must complete internally before the later instruction fails"
    );
    f.assert_rollback(&before, f.caller, failure.meta.fee);
    f.assert_unchanged(&sentinel_before);
    assert!(f.svm.get_account(&destination).is_none());
    assert!(f.svm.get_account(&target.completion).is_none());
    f.assert_status(&target, VERIFIED);
    f.assert_conserved();
}

#[test]
fn refund_transfer_failure_rolls_back_without_marking_refunded() {
    let mut f = Fixture::new();
    let target = f.scope(1);
    f.create_and_fund(&target);
    let unrelated = f.scope(2);
    f.create_and_fund(&unrelated);
    f.set_time(SUBMIT_BY);
    f.synthetic_token_overflow(f.sponsor_ata);
    let before = f.settlement_snapshot(&target, f.sponsor_ata);
    let ix = f.refund_instruction(&target, f.sponsor_ata);
    let failure = f.reject_many(f.sponsor, &[ix]);
    require_transfer_stage_failure(&failure, 1, 0);
    f.assert_rollback(&before, f.sponsor, failure.meta.fee);
    f.assert_status(&target, FUNDED);
}

#[test]
fn refund_close_failure_rolls_back_refund_transfer_and_state() {
    let mut f = Fixture::new();
    let target = f.scope(1);
    f.create_and_fund(&target);
    let unrelated = f.scope(2);
    f.create_and_fund(&unrelated);
    f.set_time(SUBMIT_BY);
    f.synthetic_close_overflow();
    let before = f.settlement_snapshot(&target, f.sponsor_ata);
    let ix = f.refund_instruction(&target, f.sponsor_ata);
    let failure = f.reject_many(f.sponsor, &[ix]);
    require_transfer_stage_failure(&failure, 1, 1);
    f.assert_rollback(&before, f.sponsor, failure.meta.fee);
    f.assert_status(&target, FUNDED);
}
