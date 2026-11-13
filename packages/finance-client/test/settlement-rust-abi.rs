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
    let caller = public(210);
    let mut vectors = Vec::new();
    for (iid, mid) in [
        (0u64, 0u64),
        (9007199254740993, 9007199254740995),
        (u64::MAX, u64::MAX),
    ] {
        let (internship, _) =
            Pubkey::find_program_address(&internship_seeds(&sponsor, &encode_id(iid)), &ID);
        let (milestone, _) =
            Pubkey::find_program_address(&milestone_seeds(&internship, &encode_id(mid)), &ID);
        let (submission, _) = Pubkey::find_program_address(&submission_seeds(&milestone), &ID);
        let (completion_record, _) =
            Pubkey::find_program_address(&completion_seeds(&milestone), &ID);
        let (vault, _) = Pubkey::find_program_address(&vault_seeds(&milestone), &ID);
        let (vault_authority, _) =
            Pubkey::find_program_address(&vault_authority_seeds(&milestone), &ID);
        let student_ata =
            get_associated_token_address_with_program_id(&student, &DEMO_MINT, &token::ID);
        let canonical =
            get_associated_token_address_with_program_id(&sponsor, &DEMO_MINT, &token::ID);
        for destination in [canonical, public(230)] {
            let abi = entry(
                "settlement",
                instruction::SettleMilestone {}.data(),
                accounts::SettleMilestone {
                    caller,
                    internship,
                    milestone,
                    submission,
                    completion_record,
                    reward_mint: DEMO_MINT,
                    vault,
                    vault_authority,
                    student_ata,
                    sponsor_ata: destination,
                    sponsor,
                    token_program: token::ID,
                    system_program: anchor_lang::system_program::ID,
                }
                .to_account_metas(None),
            );
            vectors.push(format!(r#"{{"caller":"{caller}","sponsor":"{sponsor}","student":"{student}","internshipId":"{iid}","milestoneId":"{mid}","destination":"{destination}","submission":"{submission}","completion":"{completion_record}",{abi}}}"#));
        }
    }
    println!(
        r#"{{"programId":"{ID}","vectors":[{}]}}"#,
        vectors.join(",")
    );
}
