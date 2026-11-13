//! Settlement through the generated Anchor entrypoint and real native classic SPL Token processor.
//! PDA signer privileges are derived and checked locally, not supplied as mocked CPI success.
//! Clock/rent, System account creation, privileges and transaction rollback are modeled locally.
//! This is not SBF VM execution or a signed Solana transaction test.

use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::Instruction,
        program_error::{ProgramError, ProgramResult},
        system_program,
    },
    solana_program::{program_option::COption, program_pack::Pack},
    InstructionData,
};
use proof_of_work::{
    config::{DEMO_DECIMALS, DEMO_MINT},
    errors::ProofOfWorkError,
    instruction,
    seeds::{INTERNSHIP_SEED, MILESTONE_SEED, SUBMISSION_SEED},
    state::{CompletionRecord, Internship, Milestone, MilestoneStatus, Submission},
    ID,
};
use solana_sysvar::program_stubs::{set_syscall_stubs, SyscallStubs};
use std::sync::{
    atomic::{AtomicI64, AtomicU64, AtomicU8, Ordering},
    Mutex, MutexGuard,
};

static HOST_LOCK: Mutex<()> = Mutex::new(());
static NOW: AtomicI64 = AtomicI64::new(100);
static FAULT: AtomicU8 = AtomicU8::new(0);
static TRANSFERS: AtomicU8 = AtomicU8::new(0);
static TRANSFER_AMOUNT: AtomicU64 = AtomicU64::new(0);

struct HostStubs;

impl SyscallStubs for HostStubs {
    fn sol_get_clock_sysvar(&self, address: *mut u8) -> u64 {
        let clock = Clock {
            unix_timestamp: NOW.load(Ordering::SeqCst),
            ..Clock::default()
        };
        // The sysvar ABI supplies an aligned, writable Clock-sized buffer.
        unsafe {
            (address as *mut Clock).write(clock);
        }
        0
    }

    fn sol_get_rent_sysvar(&self, address: *mut u8) -> u64 {
        // The sysvar ABI supplies an aligned, writable Rent-sized buffer.
        unsafe {
            (address as *mut Rent).write(Rent::default());
        }
        0
    }

    /// Models fresh System account creation, checking payer privileges, PDA seeds, space and rent balance.
    /// Rejects unsupported CPIs or existing accounts; this stub does not execute the SBF runtime.
    fn sol_invoke_signed(
        &self,
        instruction: &Instruction,
        accounts: &[AccountInfo],
        seeds: &[&[&[u8]]],
    ) -> ProgramResult {
        if instruction.program_id == spl_token::ID {
            // Reproduce invoke_signed signer elevation only for valid PDAs under our caller program.
            let derived: Vec<_> = seeds
                .iter()
                .map(|s| Pubkey::create_program_address(s, &ID))
                .collect::<std::result::Result<_, _>>()
                .map_err(|_| ProgramError::InvalidSeeds)?;
            let mut effective = Vec::new();
            for meta in &instruction.accounts {
                let original = accounts
                    .iter()
                    .find(|a| *a.key == meta.pubkey)
                    .ok_or(ProgramError::NotEnoughAccountKeys)?;
                let signed = original.is_signer || derived.contains(original.key);
                if (meta.is_signer && !signed) || (meta.is_writable && !original.is_writable) {
                    return Err(ProgramError::MissingRequiredSignature);
                }
                let mut account = original.clone();
                account.is_signer = meta.is_signer && signed;
                account.is_writable = meta.is_writable;
                effective.push(account);
            }
            let kind = spl_token::instruction::TokenInstruction::unpack(&instruction.data)?;
            let stage = match kind {
                spl_token::instruction::TokenInstruction::TransferChecked { amount, decimals } => {
                    if decimals != DEMO_DECIMALS {
                        return Err(ProgramError::InvalidInstructionData);
                    }
                    TRANSFER_AMOUNT.store(amount, Ordering::SeqCst);
                    TRANSFERS.fetch_add(1, Ordering::SeqCst) + 1
                }
                spl_token::instruction::TokenInstruction::CloseAccount => 3,
                spl_token::instruction::TokenInstruction::InitializeAccount3 { .. } => 0,
                _ => return Err(ProgramError::InvalidInstructionData),
            };
            if stage > 0 && FAULT.load(Ordering::SeqCst) == stage {
                return Err(ProgramError::Custom(9000 + stage as u32));
            }
            spl_token::processor::Processor::process(
                &spl_token::ID,
                &effective,
                &instruction.data,
            )?;
            if stage == 1 && FAULT.load(Ordering::SeqCst) == 4 {
                // Impossible under the honest token program: test the handler's zero-balance guard.
                let mut vault = TokenAccount::unpack(&effective[0].try_borrow_data()?)?;
                vault.amount += 1;
                TokenAccount::pack(vault, &mut effective[0].try_borrow_mut_data()?)?;
            }
            return Ok(());
        }
        // Model only fresh System account creation; the SPL processor above performs real token logic.
        // The destination buffer is preallocated by the host fixture.
        if instruction.program_id != system_program::ID
            || instruction.data.len() != 52
            || instruction.data[..4] != [0, 0, 0, 0]
            || accounts.len() < 2
        {
            return Err(ProgramError::InvalidInstructionData);
        }
        let payer = &accounts[0];
        let destination = &accounts[1];
        let lamports = u64::from_le_bytes(instruction.data[4..12].try_into().unwrap());
        let space = u64::from_le_bytes(instruction.data[12..20].try_into().unwrap());
        let owner = Pubkey::new_from_array(instruction.data[20..52].try_into().unwrap());
        let derived = seeds.iter().any(|seed| {
            Pubkey::create_program_address(seed, &ID).ok().as_ref() == Some(destination.key)
        });
        if !payer.is_signer || !payer.is_writable || !destination.is_writable || !derived {
            return Err(ProgramError::MissingRequiredSignature);
        }
        if destination.owner != &system_program::ID
            || destination.lamports() != 0
            || destination.data_len() as u64 != space
            || destination.try_borrow_data()?.iter().any(|byte| *byte != 0)
            || (owner != ID && owner != spl_token::ID)
        {
            return Err(ProgramError::AccountAlreadyInitialized);
        }
        let remainder = payer
            .lamports()
            .checked_sub(lamports)
            .ok_or(ProgramError::InsufficientFunds)?;
        **payer.try_borrow_mut_lamports()? = remainder;
        **destination.try_borrow_mut_lamports()? = lamports;
        destination.assign(&owner);
        Ok(())
    }
}

