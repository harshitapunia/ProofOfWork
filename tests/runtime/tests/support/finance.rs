//! Positive financial fixtures using the reviewed ELF, classic SPL Token 3.5.0
//! and ATA 1.1.1 ELFs bundled in the checksum-verified LiteSVM 0.18.2 crate.
//!
//! Injection is limited to public SOL accounts, zeroed Token-owned storage for
//! the fixed DEMO mint (no mint keypair is available), and Clock timestamps.
//! Real Token instructions initialize the mint and mint supply; real ATA
//! instructions create both ATAs. All ProofOfWork state comes from lifecycle
//! instructions. No vault, submission, milestone or completion state is injected.
//!
//! Unique placeholder signatures avoid history collisions without disabling
//! replay/blockhash checks. They are not signatures or authentication coverage.
//! Constructing a fixture creates LiteSVM's internal keypair; do not run without
//! separate execution approval. Helpers are shared by independent test binaries.
#![allow(dead_code)]

use {
    super::{
        create_internship_instruction, svm_with_placeholder_signatures, verified_program_elf,
        PROGRAM_ID,
    },
    litesvm::{types::TransactionMetadata, LiteSVM},
    sha2::{Digest, Sha256},
    solana_account::Account,
    solana_address::{address, Address},
    solana_instruction::{AccountMeta, Instruction},
    solana_message::Message,
    solana_sdk_ids::{bpf_loader, system_program, sysvar::clock},
    solana_transaction::Transaction,
};

pub const MINT: Address = address!("GoXZxB3gErYYQ3UPKghpTwNPkcqWH1qoNbyU2VTD8Bty");
pub const TOKEN: Address = address!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const ATA: Address = address!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const TOKEN_ELF_SHA256: &str =
    "7b44674b9704fa7640fbebfac68389f338b500b8c2bc29175c27ed66838b5a3c";
pub const ATA_ELF_SHA256: &str = "6804554e69fd3a58caa191dc4a58f4c67223d30ca28ab8987f39fc18d2f7374d";
pub const DECIMALS: u8 = 6;
pub const NOW: i64 = 1_800_000_000;
pub const ASSIGN_BY: i64 = NOW + 100;
pub const SUBMIT_BY: i64 = NOW + 200;
pub const REWARD: u64 = 1_000_000;
pub const SURPLUS: u64 = 27_123;
pub const INITIAL_SUPPLY: u64 = 10_000_000;
pub const REQUIREMENTS: [u8; 32] = [7; 32];
pub const EVIDENCE: [u8; 32] = [9; 32];
pub const FUNDED: u8 = 1;
pub const ASSIGNED: u8 = 2;
pub const VERIFIED: u8 = 4;
pub const SETTLED: u8 = 5;
pub const REFUNDED: u8 = 6;
pub const MILESTONE_DISC: [u8; 8] = [38, 210, 239, 177, 85, 184, 10, 44];
pub const SUBMISSION_DISC: [u8; 8] = [58, 194, 159, 158, 75, 102, 178, 197];
pub const COMPLETION_DISC: [u8; 8] = [57, 199, 33, 173, 2, 204, 92, 194];

/// Canonical addresses and bumps from seeds.rs; no accounts are created by derivation.
pub struct Scope {
    pub id: u64,
    pub milestone: Address,
    pub bump: u8,
    pub vault: Address,
    pub vault_bump: u8,
    pub authority: Address,
    pub authority_bump: u8,
    pub submission: Address,
    pub submission_bump: u8,
    pub completion: Address,
    pub completion_bump: u8,
}

/// VM plus public-only roles. This type must not be constructed during compilation.
pub struct Fixture {
    pub svm: LiteSVM,
    pub sponsor: Address,
    pub student: Address,
    pub verifier: Address,
    pub caller: Address,
    pub sentinel: Address,
    pub internship: Address,
    pub sponsor_ata: Address,
    pub student_ata: Address,
    nonce: u64,
}

