//! Native host tests of creation through Anchor's generated entry point.
//! Clock/rent and the System Program create-account CPI are modeled locally.
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
    state::{Internship, Milestone, MilestoneStatus, Submission},
    ID,
};
use solana_sysvar::program_stubs::{set_syscall_stubs, SyscallStubs};
use std::sync::{
    atomic::{AtomicI64, Ordering},
    Mutex, MutexGuard,
};

static HOST_LOCK: Mutex<()> = Mutex::new(());
static NOW: AtomicI64 = AtomicI64::new(100);

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

    fn sol_invoke_signed(
        &self,
        instruction: &Instruction,
        accounts: &[AccountInfo],
        seeds: &[&[&[u8]]],
    ) -> ProgramResult {
        // Support only the fresh-account System CPI used by submission init.
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
            || owner != ID
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

fn public_key(seed: u8) -> Pubkey {
    // Deterministic public-only on-curve test fixture. No signing key is generated.
    (seed..=255)
        .map(|byte| Pubkey::new_from_array([byte; 32]))
        .find(|key| key.is_on_curve() && *key != Pubkey::default())
        .unwrap()
}

use anchor_spl::token::spl_token::{self, state::Mint};
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

struct Creation {
    sponsor: AccountInfo<'static>,
    internship: AccountInfo<'static>,
    milestone: AccountInfo<'static>,
    mint: AccountInfo<'static>,
    token: AccountInfo<'static>,
    system: AccountInfo<'static>,
    verifier: Pubkey,
}
impl Creation {
    fn new() -> Self {
        let sponsor = public_key(1);
        let internship = Pubkey::find_program_address(
            &[INTERNSHIP_SEED, sponsor.as_ref(), &1u64.to_le_bytes()],
            &ID,
        )
        .0;
        let milestone = Pubkey::find_program_address(
            &[MILESTONE_SEED, internship.as_ref(), &2u64.to_le_bytes()],
            &ID,
        )
        .0;
        let mut mint_data = vec![0; Mint::LEN];
        Mint::pack(
            Mint {
                mint_authority: COption::Some(public_key(210)),
                supply: 0,
                decimals: DEMO_DECIMALS,
                is_initialized: true,
                freeze_authority: COption::None,
            },
            &mut mint_data,
        )
        .unwrap();
        Self {
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
            mint: info(DEMO_MINT, spl_token::ID, false, false, mint_data, false),
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
            verifier: public_key(140),
        }
    }
    fn internship(&self) -> ProgramResult {
        execute(
            vec![
                self.sponsor.clone(),
                self.internship.clone(),
                self.system.clone(),
            ],
            instruction::CreateInternship { internship_id: 1 }.data(),
        )
    }
    fn milestone(
        &self,
        reward_amount: u64,
        requirements_hash: [u8; 32],
        assign_by: i64,
        submit_by: i64,
        verifier: Pubkey,
    ) -> ProgramResult {
        execute(
            vec![
                self.sponsor.clone(),
                self.internship.clone(),
                self.milestone.clone(),
                self.mint.clone(),
                self.token.clone(),
                self.system.clone(),
            ],
            instruction::CreateMilestone {
                milestone_id: 2,
                reward_amount,
                requirements_hash,
                assign_by,
                submit_by,
                verifier,
            }
            .data(),
        )
    }
    fn valid(&self) -> ProgramResult {
        self.milestone(100, [5; 32], 200, 300, self.verifier)
    }
    fn mint_state(&self, change: impl FnOnce(&mut Mint)) {
        let mut state = Mint::unpack(&self.mint.try_borrow_data().unwrap()).unwrap();
        change(&mut state);
        Mint::pack(state, &mut self.mint.try_borrow_mut_data().unwrap()).unwrap();
    }
    fn state(&self) -> Milestone {
        load(&self.milestone)
    }
}

#[test]
fn internship_creation_records_canonical_immutable_fields_and_sponsor_pays() {
    let _env = Environment::new();
    let f = Creation::new();
    let before = f.sponsor.lamports();
    f.internship().unwrap();
    let state: Internship = load(&f.internship);
    let (key, bump) = Pubkey::find_program_address(
        &[INTERNSHIP_SEED, f.sponsor.key.as_ref(), &1u64.to_le_bytes()],
        &ID,
    );
    assert_eq!(*f.internship.key, key);
    assert_eq!(state.sponsor, *f.sponsor.key);
    assert_eq!(state.internship_id, 1);
    assert_eq!(state.bump, bump);
    assert_eq!(f.internship.data_len(), 49);
    assert_eq!(f.internship.owner, &ID);
    assert_eq!(
        before - f.sponsor.lamports(),
        Rent::default().minimum_balance(49)
    );
}
#[test]
fn internship_rejects_missing_signer_readonly_payer_wrong_pda_and_wrong_system() {
    let _env = Environment::new();
    for kind in 0..4 {
        let mut f = Creation::new();
        let before = f.sponsor.lamports();
        if kind == 0 {
            f.sponsor.is_signer = false;
        }
        if kind == 1 {
            f.sponsor.is_writable = false;
        }
        if kind == 2 {
            f.internship = info(
                public_key(210),
                system_program::ID,
                false,
                true,
                vec![0; 49],
                false,
            );
        }
        if kind == 3 {
            f.system = info(
                public_key(210),
                system_program::ID,
                false,
                false,
                vec![],
                true,
            );
        }
        assert!(f.internship().is_err());
        assert_eq!(f.sponsor.lamports(), before);
        assert_eq!(f.internship.owner, &system_program::ID);
        assert_eq!(f.internship.lamports(), 0);
    }
}
#[test]
fn internship_rejects_other_signer_for_sponsor_scoped_pda_and_duplicate_init() {
    let _env = Environment::new();
    let mut f = Creation::new();
    let original = f.sponsor.clone();
    f.sponsor = info(
        public_key(210),
        system_program::ID,
        true,
        true,
        vec![],
        false,
    );
    assert!(f.internship().is_err());
    f.sponsor = original;
    f.internship().unwrap();
    let bytes = f.internship.try_borrow_data().unwrap().to_vec();
    let balance = f.sponsor.lamports();
    assert!(f.internship().is_err());
    assert_eq!(f.internship.try_borrow_data().unwrap().to_vec(), bytes);
    assert_eq!(f.sponsor.lamports(), balance);
}
#[test]
fn milestone_creation_initializes_exact_terms_state_bumps_and_only_rent_changes() {
    let _env = Environment::new();
    let f = Creation::new();
    f.internship().unwrap();
    let mint = f.mint.try_borrow_data().unwrap().to_vec();
    let before = f.sponsor.lamports();
    f.valid().unwrap();
    let m = f.state();
    let bump = Pubkey::find_program_address(
        &[
            MILESTONE_SEED,
            f.internship.key.as_ref(),
            &2u64.to_le_bytes(),
        ],
        &ID,
    )
    .1;
    assert_eq!(
        m,
        Milestone {
            internship: *f.internship.key,
            sponsor: *f.sponsor.key,
            student: Pubkey::default(),
            verifier: f.verifier,
            reward_mint: DEMO_MINT,
            submission: Pubkey::default(),
            requirements_hash: [5; 32],
            milestone_id: 2,
            reward_amount: 100,
            assign_by: 200,
            submit_by: 300,
            verified_at: 0,
            status: MilestoneStatus::Created,
            bump,
            vault_bump: Pubkey::find_program_address(&[b"vault", f.milestone.key.as_ref()], &ID).1,
            vault_authority_bump: Pubkey::find_program_address(
                &[b"vault_authority", f.milestone.key.as_ref()],
                &ID
            )
            .1
        }
    );
    assert_eq!(f.milestone.data_len(), 276);
    assert_eq!(f.milestone.owner, &ID);
    assert_eq!(
        before - f.sponsor.lamports(),
        Rent::default().minimum_balance(276)
    );
    assert_eq!(f.mint.try_borrow_data().unwrap().to_vec(), mint);
}
#[test]
fn milestone_rejects_zero_reward_and_hash_with_rollback() {
    let _env = Environment::new();
    let f = Creation::new();
    f.internship().unwrap();
    let before = f.sponsor.lamports();
    for (reward, hash) in [(0, [5; 32]), (100, [0; 32])] {
        error(
            f.milestone(reward, hash, 200, 300, f.verifier),
            ProofOfWorkError::InvalidTerms,
        );
        assert_eq!(f.sponsor.lamports(), before);
        assert_eq!(f.milestone.owner, &system_program::ID);
        assert!(f
            .milestone
            .try_borrow_data()
            .unwrap()
            .iter()
            .all(|x| *x == 0));
    }
}
#[test]
fn milestone_deadline_boundaries_are_strict() {
    let _env = Environment::new();
    let f = Creation::new();
    f.internship().unwrap();
    for (now, assign, submit) in [
        (-1, 200, 300),
        (0, 200, 300),
        (100, 100, 300),
        (101, 100, 300),
        (100, 200, 200),
        (100, 300, 200),
        (100, -1, 300),
    ] {
        NOW.store(now, Ordering::SeqCst);
        error(
            f.milestone(100, [5; 32], assign, submit, f.verifier),
            ProofOfWorkError::InvalidTerms,
        );
    }
    NOW.store(199, Ordering::SeqCst);
    f.valid().unwrap();
}
#[test]
fn milestone_rejects_zero_sponsor_and_offcurve_verifiers() {
    let _env = Environment::new();
    let f = Creation::new();
    f.internship().unwrap();
    for verifier in [
        Pubkey::default(),
        *f.sponsor.key,
        Pubkey::find_program_address(&[b"test"], &ID).0,
    ] {
        error(
            f.milestone(100, [5; 32], 200, 300, verifier),
            ProofOfWorkError::InvalidRole,
        );
    }
}
#[test]
fn milestone_requires_recorded_sponsor_signature_and_writable_payer() {
    let _env = Environment::new();
    for kind in 0..3 {
        let mut f = Creation::new();
        f.internship().unwrap();
        if kind == 0 {
            f.sponsor.is_signer = false;
        }
        if kind == 1 {
            f.sponsor.is_writable = false;
        }
        if kind == 2 {
            f.sponsor = info(
                public_key(210),
                system_program::ID,
                true,
                true,
                vec![],
                false,
            );
        }
        assert!(f.valid().is_err());
        assert_eq!(f.milestone.owner, &system_program::ID);
    }
}
#[test]
fn milestone_rejects_foreign_parent_owner_key_bump_or_sponsor_binding() {
    let _env = Environment::new();
    for kind in 0..4 {
        let mut f = Creation::new();
        f.internship().unwrap();
        if kind == 0 {
            f.internship.assign(&system_program::ID);
        }
        if kind == 1 {
            let bytes = f.internship.try_borrow_data().unwrap().to_vec();
            f.internship = info(public_key(210), ID, false, false, bytes, false);
        }
        if kind >= 2 {
            let mut i: Internship = load(&f.internship);
            if kind == 2 {
                i.bump = i.bump.wrapping_sub(1);
            } else {
                i.sponsor = public_key(210);
            }
            store(&f.internship, &i);
        }
        assert!(f.valid().is_err());
        assert_eq!(f.milestone.owner, &system_program::ID);
    }
}
#[test]
fn milestone_rejects_wrong_pda_and_duplicate_initialization() {
    let _env = Environment::new();
    let mut f = Creation::new();
    f.internship().unwrap();
    let original = f.milestone.clone();
    f.milestone = info(
        public_key(210),
        system_program::ID,
        false,
        true,
        vec![0; 276],
        false,
    );
    assert!(f.valid().is_err());
    f.milestone = original;
    f.valid().unwrap();
    let before = f.milestone.try_borrow_data().unwrap().to_vec();
    assert!(f.valid().is_err());
    assert_eq!(f.milestone.try_borrow_data().unwrap().to_vec(), before);
}
#[test]
fn milestone_rejects_wrong_and_native_mints() {
    let _env = Environment::new();
    for key in [public_key(210), spl_token::native_mint::ID] {
        let mut f = Creation::new();
        f.internship().unwrap();
        let bytes = f.mint.try_borrow_data().unwrap().to_vec();
        f.mint = info(key, spl_token::ID, false, false, bytes, false);
        error(f.valid(), ProofOfWorkError::InvalidMint);
    }
}
#[test]
fn milestone_rejects_freezable_wrong_decimals_and_uninitialized_mints() {
    let _env = Environment::new();
    for kind in 0..3 {
        let f = Creation::new();
        f.internship().unwrap();
        f.mint_state(|mint| {
            if kind == 0 {
                mint.freeze_authority = COption::Some(public_key(210));
            }
            if kind == 1 {
                mint.decimals = 9;
            }
            if kind == 2 {
                mint.is_initialized = false;
            }
        });
        if kind < 2 {
            error(f.valid(), ProofOfWorkError::InvalidMint);
        } else {
            assert!(f.valid().is_err());
        }
        assert_eq!(f.milestone.owner, &system_program::ID);
    }
}
#[test]
fn milestone_requires_classic_mint_owner_and_executable_token_program() {
    let _env = Environment::new();
    for kind in 0..4 {
        let mut f = Creation::new();
        f.internship().unwrap();
        if kind == 0 {
            f.mint.assign(&system_program::ID);
        }
        if kind == 1 {
            f.token = info(
                public_key(210),
                system_program::ID,
                false,
                false,
                vec![],
                true,
            );
        }
        if kind == 2 {
            f.token.executable = false;
        }
        if kind == 3 {
            f.mint = info(DEMO_MINT, spl_token::ID, false, false, vec![1; 81], false);
        }
        assert!(f.valid().is_err());
        assert_eq!(f.milestone.owner, &system_program::ID);
    }
}
#[test]
fn created_state_cannot_skip_funding_and_remains_compatible_with_verification() {
    let _env = Environment::new();
    let f = Creation::new();
    f.internship().unwrap();
    f.valid().unwrap();
    let student = public_key(70);
    let assign = || {
        execute(
            vec![f.sponsor.clone(), f.internship.clone(), f.milestone.clone()],
            instruction::AssignStudent { student }.data(),
        )
    };
    error(assign(), ProofOfWorkError::InvalidState);
    // Funding is intentionally not implemented: simulate its approved state effect only for compatibility.
    let mut m = f.state();
    m.status = MilestoneStatus::Funded;
    store(&f.milestone, &m);
    assign().unwrap();
    let (submission_key, _) =
        Pubkey::find_program_address(&[SUBMISSION_SEED, f.milestone.key.as_ref()], &ID);
    let submission = info(
        submission_key,
        system_program::ID,
        false,
        true,
        vec![0; Submission::SPACE],
        false,
    );
    let student = info(student, system_program::ID, true, true, vec![], false);
    execute(
        vec![
            student.clone(),
            f.internship.clone(),
            f.milestone.clone(),
            submission.clone(),
            f.system.clone(),
        ],
        instruction::SubmitMilestone {
            evidence_hash: [9; 32],
        }
        .data(),
    )
    .unwrap();
    let verifier = info(f.verifier, system_program::ID, true, false, vec![], false);
    execute(
        vec![
            verifier,
            f.internship.clone(),
            f.milestone.clone(),
            submission,
        ],
        instruction::AttestMilestone {
            expected_student: *student.key,
            expected_requirements_hash: [5; 32],
            expected_evidence_hash: [9; 32],
        }
        .data(),
    )
    .unwrap();
    assert_eq!(f.state().status, MilestoneStatus::Verified);
}

#[test]
fn milestone_rejects_token_2022_mint_ownership_and_program() {
    let _env = Environment::new();
    let token_2022 = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
    for wrong_owner in [true, false] {
        let mut f = Creation::new();
        f.internship().unwrap();
        if wrong_owner {
            f.mint.assign(&token_2022);
        } else {
            f.token = info(token_2022, system_program::ID, false, false, vec![], true);
        }
        assert!(f.valid().is_err());
        assert_eq!(f.milestone.owner, &system_program::ID);
    }
}