struct Environment {
    previous: Option<Box<dyn SyscallStubs>>,
    _lock: MutexGuard<'static, ()>,
}

impl Environment {
    fn new() -> Self {
        let lock = HOST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        NOW.store(100, Ordering::SeqCst);
        FAULT.store(0, Ordering::SeqCst);
        TRANSFERS.store(0, Ordering::SeqCst);
        TRANSFER_AMOUNT.store(0, Ordering::SeqCst);
        Self {
            previous: Some(set_syscall_stubs(Box::new(HostStubs))),
            _lock: lock,
        }
    }
}

impl Drop for Environment {
    fn drop(&mut self) {
        set_syscall_stubs(self.previous.take().unwrap());
    }
}

/// Builds a native public-account fixture, leaving fresh zeroed data accounts unfunded for init tests.
fn info(
    key: Pubkey,
    owner: Pubkey,
    signer: bool,
    writable: bool,
    data: Vec<u8>,
    executable: bool,
) -> AccountInfo<'static> {
    AccountInfo::new(
        Box::leak(Box::new(key)),
        signer,
        writable,
        Box::leak(Box::new(
            if data.iter().all(|b| *b == 0) && !data.is_empty() {
                0
            } else {
                10_000_000
            },
        )),
        Box::leak(data.into_boxed_slice()),
        Box::leak(Box::new(owner)),
        executable,
    )
}

fn store<T: AccountSerialize>(account: &AccountInfo, value: &T) {
    value
        .try_serialize(&mut &mut account.try_borrow_mut_data().unwrap()[..])
        .unwrap();
}

fn load<T: AccountDeserialize>(account: &AccountInfo) -> T {
    T::try_deserialize(&mut &account.try_borrow_data().unwrap()[..]).unwrap()
}

/// Finds a deterministic nonzero on-curve public key without creating signing credentials.
fn public_key(seed: u8) -> Pubkey {
    // Deterministic public-only on-curve test fixture. No signing key is generated.
    (seed..=255)
        .map(|byte| Pubkey::new_from_array([byte; 32]))
        .find(|key| key.is_on_curve() && *key != Pubkey::default())
        .unwrap()
}

use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use spl_token::state::{Account as TokenAccount, AccountState, Mint};
/// Invokes the generated Anchor entrypoint and restores account snapshots on failure.
/// Rollback is modeled by this host harness, not verified against a Solana bank runtime.
fn execute(accounts: Vec<AccountInfo<'static>>, data: Vec<u8>) -> ProgramResult {
    let snapshots: Vec<_> = accounts
        .iter()
        .map(|a| {
            (
                a.owner.to_owned(),
                a.lamports(),
                a.try_borrow_data().unwrap().to_vec(),
            )
        })
        .collect();
    let accounts = Box::leak(accounts.into_boxed_slice());
    let data = Box::leak(data.into_boxed_slice());
    let result = proof_of_work::entry(&ID, accounts, data);
    // Model transaction rollback explicitly. The host entry point alone has no bank runtime.
    if result.is_err() {
        for (account, (owner, lamports, bytes)) in accounts.iter().zip(snapshots) {
            account.assign(&owner);
            **account.try_borrow_mut_lamports().unwrap() = lamports;
            account
                .try_borrow_mut_data()
                .unwrap()
                .copy_from_slice(&bytes);
        }
    }
    result
}

fn error(result: ProgramResult, expected: ProofOfWorkError) {
    assert_eq!(result, Err(ProgramError::Custom(u32::from(expected))));
}