/// Selects a deterministic valid compressed public point, without deriving any private key.
fn public_role(tag: u8) -> Address {
    for tail in 0..=u8::MAX {
        let mut bytes = [tag; 32];
        bytes[31] = tail;
        let address = Address::new_from_array(bytes);
        if address.is_on_curve() {
            return address;
        }
    }
    panic!("no on-curve public fixture for tag {tag}")
}

/// Encodes Anchor's discriminator and the exact ordered metas/argument bytes from the compiled IDL.
fn instruction(name: &str, metas: &[(Address, bool, bool)], args: &[u8]) -> Instruction {
    let mut data = Sha256::digest(format!("global:{name}").as_bytes())[..8].to_vec();
    data.extend_from_slice(args);
    Instruction {
        program_id: PROGRAM_ID,
        accounts: metas
            .iter()
            .map(|&(pubkey, is_signer, is_writable)| AccountMeta {
                pubkey,
                is_signer,
                is_writable,
            })
            .collect(),
        data,
    }
}

impl Fixture {
    /// Loads the existing ELF/profile and creates mint/ATAs through real SPL/ATA instructions.
    pub fn new() -> Self {
        let elf = verified_program_elf();
        let mut svm = svm_with_placeholder_signatures();
        svm.add_program(PROGRAM_ID, &elf)
            .expect("load reviewed ProofOfWork SBF");
        for (program, hash) in [(TOKEN, TOKEN_ELF_SHA256), (ATA, ATA_ELF_SHA256)] {
            let account = svm
                .get_account(&program)
                .expect("bundled SPL program exists");
            assert!(account.executable);
            assert_eq!(account.owner, bpf_loader::ID);
            assert_eq!(format!("{:x}", Sha256::digest(&account.data)), hash);
        }
        let sponsor = Address::new_from_array([11; 32]);
        let student = public_role(22);
        let verifier = public_role(33);
        let caller = Address::new_from_array([44; 32]);
        let sentinel = Address::new_from_array([77; 32]);
        for role in [sponsor, student, verifier, caller, sentinel] {
            svm.set_account(
                role,
                Account {
                    lamports: 1_000_000_000,
                    owner: system_program::ID,
                    ..Account::default()
                },
            )
            .unwrap();
        }
        let (create, internship, internship_bump) = create_internship_instruction(sponsor, 7);
        let sponsor_ata =
            Address::find_program_address(&[sponsor.as_ref(), TOKEN.as_ref(), MINT.as_ref()], &ATA)
                .0;
        let student_ata =
            Address::find_program_address(&[student.as_ref(), TOKEN.as_ref(), MINT.as_ref()], &ATA)
                .0;
        let mut f = Self {
            svm,
            sponsor,
            student,
            verifier,
            caller,
            sentinel,
            internship,
            sponsor_ata,
            student_ata,
            nonce: 1,
        };
        f.set_time(NOW);
        // Only zeroed allocation is injected. InitializeMint2 establishes all mint state.
        let rent = f.svm.minimum_balance_for_rent_exemption(82);
        f.svm
            .set_account(
                MINT,
                Account {
                    lamports: rent,
                    data: vec![0; 82],
                    owner: TOKEN,
                    ..Account::default()
                },
            )
            .unwrap();
        let mut data = vec![20, DECIMALS]; // SPL Token 3.5.0 InitializeMint2
        data.extend_from_slice(sponsor.as_ref());
        data.push(0); // Instruction's one-byte None freeze-authority option, not state COption.
        f.execute(
            sponsor,
            Instruction {
                program_id: TOKEN,
                accounts: vec![AccountMeta::new(MINT, false)],
                data,
            },
            "initialize DEMO mint",
        );
        for (wallet, ata) in [(sponsor, sponsor_ata), (student, student_ata)] {
            let create_ata = Instruction {
                program_id: ATA,
                accounts: vec![
                    AccountMeta::new(sponsor, true),
                    AccountMeta::new(ata, false),
                    AccountMeta::new_readonly(wallet, false),
                    AccountMeta::new_readonly(MINT, false),
                    AccountMeta::new_readonly(system_program::ID, false),
                    AccountMeta::new_readonly(TOKEN, false),
                ],
                data: vec![0],
            }; // ATA 1.1.1 Create, verified against its versioned source.
            f.execute(sponsor, create_ata, "create canonical ATA");
        }
        let mut data = vec![14]; // SPL Token MintToChecked
        data.extend_from_slice(&INITIAL_SUPPLY.to_le_bytes());
        data.push(DECIMALS);
        f.execute(
            sponsor,
            Instruction {
                program_id: TOKEN,
                accounts: vec![
                    AccountMeta::new(MINT, false),
                    AccountMeta::new(sponsor_ata, false),
                    AccountMeta::new_readonly(sponsor, true),
                ],
                data,
            },
            "mint DEMO supply",
        );
        f.execute(sponsor, create, "create_internship");
        let internship_state = f.program_account(
            internship,
            super::INTERNSHIP_SPACE,
            super::INTERNSHIP_DISCRIMINATOR,
        );
        assert_eq!(&internship_state.data[8..40], sponsor.as_ref());
        assert_eq!(&internship_state.data[40..48], &7u64.to_le_bytes());
        assert_eq!(internship_state.data[48], internship_bump);
        assert_eq!(f.token_amount(sponsor_ata), INITIAL_SUPPLY);
        assert_eq!(f.token_amount(student_ata), 0);
        f.assert_conserved();
        f
    }

