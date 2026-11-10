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