struct Funding {
    sponsor: AccountInfo<'static>,
    internship: AccountInfo<'static>,
    milestone: AccountInfo<'static>,
    mint: AccountInfo<'static>,
    source: AccountInfo<'static>,
    vault: AccountInfo<'static>,
    authority: AccountInfo<'static>,
    token: AccountInfo<'static>,
    system: AccountInfo<'static>,
}
impl Funding {
    /// Creates real program state through both existing creation instructions, without wallets or token minting.
    fn new(id: u64) -> Self {
        let sponsor = public_key(1);
        let internship = Pubkey::find_program_address(
            &[INTERNSHIP_SEED, sponsor.as_ref(), &1u64.to_le_bytes()],
            &ID,
        )
        .0;
        let milestone = Pubkey::find_program_address(
            &[MILESTONE_SEED, internship.as_ref(), &id.to_le_bytes()],
            &ID,
        )
        .0;
        let vault = Pubkey::find_program_address(&[b"vault", milestone.as_ref()], &ID).0;
        let authority =
            Pubkey::find_program_address(&[b"vault_authority", milestone.as_ref()], &ID).0;
        let source =
            get_associated_token_address_with_program_id(&sponsor, &DEMO_MINT, &spl_token::ID);
        let mut mint = vec![0; Mint::LEN];
        Mint::pack(
            Mint {
                mint_authority: COption::None,
                supply: 1000,
                decimals: DEMO_DECIMALS,
                is_initialized: true,
                freeze_authority: COption::None,
            },
            &mut mint,
        )
        .unwrap();
        let mut source_data = vec![0; TokenAccount::LEN];
        TokenAccount::pack(
            TokenAccount {
                mint: DEMO_MINT,
                owner: sponsor,
                amount: 1000,
                delegate: COption::None,
                state: AccountState::Initialized,
                is_native: COption::None,
                delegated_amount: 0,
                close_authority: COption::None,
            },
            &mut source_data,
        )
        .unwrap();
        let f = Self {
            sponsor: info(sponsor, system_program::ID, true, true, vec![], false),
            internship: info(
                internship,
                system_program::ID,
                false,
                true,
                vec![0; Internship::SPACE],
                false,
            ),
            milestone: info(
                milestone,
                system_program::ID,
                false,
                true,
                vec![0; Milestone::SPACE],
                false,
            ),
            mint: info(DEMO_MINT, spl_token::ID, false, false, mint, false),
            source: info(source, spl_token::ID, false, true, source_data, false),
            vault: info(
                vault,
                system_program::ID,
                false,
                true,
                vec![0; TokenAccount::LEN],
                false,
            ),
            authority: info(authority, system_program::ID, false, false, vec![], false),
            token: info(
                spl_token::ID,
                system_program::ID,
                false,
                false,
                vec![],
                true,
            ),
            system: info(
                system_program::ID,
                system_program::ID,
                false,
                false,
                vec![],
                true,
            ),
        };
        execute(
            vec![f.sponsor.clone(), f.internship.clone(), f.system.clone()],
            instruction::CreateInternship { internship_id: 1 }.data(),
        )
        .unwrap();
        execute(
            vec![
                f.sponsor.clone(),
                f.internship.clone(),
                f.milestone.clone(),
                f.mint.clone(),
                f.token.clone(),
                f.system.clone(),
            ],
            instruction::CreateMilestone {
                milestone_id: id,
                reward_amount: 100,
                requirements_hash: [5; 32],
                assign_by: 200,
                submit_by: 300,
                verifier: public_key(140),
            }
            .data(),
        )
        .unwrap();
        f
    }
    /// Executes the approved nine-account, no-argument funding interface through Anchor validation.
    fn fund(&self) -> ProgramResult {
        execute(self.accounts(), instruction::FundMilestone {}.data())
    }
    fn accounts(&self) -> Vec<AccountInfo<'static>> {
        vec![
            self.sponsor.clone(),
            self.internship.clone(),
            self.milestone.clone(),
            self.mint.clone(),
            self.source.clone(),
            self.vault.clone(),
            self.authority.clone(),
            self.token.clone(),
            self.system.clone(),
        ]
    }
    fn milestone_state(&self, change: impl FnOnce(&mut Milestone)) {
        let mut m: Milestone = load(&self.milestone);
        change(&mut m);
        store(&self.milestone, &m);
    }
}

struct Settlement {
    funding: Funding,
    caller: AccountInfo<'static>,
    submission: AccountInfo<'static>,
    completion: AccountInfo<'static>,
    student_ata: AccountInfo<'static>,
}

fn token_info(owner: Pubkey, amount: u64) -> AccountInfo<'static> {
    let key = get_associated_token_address_with_program_id(&owner, &DEMO_MINT, &spl_token::ID);
    let mut bytes = vec![0; TokenAccount::LEN];
    TokenAccount::pack(
        TokenAccount {
            mint: DEMO_MINT,
            owner,
            amount,
            delegate: COption::None,
            state: AccountState::Initialized,
            is_native: COption::None,
            delegated_amount: 0,
            close_authority: COption::None,
        },
        &mut bytes,
    )
    .unwrap();
    info(key, spl_token::ID, false, true, bytes, false)
}
fn change_token(account: &AccountInfo, change: impl FnOnce(&mut TokenAccount)) {
    let mut token = TokenAccount::unpack(&account.try_borrow_data().unwrap()).unwrap();
    change(&mut token);
    TokenAccount::pack(token, &mut account.try_borrow_mut_data().unwrap()).unwrap();
}
fn balance(account: &AccountInfo) -> u64 {
    TokenAccount::unpack(&account.try_borrow_data().unwrap())
        .unwrap()
        .amount
}

impl Settlement {
    /// Build verified state through all six actual handlers, not a synthetic Verified flag.
    fn new(id: u64) -> Self {
        NOW.store(100, Ordering::SeqCst);
        let mut funding = Funding::new(id);
        funding.fund().unwrap();
        let student = info(
            public_key(70),
            system_program::ID,
            true,
            true,
            vec![],
            false,
        );
        execute(
            vec![
                funding.sponsor.clone(),
                funding.internship.clone(),
                funding.milestone.clone(),
            ],
            instruction::AssignStudent {
                student: *student.key,
            }
            .data(),
        )
        .unwrap();
        let submission_key =
            Pubkey::find_program_address(&[SUBMISSION_SEED, funding.milestone.key.as_ref()], &ID).0;
        let mut submission = info(
            submission_key,
            system_program::ID,
            false,
            true,
            vec![0; Submission::SPACE],
            false,
        );
        NOW.store(299, Ordering::SeqCst);
        execute(
            vec![
                student.clone(),
                funding.internship.clone(),
                funding.milestone.clone(),
                submission.clone(),
                funding.system.clone(),
            ],
            instruction::SubmitMilestone {
                evidence_hash: [9; 32],
            }
            .data(),
        )
        .unwrap();
        let verifier = info(
            public_key(140),
            system_program::ID,
            true,
            false,
            vec![],
            false,
        );
        NOW.store(400, Ordering::SeqCst);
        execute(
            vec![
                verifier,
                funding.internship.clone(),
                funding.milestone.clone(),
                submission.clone(),
            ],
            instruction::AttestMilestone {
                expected_student: *student.key,
                expected_requirements_hash: [5; 32],
                expected_evidence_hash: [9; 32],
            }
            .data(),
        )
        .unwrap();
        // Exact outer instruction privileges: settlement has only one signer, the unrelated caller.
        funding.sponsor.is_signer = false;
        funding.internship.is_writable = false;
        submission.is_writable = false;
        assert!(!funding.authority.is_signer);
        TRANSFERS.store(0, Ordering::SeqCst);
        let completion_key =
            Pubkey::find_program_address(&[b"completion", funding.milestone.key.as_ref()], &ID).0;
        Self {
            funding,
            caller: info(
                public_key(210),
                system_program::ID,
                true,
                true,
                vec![],
                false,
            ),
            submission,
            completion: info(
                completion_key,
                system_program::ID,
                false,
                true,
                vec![0; CompletionRecord::SPACE],
                false,
            ),
            student_ata: token_info(*student.key, 0),
        }
    }
    fn accounts(&self) -> Vec<AccountInfo<'static>> {
        let f = &self.funding;
        vec![
            self.caller.clone(),
            f.internship.clone(),
            f.milestone.clone(),
            self.submission.clone(),
            self.completion.clone(),
            f.mint.clone(),
            f.vault.clone(),
            f.authority.clone(),
            self.student_ata.clone(),
            f.source.clone(),
            f.sponsor.clone(),
            f.token.clone(),
            f.system.clone(),
        ]
    }
    fn settle(&self) -> ProgramResult {
        execute(self.accounts(), instruction::SettleMilestone {}.data())
    }
    fn snapshot(&self) -> Vec<(Pubkey, u64, Vec<u8>)> {
        self.accounts()
            .iter()
            .map(|a| {
                (
                    *a.owner,
                    a.lamports(),
                    a.try_borrow_data().unwrap().to_vec(),
                )
            })
            .collect()
    }
    fn reject(&self) -> ProgramResult {
        let before = self.snapshot();
        let result = self.settle();
        assert!(result.is_err(), "expected settlement rejection");
        assert_eq!(
            self.snapshot(),
            before,
            "modeled rollback must restore every account"
        );
        result
    }
    fn change_submission(&self, change: impl FnOnce(&mut Submission)) {
        let mut submission: Submission = load(&self.submission);
        change(&mut submission);
        store(&self.submission, &submission);
    }
}