    /// Sends one actual VM transaction with a unique noncryptographic placeholder signature.
    /// Blockhash/replay checks remain enabled; logs and compute/fees are printed for every step.
    pub fn execute(&mut self, payer: Address, ix: Instruction, label: &str) -> TransactionMetadata {
        let program = ix.program_id;
        let message =
            Message::new_with_blockhash(&[ix], Some(&payer), &self.svm.latest_blockhash());
        assert_eq!(message.header.num_required_signatures, 1);
        assert_eq!(message.account_keys[0], payer);
        let mut tx = Transaction::new_unsigned(message);
        let mut placeholder = [0; 64];
        placeholder[..8].copy_from_slice(&self.nonce.to_le_bytes());
        self.nonce = self.nonce.checked_add(1).unwrap();
        tx.signatures[0] = placeholder.into();
        let meta = self.svm.send_transaction(tx).unwrap_or_else(|e| {
            panic!(
                "{label}: {:?}; {} CUs\n{}",
                e.err,
                e.meta.compute_units_consumed,
                e.meta.pretty_logs()
            )
        });
        eprintln!(
            "{label}: {} CUs; fee {} lamports\n{}",
            meta.compute_units_consumed,
            meta.fee,
            meta.pretty_logs()
        );
        assert!(meta.compute_units_consumed > 0);
        assert!(meta.logs.contains(&format!("Program {program} success")));
        meta
    }

    /// Changes only unix_timestamp in the verified 40-byte Clock wire layout and updates LiteSVM's cache.
    /// This avoids introducing another direct SDK dependency solely for its Clock type.
    pub fn set_time(&mut self, timestamp: i64) {
        let mut account = self.svm.get_account(&clock::ID).unwrap();
        assert_eq!(account.data.len(), 40);
        account.data[32..40].copy_from_slice(&timestamp.to_le_bytes());
        self.svm.set_account(clock::ID, account).unwrap();
    }

    /// Derives all milestone-specific canonical addresses without injecting their contents.
    pub fn scope(&self, id: u64) -> Scope {
        let (milestone, bump) = Address::find_program_address(
            &[b"milestone", self.internship.as_ref(), &id.to_le_bytes()],
            &PROGRAM_ID,
        );
        let (vault, vault_bump) =
            Address::find_program_address(&[b"vault", milestone.as_ref()], &PROGRAM_ID);
        let (authority, authority_bump) =
            Address::find_program_address(&[b"vault_authority", milestone.as_ref()], &PROGRAM_ID);
        let (submission, submission_bump) =
            Address::find_program_address(&[b"submission", milestone.as_ref()], &PROGRAM_ID);
        let (completion, completion_bump) =
            Address::find_program_address(&[b"completion", milestone.as_ref()], &PROGRAM_ID);
        Scope {
            id,
            milestone,
            bump,
            vault,
            vault_bump,
            authority,
            authority_bump,
            submission,
            submission_bump,
            completion,
            completion_bump,
        }
    }

