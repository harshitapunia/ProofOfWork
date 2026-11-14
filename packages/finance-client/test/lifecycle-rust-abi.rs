//! Offline ABI fixture exporter: uses actual generated Rust instruction and account-meta types.
use anchor_lang::{prelude::*, InstructionData, ToAccountMetas};
use anchor_spl::{associated_token::get_associated_token_address_with_program_id, token};
use proof_of_work::{accounts, config::DEMO_MINT, instruction, seeds::*, ID};
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn entry(
    name: &str,
    data: Vec<u8>,
    metas: Vec<anchor_lang::solana_program::instruction::AccountMeta>,
) -> String {
    let metas = metas
        .iter()
        .map(|m| {
            format!(
                r#"{{"pubkey":"{}","isSigner":{},"isWritable":{}}}"#,
                m.pubkey, m.is_signer, m.is_writable
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    format!(
        r#""{name}":{{"dataHex":"{}","accounts":[{metas}]}}"#,
        hex(&data)
    )
}

fn public(tag: u8) -> Pubkey {
    (tag..=255)
        .map(|n| Pubkey::new_from_array([n; 32]))
        .find(|k| k.is_on_curve())
        .unwrap()
}
fn main() {
    let sponsor = public(1);
    let student = public(70);
    let verifier = public(140);
    let mut vectors = Vec::new();
    for (iid, mid, evidence) in [
        (0u64, 0u64, [9u8; 32]),
        (
            9007199254740993,
            9007199254740995,
            core::array::from_fn(|n| n as u8),
        ),
        (u64::MAX, u64::MAX, [255; 32]),
    ] {
        let (internship, _) =
            Pubkey::find_program_address(&internship_seeds(&sponsor, &encode_id(iid)), &ID);
        let (milestone, _) =
            Pubkey::find_program_address(&milestone_seeds(&internship, &encode_id(mid)), &ID);
        let (submission, _) = Pubkey::find_program_address(&submission_seeds(&milestone), &ID);
        let (vault, _) = Pubkey::find_program_address(&vault_seeds(&milestone), &ID);
        let (vault_authority, _) =
            Pubkey::find_program_address(&vault_authority_seeds(&milestone), &ID);
        let sponsor_ata =
            get_associated_token_address_with_program_id(&sponsor, &DEMO_MINT, &token::ID);
        let assignment = entry(
            "assignment",
            instruction::AssignStudent { student }.data(),
            accounts::AssignStudent {
                sponsor,
                internship,
                milestone,
            }
            .to_account_metas(None),
        );
        let submit = entry(
            "submission",
            instruction::SubmitMilestone {
                evidence_hash: evidence,
            }
            .data(),
            accounts::SubmitMilestone {
                student,
                internship,
                milestone,
                submission,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
        );
        let refund = entry(
            "refund",
            instruction::RefundUnclaimedMilestone {}.data(),
            accounts::RefundUnclaimedMilestone {
                sponsor,
                internship,
                milestone,
                reward_mint: DEMO_MINT,
                vault,
                vault_authority,
                sponsor_ata,
                token_program: token::ID,
            }
            .to_account_metas(None),
        );
        let attest = entry(
            "attestation",
            instruction::AttestMilestone {
                expected_student: student,
                expected_requirements_hash: [7; 32],
                expected_evidence_hash: evidence,
            }
            .data(),
            accounts::AttestMilestone {
                verifier,
                internship,
                milestone,
                submission,
            }
            .to_account_metas(None),
        );
        vectors.push(format!(r#"{{"sponsor":"{sponsor}","student":"{student}","verifier":"{verifier}","internshipId":"{iid}","milestoneId":"{mid}","internship":"{internship}","milestone":"{milestone}","submissionAddress":"{submission}","evidenceHash":"{}","requirementsHash":"{}",{assignment},{submit},{refund},{attest}}}"#, hex(&evidence), hex(&[7; 32])));
    }
    println!(
        r#"{{"programId":"{ID}","vectors":[{}]}}"#,
        vectors.join(",")
    );
}