#[test]
fn permissionless_settlement_pays_exact_reward_and_records_all_provenance() {
    let _env = Environment::new();
    let s = Settlement::new(2);
    let before = s.snapshot();
    let caller_lamports = s.caller.lamports();
    let sponsor_lamports = s.funding.sponsor.lamports();
    let vault_lamports = s.funding.vault.lamports();
    let mint = s.funding.mint.try_borrow_data().unwrap().to_vec();
    s.settle().unwrap();
    assert_eq!(balance(&s.student_ata), 100);
    assert_eq!(balance(&s.funding.source), 900);
    assert_eq!(TRANSFERS.load(Ordering::SeqCst), 1);
    assert_eq!(s.funding.vault.lamports(), 0);
    assert_eq!(*s.funding.vault.owner, system_program::ID);
    assert!(s
        .funding
        .vault
        .try_borrow_data()
        .unwrap()
        .iter()
        .all(|b| *b == 0));
    assert_eq!(
        s.funding.sponsor.lamports(),
        sponsor_lamports + vault_lamports
    );
    assert_eq!(
        caller_lamports - s.caller.lamports(),
        Rent::default().minimum_balance(CompletionRecord::SPACE)
    );
    assert_eq!(*s.completion.owner, ID);
    assert_eq!(s.completion.data_len(), CompletionRecord::SPACE);
    let m: Milestone = load(&s.funding.milestone);
    assert_eq!(m.status, MilestoneStatus::Settled);
    let record: CompletionRecord = load(&s.completion);
    assert_eq!(
        record,
        CompletionRecord {
            milestone: *s.funding.milestone.key,
            student: public_key(70),
            sponsor: *s.funding.sponsor.key,
            verifier: public_key(140),
            submission: *s.submission.key,
            requirements_hash: [5; 32],
            evidence_hash: [9; 32],
            verified_at: 400,
            settled_at: 400,
            bump: Pubkey::find_program_address(
                &[b"completion", s.funding.milestone.key.as_ref()],
                &ID
            )
            .1,
        }
    );
    assert_eq!(
        s.submission.try_borrow_data().unwrap().to_vec(),
        before[3].2
    );
    assert_eq!(
        s.funding.internship.try_borrow_data().unwrap().to_vec(),
        before[1].2
    );
    assert_eq!(s.funding.mint.try_borrow_data().unwrap().to_vec(), mint);
    assert!(!s.funding.sponsor.is_signer);
    assert!(!s.funding.authority.is_signer);
}

#[test]
fn unsolicited_surplus_goes_only_to_sponsor_and_supply_is_conserved() {
    let _env = Environment::new();
    let s = Settlement::new(2);
    // A separate token holder donates by executing the actual token processor.
    let donor = token_info(public_key(220), 35);
    let mut mint = Mint::unpack(&s.funding.mint.try_borrow_data().unwrap()).unwrap();
    mint.supply = 1035; // Account for the donor tokens in the public-only fixture.
    Mint::pack(mint, &mut s.funding.mint.try_borrow_mut_data().unwrap()).unwrap();
    let signer = info(
        public_key(220),
        system_program::ID,
        true,
        false,
        vec![],
        false,
    );
    let transfer = spl_token::instruction::transfer_checked(
        &spl_token::ID,
        donor.key,
        s.funding.mint.key,
        s.funding.vault.key,
        signer.key,
        &[],
        35,
        DEMO_DECIMALS,
    )
    .unwrap();
    spl_token::processor::Processor::process(
        &spl_token::ID,
        &[
            donor.clone(),
            s.funding.mint.clone(),
            s.funding.vault.clone(),
            signer,
        ],
        &transfer.data,
    )
    .unwrap();
    let mint_before = s.funding.mint.try_borrow_data().unwrap().to_vec();
    s.settle().unwrap();
    assert_eq!(balance(&donor), 0);
    assert_eq!(balance(&s.student_ata), 100);
    assert_eq!(balance(&s.funding.source), 935);
    assert_eq!(TRANSFER_AMOUNT.load(Ordering::SeqCst), 35);
    assert_eq!(TRANSFERS.load(Ordering::SeqCst), 2);
    assert_eq!(
        s.funding.mint.try_borrow_data().unwrap().to_vec(),
        mint_before
    );
}