    /// Creates and funds a real milestone; the program initializes and funds the vault through CPIs.
    pub fn create_and_fund(&mut self, s: &Scope) {
        let mut args = Vec::new();
        args.extend_from_slice(&s.id.to_le_bytes());
        args.extend_from_slice(&REWARD.to_le_bytes());
        args.extend_from_slice(&REQUIREMENTS);
        args.extend_from_slice(&ASSIGN_BY.to_le_bytes());
        args.extend_from_slice(&SUBMIT_BY.to_le_bytes());
        args.extend_from_slice(self.verifier.as_ref());
        self.execute(
            self.sponsor,
            instruction(
                "create_milestone",
                &[
                    (self.sponsor, true, true),
                    (self.internship, false, false),
                    (s.milestone, false, true),
                    (MINT, false, false),
                    (TOKEN, false, false),
                    (system_program::ID, false, false),
                ],
                &args,
            ),
            "create_milestone",
        );
        self.assert_status(s, 0);
        let before = self.token_amount(self.sponsor_ata);
        let meta = self.execute(
            self.sponsor,
            instruction(
                "fund_milestone",
                &[
                    (self.sponsor, true, true),
                    (self.internship, false, false),
                    (s.milestone, false, true),
                    (MINT, false, false),
                    (self.sponsor_ata, false, true),
                    (s.vault, false, true),
                    (s.authority, false, false),
                    (TOKEN, false, false),
                    (system_program::ID, false, false),
                ],
                &[],
            ),
            "fund_milestone",
        );
        assert_token_cpis(&meta, 1, 0);
        self.assert_status(s, FUNDED);
        assert_eq!(self.token_amount(s.vault), REWARD);
        assert_eq!(self.token_amount(self.sponsor_ata), before - REWARD);
        assert_eq!(&self.account(s.vault).data[32..64], s.authority.as_ref());
        self.assert_conserved();
    }

    /// Executes sponsor assignment with the approved read-only signer meta.
    pub fn assign(&mut self, s: &Scope) {
        self.execute(
            self.sponsor,
            instruction(
                "assign_student",
                &[
                    (self.sponsor, true, false),
                    (self.internship, false, false),
                    (s.milestone, false, true),
                ],
                self.student.as_ref(),
            ),
            "assign_student",
        );
        self.assert_status(s, ASSIGNED);
        assert_eq!(
            &self.account(s.milestone).data[72..104],
            self.student.as_ref()
        );
    }

    /// Executes student submission and designated-verifier attestation at explicit valid times.
    pub fn submit_and_attest(&mut self, s: &Scope) {
        self.set_time(NOW + 10);
        self.execute(
            self.student,
            instruction(
                "submit_milestone",
                &[
                    (self.student, true, true),
                    (self.internship, false, false),
                    (s.milestone, false, true),
                    (s.submission, false, true),
                    (system_program::ID, false, false),
                ],
                &EVIDENCE,
            ),
            "submit_milestone",
        );
        self.assert_status(s, 3);
        let mut expected = SUBMISSION_DISC.to_vec();
        expected.extend_from_slice(s.milestone.as_ref());
        expected.extend_from_slice(self.student.as_ref());
        expected.extend_from_slice(&EVIDENCE);
        expected.extend_from_slice(&(NOW + 10).to_le_bytes());
        expected.push(s.submission_bump);
        assert_eq!(
            self.program_account(s.submission, 113, SUBMISSION_DISC)
                .data,
            expected
        );
        self.set_time(NOW + 20);
        let mut args = self.student.as_ref().to_vec();
        args.extend_from_slice(&REQUIREMENTS);
        args.extend_from_slice(&EVIDENCE);
        self.execute(
            self.verifier,
            instruction(
                "attest_milestone",
                &[
                    (self.verifier, true, false),
                    (self.internship, false, false),
                    (s.milestone, false, true),
                    (s.submission, false, false),
                ],
                &args,
            ),
            "attest_milestone",
        );
        self.assert_status(s, VERIFIED);
        let state = self.account(s.milestone);
        assert_eq!(&state.data[168..200], s.submission.as_ref());
        assert_eq!(&state.data[264..272], &(NOW + 20).to_le_bytes());
    }

