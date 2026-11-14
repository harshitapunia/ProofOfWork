//! Compiled account serialization from approved generated Anchor account types.
use anchor_lang::{prelude::*, AccountSerialize};
use proof_of_work::{config::DEMO_MINT, seeds::*, state::*, ID};
fn public(start: u8) -> Pubkey {
    (start..=255)
        .map(|n| Pubkey::new_from_array([n; 32]))
        .find(Pubkey::is_on_curve)
        .unwrap()
}
fn bytes(value: &impl AccountSerialize) -> String {
    let mut data = Vec::new();
    value.try_serialize(&mut data).unwrap();
    data.iter().map(|b| format!("{b:02x}")).collect()
}
fn entry(at: Pubkey, data: &impl AccountSerialize) -> String {
    format!(r#"{{"address":"{at}","hex":"{}"}}"#, bytes(data))
}
fn main() {
    let sponsor = public(1);
    let student = public(70);
    let verifier = public(140);
    let mut cases = Vec::new();
    for id in [0u64, u64::MAX] {
        let (i, ib) =
            Pubkey::find_program_address(&internship_seeds(&sponsor, &encode_id(id)), &ID);
        let (m, mb) = Pubkey::find_program_address(&milestone_seeds(&i, &encode_id(id)), &ID);
        let (s, sb) = Pubkey::find_program_address(&submission_seeds(&m), &ID);
        let (c, cb) = Pubkey::find_program_address(&completion_seeds(&m), &ID);
        let (_, vb) = Pubkey::find_program_address(&vault_seeds(&m), &ID);
        let (_, ab) = Pubkey::find_program_address(&vault_authority_seeds(&m), &ID);
        let internship = Internship {
            sponsor,
            internship_id: id,
            bump: ib,
        };
        for (n, status) in [
            MilestoneStatus::Created,
            MilestoneStatus::Funded,
            MilestoneStatus::Assigned,
            MilestoneStatus::Submitted,
            MilestoneStatus::Verified,
            MilestoneStatus::Settled,
            MilestoneStatus::Refunded,
        ]
        .into_iter()
        .enumerate()
        {
            let has_submission = (3..=5).contains(&n);
            let verified_at = if n == 4 || n == 5 { i64::MAX - 25 } else { 0 };
            let bound_student = if n < 2 || (n == 6 && id == 0) {
                Pubkey::default()
            } else {
                student
            };
            let mut milestone = Milestone {
                internship: i,
                sponsor,
                student: bound_student,
                verifier,
                reward_mint: DEMO_MINT,
                submission: if has_submission { s } else { Pubkey::default() },
                requirements_hash: [7; 32],
                milestone_id: id,
                reward_amount: u64::MAX,
                assign_by: i64::MAX - 100,
                submit_by: i64::MAX,
                verified_at,
                status,
                bump: mb,
                vault_bump: vb,
                vault_authority_bump: ab,
            };
            let submission = Submission {
                milestone: m,
                student,
                evidence_hash: [9; 32],
                submitted_at: i64::MAX - 50,
                bump: sb,
            };
            let completion = CompletionRecord {
                milestone: m,
                student,
                sponsor,
                verifier,
                submission: s,
                requirements_hash: [7; 32],
                evidence_hash: [9; 32],
                verified_at,
                settled_at: i64::MAX,
                bump: cb,
            };
            let mil = entry(m, &milestone);
            milestone.assign_by = i64::MIN;
            cases.push(format!(r#"{{"id":"{id}","status":{n},"internship":{},"milestone":{mil},"submission":{},"completion":{},"negativeTimestampHex":"{}"}}"#,
                entry(i,&internship),if has_submission {entry(s,&submission)} else {"null".into()},
                if n==5 {entry(c,&completion)} else {"null".into()}, bytes(&milestone)));
        }
    }
    println!(r#"{{"programId":"{ID}","cases":[{}]}}"#, cases.join(","));
}