#[test]
fn settlement_rejects_every_other_state() {
    let _env = Environment::new();
    for status in [
        MilestoneStatus::Created,
        MilestoneStatus::Funded,
        MilestoneStatus::Assigned,
        MilestoneStatus::Submitted,
        MilestoneStatus::Settled,
        MilestoneStatus::Refunded,
    ] {
        let s = Settlement::new(2);
        s.funding.milestone_state(|m| m.status = status);
        error(s.reject(), ProofOfWorkError::InvalidState);
    }
}

#[test]
fn student_canonical_destination_and_all_authorities_mints_and_rent_recipient_are_mandatory() {
    let _env = Environment::new();
    for kind in 0..11 {
        let mut s = Settlement::new(2);
        match kind {
            0 => s.student_ata = token_info(public_key(220), 0),
            1 => s.funding.source = token_info(public_key(220), 0),
            2 => change_token(&s.student_ata, |t| t.owner = public_key(220)),
            3 => change_token(&s.funding.source, |t| t.owner = public_key(220)),
            4 => change_token(&s.student_ata, |t| t.mint = public_key(220)),
            5 => change_token(&s.funding.source, |t| t.mint = public_key(220)),
            6 => s.student_ata.assign(&system_program::ID),
            7 => s.funding.source.assign(&system_program::ID),
            8 => s.funding.sponsor = s.caller.clone(),
            9 => s.student_ata = s.funding.vault.clone(),
            10 => s.funding.source = s.funding.vault.clone(),
            _ => unreachable!(),
        }
        let _ = s.reject();
    }
}

#[test]
fn vault_address_authority_bumps_and_security_properties_are_enforced() {
    let _env = Environment::new();
    for kind in 0..11 {
        let mut s = Settlement::new(2);
        match kind {
            0 => s.funding.vault = token_info(public_key(220), 100),
            1 => {
                s.funding.authority = info(
                    public_key(220),
                    system_program::ID,
                    false,
                    false,
                    vec![],
                    false,
                )
            }
            2 => s
                .funding
                .milestone_state(|m| m.vault_bump = m.vault_bump.wrapping_sub(1)),
            3 => s.funding.milestone_state(|m| {
                m.vault_authority_bump = m.vault_authority_bump.wrapping_sub(1)
            }),
            4 => s.funding.vault.assign(&system_program::ID),
            5 => change_token(&s.funding.vault, |t| t.owner = public_key(220)),
            6 => change_token(&s.funding.vault, |t| t.mint = public_key(220)),
            7 => change_token(&s.funding.vault, |t| {
                t.delegate = COption::Some(public_key(220))
            }),
            8 => change_token(&s.funding.vault, |t| {
                t.close_authority = COption::Some(*s.funding.authority.key)
            }),
            9 => change_token(&s.funding.vault, |t| t.is_native = COption::Some(1)),
            10 => change_token(&s.funding.vault, |t| t.state = AccountState::Frozen),
            _ => unreachable!(),
        }
        let _ = s.reject();
    }
}

#[test]
fn parent_child_submission_pdas_owners_and_stored_bindings_are_checked() {
    let _env = Environment::new();
    for kind in 0..13 {
        let mut s = Settlement::new(2);
        match kind {
            0 => s.funding.internship.assign(&system_program::ID),
            1 => s.funding.milestone.assign(&system_program::ID),
            2 => s.submission.assign(&system_program::ID),
            3 => s
                .funding
                .milestone_state(|m| m.internship = public_key(220)),
            4 => s.funding.milestone_state(|m| m.sponsor = public_key(220)),
            5 => s
                .funding
                .milestone_state(|m| m.bump = m.bump.wrapping_sub(1)),
            6 => s
                .funding
                .milestone_state(|m| m.submission = public_key(220)),
            7 => s.change_submission(|t| t.student = public_key(220)),
            8 => s.change_submission(|t| t.milestone = public_key(220)),
            9 => s.change_submission(|t| t.bump = t.bump.wrapping_sub(1)),
            10 => {
                let mut i: Internship = load(&s.funding.internship);
                i.bump = i.bump.wrapping_sub(1);
                store(&s.funding.internship, &i);
            }
            11 => {
                let data = s.submission.try_borrow_data().unwrap().to_vec();
                s.submission = info(public_key(220), ID, false, false, data, false);
            }
            12 => s.submission.try_borrow_mut_data().unwrap()[0] ^= 1,
            _ => unreachable!(),
        }
        let _ = s.reject();
    }
}

#[test]
fn malformed_terms_roles_and_attestation_times_cannot_create_completion() {
    let _env = Environment::new();
    for kind in 0..10 {
        let s = Settlement::new(2);
        match kind {
            0 => s.funding.milestone_state(|m| m.requirements_hash = [0; 32]),
            1 => s.change_submission(|t| t.evidence_hash = [0; 32]),
            2 => s.funding.milestone_state(|m| m.reward_amount = 0),
            3 => s.change_submission(|t| t.submitted_at = 0),
            4 => s.change_submission(|t| t.submitted_at = 300),
            5 => s.change_submission(|t| t.submitted_at = 301),
            6 => s.funding.milestone_state(|m| m.verified_at = 298),
            7 => s.funding.milestone_state(|m| m.assign_by = m.submit_by),
            8 => s.funding.milestone_state(|m| m.verifier = m.sponsor),
            9 => s
                .funding
                .milestone_state(|m| m.verifier = Pubkey::default()),
            _ => unreachable!(),
        }
        let _ = s.reject();
    }
}

#[test]
fn shortfall_and_maximum_raw_amounts_use_exact_principal() {
    let _env = Environment::new();
    let s = Settlement::new(2);
    change_token(&s.funding.vault, |t| t.amount = 99);
    error(s.reject(), ProofOfWorkError::InsufficientEscrow);
    let s = Settlement::new(2);
    s.funding.milestone_state(|m| m.reward_amount = u64::MAX);
    change_token(&s.funding.vault, |t| t.amount = u64::MAX);
    change_token(&s.funding.source, |t| t.amount = 0);
    let mut mint = Mint::unpack(&s.funding.mint.try_borrow_data().unwrap()).unwrap();
    mint.supply = u64::MAX;
    Mint::pack(mint, &mut s.funding.mint.try_borrow_mut_data().unwrap()).unwrap();
    s.settle().unwrap();
    assert_eq!(balance(&s.student_ata), u64::MAX);
}