    /// Adds unsolicited surplus through a real classic SPL checked transfer, never by editing balances.
    pub fn donate_surplus(&mut self, s: &Scope) {
        let mut data = vec![12];
        data.extend_from_slice(&SURPLUS.to_le_bytes());
        data.push(DECIMALS);
        let meta = self.execute(
            self.sponsor,
            Instruction {
                program_id: TOKEN,
                accounts: vec![
                    AccountMeta::new(self.sponsor_ata, false),
                    AccountMeta::new_readonly(MINT, false),
                    AccountMeta::new(s.vault, false),
                    AccountMeta::new_readonly(self.sponsor, true),
                ],
                data,
            },
            "unsolicited surplus transfer",
        );
        assert!(meta
            .logs
            .iter()
            .any(|l| l == "Program log: Instruction: TransferChecked"));
        assert_eq!(self.token_amount(s.vault), REWARD + SURPLUS);
        self.assert_conserved();
    }

    /// Executes permissionless settlement with only caller as a signer and payer.
    pub fn settle(&mut self, s: &Scope) -> TransactionMetadata {
        self.execute(
            self.caller,
            instruction(
                "settle_milestone",
                &[
                    (self.caller, true, true),
                    (self.internship, false, false),
                    (s.milestone, false, true),
                    (s.submission, false, false),
                    (s.completion, false, true),
                    (MINT, false, false),
                    (s.vault, false, true),
                    (s.authority, false, false),
                    (self.student_ata, false, true),
                    (self.sponsor_ata, false, true),
                    (self.sponsor, false, true),
                    (TOKEN, false, false),
                    (system_program::ID, false, false),
                ],
                &[],
            ),
            "settle_milestone",
        )
    }

    /// Executes refund with exactly the recorded sponsor signer and approved eight-account order.
    pub fn refund(&mut self, s: &Scope) -> TransactionMetadata {
        self.execute(
            self.sponsor,
            instruction(
                "refund_unclaimed_milestone",
                &[
                    (self.sponsor, true, true),
                    (self.internship, false, false),
                    (s.milestone, false, true),
                    (MINT, false, false),
                    (s.vault, false, true),
                    (s.authority, false, false),
                    (self.sponsor_ata, false, true),
                    (TOKEN, false, false),
                ],
                &[],
            ),
            "refund_unclaimed_milestone",
        )
    }

    /// Reads committed account state; never restores or mutates a snapshot.
    pub fn account(&self, key: Address) -> Account {
        self.svm.get_account(&key).expect("expected account exists")
    }

    /// Validates owner, discriminator, allocation and rent on a program-owned account.
    pub fn program_account(&self, key: Address, size: usize, disc: [u8; 8]) -> Account {
        let a = self.account(key);
        assert_eq!(a.owner, PROGRAM_ID);
        assert!(!a.executable);
        assert_eq!(a.data.len(), size);
        assert_eq!(&a.data[..8], &disc);
        assert_eq!(
            a.lamports,
            self.svm.minimum_balance_for_rent_exemption(size)
        );
        a
    }

