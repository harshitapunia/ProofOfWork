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
fn main() {
    let sponsor = Pubkey::new_from_array([1; 32]);
    let verifier = (140..=255)
        .map(|n| Pubkey::new_from_array([n; 32]))
        .find(|k| k.is_on_curve())
        .unwrap();
    let mut vectors = Vec::new();
    for (iid, mid, amount, assign, submit) in [
        (
            9007199254740993u64,
            9007199254740995u64,
            9007199254740997u64,
            200i64,
            300i64,
        ),
        (u64::MAX, u64::MAX, u64::MAX, i64::MAX - 1, i64::MAX),
        (0, 0, 1, 200, 300),
    ] {
        let (internship, ib) =
            Pubkey::find_program_address(&internship_seeds(&sponsor, &encode_id(iid)), &ID);
        let (milestone, mb) =
            Pubkey::find_program_address(&milestone_seeds(&internship, &encode_id(mid)), &ID);
        let (vault, vb) = Pubkey::find_program_address(&vault_seeds(&milestone), &ID);
        let (authority, ab) = Pubkey::find_program_address(&vault_authority_seeds(&milestone), &ID);
        let ata = get_associated_token_address_with_program_id(&sponsor, &DEMO_MINT, &token::ID);
        let a = entry(
            "createInternship",
            instruction::CreateInternship { internship_id: iid }.data(),
            accounts::CreateInternship {
                sponsor,
                internship,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
        );
        let b = entry(
            "createMilestone",
            instruction::CreateMilestone {
                milestone_id: mid,
                reward_amount: amount,
                requirements_hash: [5; 32],
                assign_by: assign,
                submit_by: submit,
                verifier,
            }
            .data(),
            accounts::CreateMilestone {
                sponsor,
                internship,
                milestone,
                reward_mint: DEMO_MINT,
                token_program: token::ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
        );
        let c = entry(
            "fundMilestone",
            instruction::FundMilestone {}.data(),
            accounts::FundMilestone {
                sponsor,
                internship,
                milestone,
                reward_mint: DEMO_MINT,
                sponsor_ata: ata,
                vault,
                vault_authority: authority,
                token_program: token::ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
        );
        vectors.push(format!(r#"{{"sponsor":"{sponsor}","verifier":"{verifier}","internshipId":"{iid}","milestoneId":"{mid}","rewardAmount":"{amount}","assignBy":"{assign}","submitBy":"{submit}","pdas":{{"internship":["{internship}",{ib}],"milestone":["{milestone}",{mb}],"vault":["{vault}",{vb}],"vaultAuthority":["{authority}",{ab}],"sponsorAta":"{ata}"}},{a},{b},{c}}}"#));
    }
    println!(
        r#"{{"programId":"{ID}","mint":"{DEMO_MINT}","vectors":[{}]}}"#,
        vectors.join(",")
    );
}