#[test]
fn settlement_has_no_deadline_and_accepts_equal_verification_and_submission_time() {
    let _env = Environment::new();
    for now in [299, 300, 301, 1_000_000] {
        let s = Settlement::new(2);
        s.funding.milestone_state(|m| m.verified_at = 299);
        NOW.store(now, Ordering::SeqCst);
        s.settle().unwrap();
        assert_eq!(load::<CompletionRecord>(&s.completion).settled_at, now);
    }
}

#[test]
fn repeated_settlement_and_existing_completion_cannot_pay_twice() {
    let _env = Environment::new();
    let s = Settlement::new(2);
    s.settle().unwrap();
    let _ = s.reject();
    assert_eq!(balance(&s.student_ata), 100);
    let s = Settlement::new(2);
    s.completion.assign(&ID);
    **s.completion.try_borrow_mut_lamports().unwrap() =
        Rent::default().minimum_balance(CompletionRecord::SPACE);
    let _ = s.reject();
}

#[test]
fn failed_first_second_transfer_close_and_post_transfer_guard_model_full_rollback() {
    let _env = Environment::new();
    for fault in 1..=4 {
        let s = Settlement::new(2);
        if fault == 2 {
            change_token(&s.funding.vault, |t| t.amount = 135);
        }
        FAULT.store(fault, Ordering::SeqCst);
        let result = s.reject();
        if fault < 4 {
            assert_eq!(result, Err(ProgramError::Custom(9000 + fault as u32)));
        } else {
            error(result, ProofOfWorkError::InvalidVault);
        }
        assert_eq!(
            load::<Milestone>(&s.funding.milestone).status,
            MilestoneStatus::Verified
        );
        assert_eq!(*s.completion.owner, system_program::ID);
        FAULT.store(0, Ordering::SeqCst);
    }
}

#[test]
fn real_token_processor_rejections_after_partial_progress_model_rollback() {
    let _env = Environment::new();
    for kind in 0..4 {
        let s = Settlement::new(2);
        match kind {
            0 => change_token(&s.student_ata, |t| t.state = AccountState::Frozen),
            1 => {
                change_token(&s.funding.vault, |t| t.amount = 135);
                change_token(&s.funding.source, |t| t.amount = u64::MAX);
            }
            2 => change_token(&s.student_ata, |t| t.amount = u64::MAX),
            3 => **s.funding.sponsor.try_borrow_mut_lamports().unwrap() = u64::MAX,
            _ => unreachable!(),
        }
        let result = s.reject();
        let expected = if kind == 0 {
            spl_token::error::TokenError::AccountFrozen
        } else {
            spl_token::error::TokenError::Overflow
        };
        assert_eq!(result, Err(expected.into()));
        if kind == 1 {
            assert_eq!(TRANSFERS.load(Ordering::SeqCst), 2);
        }
        if kind == 3 {
            assert_eq!(TRANSFERS.load(Ordering::SeqCst), 1);
        }
    }
}

#[test]
fn cross_milestone_substitutions_leave_both_escrows_unchanged() {
    let _env = Environment::new();
    for kind in 0..4 {
        let mut s = Settlement::new(2);
        let other = Settlement::new(3);
        let before = other.snapshot();
        match kind {
            0 => s.funding.vault = other.funding.vault.clone(),
            1 => s.funding.authority = other.funding.authority.clone(),
            2 => s.submission = other.submission.clone(),
            3 => s.completion = other.completion.clone(),
            _ => unreachable!(),
        }
        let _ = s.reject();
        assert_eq!(other.snapshot(), before);
    }
}