    /// Checks immutable Milestone layout fields and stored canonical bumps on each lifecycle transition.
    pub fn assert_status(&self, s: &Scope, status: u8) {
        let a = self.program_account(s.milestone, 276, MILESTONE_DISC);
        for (range, key) in [
            (8..40, self.internship),
            (40..72, self.sponsor),
            (104..136, self.verifier),
            (136..168, MINT),
        ] {
            assert_eq!(&a.data[range], key.as_ref());
        }
        assert_eq!(&a.data[200..232], &REQUIREMENTS);
        assert_eq!(&a.data[232..240], &s.id.to_le_bytes());
        assert_eq!(&a.data[240..248], &REWARD.to_le_bytes());
        assert_eq!(&a.data[248..256], &ASSIGN_BY.to_le_bytes());
        assert_eq!(&a.data[256..264], &SUBMIT_BY.to_le_bytes());
        assert_eq!(a.data[272], status);
        assert_eq!(&a.data[273..276], &[s.bump, s.vault_bump, s.authority_bump]);
    }

    /// Reads initialized classic token-account balances and rejects custody properties not used by fixtures.
    pub fn token_amount(&self, key: Address) -> u64 {
        let a = self.account(key);
        assert_eq!(a.owner, TOKEN);
        assert!(!a.executable);
        assert_eq!(a.data.len(), 165);
        assert_eq!(&a.data[..32], MINT.as_ref());
        assert_eq!(a.data[108], 1);
        for r in [72..76, 109..113, 129..133] {
            assert_eq!(&a.data[r], &[0; 4]);
        }
        assert_eq!(&a.data[121..129], &[0; 8]);
        u64::from_le_bytes(a.data[64..72].try_into().unwrap())
    }

    /// Checks mint invariants and conservation over every local classic token account for DEMO.
    pub fn assert_conserved(&self) {
        let mint = self.account(MINT);
        assert_eq!(mint.owner, TOKEN);
        assert_eq!(mint.data.len(), 82);
        assert_eq!(&mint.data[..4], &1u32.to_le_bytes());
        assert_eq!(&mint.data[4..36], self.sponsor.as_ref());
        assert_eq!(mint.data[44], DECIMALS);
        assert_eq!(mint.data[45], 1);
        assert_eq!(&mint.data[46..50], &[0; 4]);
        let supply = u64::from_le_bytes(mint.data[36..44].try_into().unwrap());
        assert_eq!(supply, INITIAL_SUPPLY);
        let total: u128 = self
            .svm
            .get_program_accounts(&TOKEN)
            .iter()
            .filter(|(_, a)| a.data.len() == 165 && &a.data[..32] == MINT.as_ref())
            .map(|(_, a)| u64::from_le_bytes(a.data[64..72].try_into().unwrap()) as u128)
            .sum();
        assert_eq!(total, u128::from(supply));
    }

    /// Captures unrelated accounts for read-only equality assertions, including absent PDAs.
    pub fn snapshot(&self, keys: &[Address]) -> Vec<(Address, Option<Account>)> {
        keys.iter()
            .map(|&k| (k, self.svm.get_account(&k)))
            .collect()
    }

    /// Asserts isolation without writing state back into the VM.
    pub fn assert_unchanged(&self, snapshot: &[(Address, Option<Account>)]) {
        for (k, a) in snapshot {
            assert_eq!(&self.svm.get_account(k), a, "unexpected change to {k}");
        }
    }
}

/// Proves real token CPI log paths, including checked transfers and closure, when a test is executed.
pub fn assert_token_cpis(meta: &TransactionMetadata, transfers: usize, closes: usize) {
    assert_eq!(
        meta.logs
            .iter()
            .filter(|l| l.as_str() == "Program log: Instruction: TransferChecked")
            .count(),
        transfers
    );
    assert_eq!(
        meta.logs
            .iter()
            .filter(|l| l.as_str() == "Program log: Instruction: CloseAccount")
            .count(),
        closes
    );
    // Funding additionally invokes token-account initialization; named transfer/close counts stay exact.
    assert!(
        meta.logs
            .iter()
            .filter(|l| *l == &format!("Program {TOKEN} invoke [2]"))
            .count()
            >= transfers + closes
    );
}