#[test]
fn mint_program_and_outer_privileges_are_validated() {
    let _env = Environment::new();
    for kind in 0..13 {
        let mut s = Settlement::new(2);
        match kind {
            0 => s.caller.is_signer = false,
            1 => s.caller.is_writable = false,
            2 => s.funding.vault.is_writable = false,
            3 => s.student_ata.is_writable = false,
            4 => s.funding.source.is_writable = false,
            5 => s.funding.sponsor.is_writable = false,
            6 => s.funding.milestone.is_writable = false,
            7 => s
                .funding
                .mint
                .assign(&pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")),
            8 => {
                s.funding.token = info(
                    public_key(220),
                    system_program::ID,
                    false,
                    false,
                    vec![],
                    true,
                )
            }
            9 => s.funding.token.executable = false,
            10 => {
                let mut m = Mint::unpack(&s.funding.mint.try_borrow_data().unwrap()).unwrap();
                m.freeze_authority = COption::Some(public_key(220));
                Mint::pack(m, &mut s.funding.mint.try_borrow_mut_data().unwrap()).unwrap();
            }
            11 => {
                let mut m = Mint::unpack(&s.funding.mint.try_borrow_data().unwrap()).unwrap();
                m.decimals = 9;
                Mint::pack(m, &mut s.funding.mint.try_borrow_mut_data().unwrap()).unwrap();
            }
            12 => s
                .funding
                .milestone_state(|m| m.reward_mint = public_key(220)),
            _ => unreachable!(),
        }
        let _ = s.reject();
    }
}

#[test]
fn host_signer_emulation_rejects_missing_or_wrong_pda_seeds() {
    let _env = Environment::new();
    let s = Settlement::new(2);
    let f = &s.funding;
    let ix = spl_token::instruction::transfer_checked(
        &spl_token::ID,
        f.vault.key,
        f.mint.key,
        s.student_ata.key,
        f.authority.key,
        &[],
        100,
        DEMO_DECIMALS,
    )
    .unwrap();
    let accounts = [
        f.vault.clone(),
        f.mint.clone(),
        s.student_ata.clone(),
        f.authority.clone(),
    ];
    assert!(!accounts[3].is_signer);
    let before = s.snapshot();
    assert!(HostStubs.sol_invoke_signed(&ix, &accounts, &[]).is_err());
    let (_, bump) =
        Pubkey::find_program_address(&[b"vault_authority", public_key(220).as_ref()], &ID);
    let other = public_key(220);
    let bump = [bump];
    assert!(HostStubs
        .sol_invoke_signed(
            &ix,
            &accounts,
            &[&[b"vault_authority", other.as_ref(), &bump]]
        )
        .is_err());
    assert_eq!(s.snapshot(), before);
}

#[test]
fn compiled_settlement_interface_has_exact_approved_order_permissions_and_no_arguments() {
    use anchor_lang::{Discriminator, ToAccountMetas};
    let _env = Environment::new();
    let s = Settlement::new(2);
    let f = &s.funding;
    let metas = proof_of_work::accounts::SettleMilestone {
        caller: *s.caller.key,
        internship: *f.internship.key,
        milestone: *f.milestone.key,
        submission: *s.submission.key,
        completion_record: *s.completion.key,
        reward_mint: *f.mint.key,
        vault: *f.vault.key,
        vault_authority: *f.authority.key,
        student_ata: *s.student_ata.key,
        sponsor_ata: *f.source.key,
        sponsor: *f.sponsor.key,
        token_program: *f.token.key,
        system_program: *f.system.key,
    }
    .to_account_metas(None);
    let writable = [
        true, false, true, false, true, false, true, false, true, true, true, false, false,
    ];
    for (i, (meta, expected)) in metas.iter().zip(s.accounts()).enumerate() {
        assert_eq!(meta.pubkey, *expected.key);
        assert_eq!(meta.is_signer, i == 0);
        assert_eq!(meta.is_writable, writable[i]);
    }
    assert_eq!(metas.len(), 13);
    let bytes = instruction::SettleMilestone {}.data();
    // SHA-256("global:settle_milestone")[..8], independently pinned.
    assert_eq!(bytes, [0, 239, 52, 170, 175, 209, 205, 224]);
    assert_eq!(bytes, instruction::SettleMilestone::DISCRIMINATOR);
}

#[test]
fn completion_payer_space_and_address_failures_never_release_tokens() {
    let _env = Environment::new();
    for kind in 0..4 {
        let mut s = Settlement::new(2);
        match kind {
            0 => **s.caller.try_borrow_mut_lamports().unwrap() = 0,
            1 => s.completion.is_writable = false,
            2 => {
                s.completion = info(
                    public_key(220),
                    system_program::ID,
                    false,
                    true,
                    vec![0; CompletionRecord::SPACE],
                    false,
                )
            }
            3 => {
                s.funding.system = info(
                    public_key(220),
                    system_program::ID,
                    false,
                    false,
                    vec![],
                    true,
                )
            }
            _ => unreachable!(),
        }
        let _ = s.reject();
        assert_eq!(TRANSFERS.load(Ordering::SeqCst), 0);
        assert_eq!(balance(&s.student_ata), 0);
    }
}

#[test]
fn malformed_student_role_is_rejected_even_with_matching_submission_and_ata() {
    let _env = Environment::new();
    for student in [
        Pubkey::default(),
        public_key(1),
        public_key(140),
        Pubkey::find_program_address(&[b"test_student"], &ID).0,
    ] {
        let mut s = Settlement::new(2);
        s.funding.milestone_state(|m| m.student = student);
        s.change_submission(|t| t.student = student);
        s.student_ata = token_info(student, 0);
        let _ = s.reject();
    }
}

/// Initializes real classic SPL storage with sponsor authority; no account keypair is created.
/// Storage/rent are host fixtures: this does not test atomic runtime account provisioning.
fn sponsor_destination(s: &Settlement) -> AccountInfo<'static> {
    let destination = info(
        public_key(230),
        spl_token::ID,
        false,
        true,
        vec![0; TokenAccount::LEN],
        false,
    );
    **destination.try_borrow_mut_lamports().unwrap() =
        Rent::default().minimum_balance(TokenAccount::LEN);
    let ix = spl_token::instruction::initialize_account3(
        &spl_token::ID,
        destination.key,
        s.funding.mint.key,
        s.funding.sponsor.key,
    )
    .unwrap();
    spl_token::processor::Processor::process(
        &spl_token::ID,
        &[destination.clone(), s.funding.mint.clone()],
        &ix.data,
    )
    .unwrap();
    assert_ne!(destination.key, s.funding.source.key);
    assert_eq!(
        TokenAccount::unpack(&destination.try_borrow_data().unwrap())
            .unwrap()
            .owner,
        *s.funding.sponsor.key
    );
    destination
}

/// Donates existing tokens with the real processor, preserving the fixture's supply.
fn donate_from_sponsor(s: &Settlement, amount: u64) {
    if amount == 0 {
        return;
    }
    let mut sponsor = s.funding.sponsor.clone();
    sponsor.is_signer = true; // Native privilege fixture, not a cryptographic signature.
    let ix = spl_token::instruction::transfer_checked(
        &spl_token::ID,
        s.funding.source.key,
        s.funding.mint.key,
        s.funding.vault.key,
        sponsor.key,
        &[],
        amount,
        DEMO_DECIMALS,
    )
    .unwrap();
    spl_token::processor::Processor::process(
        &spl_token::ID,
        &[
            s.funding.source.clone(),
            s.funding.mint.clone(),
            s.funding.vault.clone(),
            sponsor,
        ],
        &ix.data,
    )
    .unwrap();
}

#[test]
fn sponsor_owned_noncanonical_destination_accepts_zero_and_positive_surplus() {
    let _env = Environment::new();
    for surplus in [0, 35] {
        let mut s = Settlement::new(2);
        donate_from_sponsor(&s, surplus);
        let original = s.funding.source.clone();
        let original_bytes = original.try_borrow_data().unwrap().to_vec();
        s.funding.source = sponsor_destination(&s);
        let rent = s.funding.vault.lamports();
        let sponsor_sol = s.funding.sponsor.lamports();
        s.settle().unwrap();
        assert_eq!(balance(&s.student_ata), 100);
        assert_eq!(balance(&s.funding.source), surplus);
        assert_eq!(
            balance(&original) + balance(&s.student_ata) + balance(&s.funding.source),
            1000
        );
        assert_eq!(original.try_borrow_data().unwrap().to_vec(), original_bytes);
        assert_eq!(s.funding.sponsor.lamports(), sponsor_sol + rent);
        assert_eq!(s.funding.vault.lamports(), 0);
        assert_eq!(
            load::<Milestone>(&s.funding.milestone).status,
            MilestoneStatus::Settled
        );
        assert_eq!(
            load::<CompletionRecord>(&s.completion).sponsor,
            *s.funding.sponsor.key
        );
        assert!(!s.funding.sponsor.is_signer);
    }
}

#[test]
fn real_set_authority_blocks_old_ata_but_not_sponsor_owned_fallback() {
    let _env = Environment::new();
    for surplus in [0, 35] {
        let mut s = Settlement::new(2);
        donate_from_sponsor(&s, surplus);
        let original = s.funding.source.clone();
        let mut sponsor = s.funding.sponsor.clone();
        sponsor.is_signer = true;
        let replacement = public_key(220); // Public-only fixture; no private key exists in this test.
        let ix = spl_token::instruction::set_authority(
            &spl_token::ID,
            original.key,
            Some(&replacement),
            spl_token::instruction::AuthorityType::AccountOwner,
            sponsor.key,
            &[],
        )
        .unwrap();
        spl_token::processor::Processor::process(
            &spl_token::ID,
            &[original.clone(), sponsor],
            &ix.data,
        )
        .unwrap();
        assert_eq!(
            TokenAccount::unpack(&original.try_borrow_data().unwrap())
                .unwrap()
                .owner,
            replacement
        );
        error(s.reject(), ProofOfWorkError::InvalidDestination);
        assert_eq!(TRANSFERS.load(Ordering::SeqCst), 0);
        let before = original.try_borrow_data().unwrap().to_vec();
        s.funding.source = sponsor_destination(&s);
        s.settle().unwrap();
        assert_eq!(balance(&s.student_ata), 100);
        assert_eq!(balance(&s.funding.source), surplus);
        assert_eq!(original.try_borrow_data().unwrap().to_vec(), before);
        assert_eq!(
            balance(&original) + balance(&s.student_ata) + balance(&s.funding.source),
            1000
        );
        assert_eq!(s.funding.vault.lamports(), 0);
        assert_eq!(
            load::<Milestone>(&s.funding.milestone).status,
            MilestoneStatus::Settled
        );
        assert_eq!(
            load::<CompletionRecord>(&s.completion).student,
            public_key(70)
        );
        assert!(!s.funding.sponsor.is_signer);
    }
}

#[test]
fn sponsor_destination_must_be_usable_classic_spl_even_without_surplus() {
    let _env = Environment::new();
    for surplus in [0, 35] {
        for kind in 0..8 {
            let mut s = Settlement::new(2);
            donate_from_sponsor(&s, surplus);
            s.funding.source = sponsor_destination(&s);
            match kind {
                0 => change_token(&s.funding.source, |t| t.state = AccountState::Frozen),
                1 => change_token(&s.funding.source, |t| t.state = AccountState::Uninitialized),
                2 => change_token(&s.funding.source, |t| t.is_native = COption::Some(1)),
                3 => change_token(&s.funding.source, |t| t.owner = *s.caller.key),
                4 => change_token(&s.funding.source, |t| t.mint = public_key(220)),
                5 => s
                    .funding
                    .source
                    .assign(&pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")),
                6 => {
                    s.funding.source = info(
                        public_key(230),
                        spl_token::ID,
                        false,
                        true,
                        vec![0; 5],
                        false,
                    )
                }
                7 => s.funding.source = s.student_ata.clone(),
                _ => unreachable!(),
            }
            let _ = s.reject();
            assert_eq!(TRANSFERS.load(Ordering::SeqCst), 0);
            assert_eq!(balance(&s.student_ata), 0);
        }
    }
}

#[test]
fn policy_v2_does_not_relax_funding_or_refund_canonical_ata_rules() {
    let _env = Environment::new();
    let mut f = Funding::new(2);
    let canonical = f.source.clone();
    let bytes = canonical.try_borrow_data().unwrap().to_vec();
    f.source = info(
        public_key(230),
        spl_token::ID,
        false,
        true,
        bytes.clone(),
        false,
    );
    assert!(f.fund().is_err());
    f.source = canonical.clone();
    f.fund().unwrap();
    NOW.store(300, Ordering::SeqCst);
    let refund_accounts = |destination: AccountInfo<'static>| {
        vec![
            f.sponsor.clone(),
            f.internship.clone(),
            f.milestone.clone(),
            f.mint.clone(),
            f.vault.clone(),
            f.authority.clone(),
            destination,
            f.token.clone(),
        ]
    };
    let invalid = info(
        public_key(230),
        spl_token::ID,
        false,
        true,
        canonical.try_borrow_data().unwrap().to_vec(),
        false,
    );
    assert!(execute(
        refund_accounts(invalid),
        instruction::RefundUnclaimedMilestone {}.data()
    )
    .is_err());
    assert_eq!(balance(&f.vault), 100);
    assert_eq!(
        load::<Milestone>(&f.milestone).status,
        MilestoneStatus::Funded
    );
    execute(
        refund_accounts(canonical.clone()),
        instruction::RefundUnclaimedMilestone {}.data(),
    )
    .unwrap();
    assert_eq!(balance(&canonical), 1000);
    assert_eq!(f.vault.lamports(), 0);
    assert_eq!(
        load::<Milestone>(&f.milestone).status,
        MilestoneStatus::Refunded
    );
}
