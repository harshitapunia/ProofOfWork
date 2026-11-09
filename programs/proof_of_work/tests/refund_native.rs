//! Independent refund tests built from the main-branch funding harness.
//! Actual Anchor dispatch and native SPL processor; PDA signer privileges are derived from seeds.
//! No settlement code or shared escrow helper is used.
//! Clock/rent, System account creation, privileges and transaction rollback are modeled locally.
//! This is not SBF VM execution or a signed Solana transaction test.

use anchor_lang::{
    error::ErrorCode,
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
    atomic::{AtomicI64, AtomicU64, AtomicU8, Ordering},
    Mutex, MutexGuard,
};

static HOST_LOCK: Mutex<()> = Mutex::new(());
static NOW: AtomicI64 = AtomicI64::new(100);
static FAULT: AtomicU8 = AtomicU8::new(0);
static TRANSFER_AMOUNT: AtomicU64 = AtomicU64::new(0);

struct HostStubs;

impl SyscallStubs for HostStubs {
    /// Supplies the test-controlled Clock sysvar; no validator clock or network is consulted.
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

    /// Supplies default rent parameters for host-side account-creation fixtures.
    fn sol_get_rent_sysvar(&self, address: *mut u8) -> u64 {
        // The sysvar ABI supplies an aligned, writable Rent-sized buffer.
        unsafe {
            (address as *mut Rent).write(Rent::default());
        }
        0
    }

    /// Checks CPI privileges and derives PDA signers before running the real native SPL processor.
    /// Models only fresh System creates; neither this stub nor its fault injection executes a bank/SBF runtime.
    fn sol_invoke_signed(
        &self,
        instruction: &Instruction,
        accounts: &[AccountInfo],
        seeds: &[&[&[u8]]],
    ) -> ProgramResult {
        if instruction.program_id == spl_token::ID {
            let derived: Vec<_> = seeds
                .iter()
                .map(|seed| Pubkey::create_program_address(seed, &ID))
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
                    1
                }
                spl_token::instruction::TokenInstruction::CloseAccount => 2,
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
            if stage == 1 && FAULT.load(Ordering::SeqCst) == 3 {
                // Fault injection only: an honest token transfer cannot leave this extra token.
                let mut token = TokenAccount::unpack(&effective[0].try_borrow_data()?)?;
                token.amount += 1;
                TokenAccount::pack(token, &mut effective[0].try_borrow_mut_data()?)?;
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
    /// Serializes tests that replace global syscall stubs and resets modeled time and CPI faults.
    fn new() -> Self {
        let lock = HOST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        NOW.store(100, Ordering::SeqCst);
        FAULT.store(0, Ordering::SeqCst);
        TRANSFER_AMOUNT.store(0, Ordering::SeqCst);
        Self {
            previous: Some(set_syscall_stubs(Box::new(HostStubs))),
            _lock: lock,
        }
    }
}

impl Drop for Environment {
    /// Restores the previous syscall implementation before releasing the global test lock.
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

/// Serializes a fixture, including deliberate corruptions used to isolate account validation.
fn store<T: AccountSerialize>(account: &AccountInfo, value: &T) {
    value
        .try_serialize(&mut &mut account.try_borrow_mut_data().unwrap()[..])
        .unwrap();
}

/// Deserializes fixture state for assertions on immutable fields and lifecycle transitions.
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

/// Converts a named Anchor error into the exact ProgramError returned by the entrypoint.
fn anchor_error(code: ErrorCode) -> ProgramError {
    ProgramError::Custom(code.into())
}

/// Asserts a ProofOfWork domain error, distinct from Anchor constraints and SPL processor failures.
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
    /// Builds the funding account order, including the System Program used by vault initialization.
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
    /// Mutates packed sponsor-token fixture data to exercise owner, mint, balance and frozen-account guards.
    fn source_state(&self, change: impl FnOnce(&mut TokenAccount)) {
        let mut t = TokenAccount::unpack(&self.source.try_borrow_data().unwrap()).unwrap();
        change(&mut t);
        TokenAccount::pack(t, &mut self.source.try_borrow_mut_data().unwrap()).unwrap();
    }
    /// Injects milestone-field mutations to test bindings and otherwise unreachable malformed states.
    fn milestone_state(&self, change: impl FnOnce(&mut Milestone)) {
        let mut m: Milestone = load(&self.milestone);
        change(&mut m);
        store(&self.milestone, &m);
    }
}

struct Refund {
    funding: Funding,
}
impl Refund {
    /// Creates and funds a milestone through actual handlers, optionally assigns it, then advances the modeled clock to the cutoff.
    fn new(id: u64, assigned: bool) -> Self {
        NOW.store(100, Ordering::SeqCst);
        let mut funding = Funding::new(id);
        funding.fund().unwrap();
        if assigned {
            execute(
                vec![
                    funding.sponsor.clone(),
                    funding.internship.clone(),
                    funding.milestone.clone(),
                ],
                instruction::AssignStudent {
                    student: public_key(70),
                }
                .data(),
            )
            .unwrap();
        }
        funding.internship.is_writable = false;
        NOW.store(300, Ordering::SeqCst);
        TRANSFER_AMOUNT.store(0, Ordering::SeqCst);
        Self { funding }
    }
    /// Builds the approved eight-account refund interface without a completion or System Program account.
    fn accounts(&self) -> Vec<AccountInfo<'static>> {
        let f = &self.funding;
        vec![
            f.sponsor.clone(),
            f.internship.clone(),
            f.milestone.clone(),
            f.mint.clone(),
            f.vault.clone(),
            f.authority.clone(),
            f.source.clone(),
            f.token.clone(),
        ]
    }
    /// Dispatches the generated refund instruction through Anchor; execute() models rollback on failure.
    fn refund(&self) -> ProgramResult {
        execute(
            self.accounts(),
            instruction::RefundUnclaimedMilestone {}.data(),
        )
    }
    /// Captures account owners, lamports and bytes for complete host-modeled rollback comparisons.
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
    /// Requires refund failure and identical account snapshots, then returns the actual error for layer-specific assertions.
    /// Snapshot restoration is supplied by the host harness and does not establish runtime atomicity.
    fn reject(&self) -> ProgramResult {
        let before = self.snapshot();
        let result = self.refund();
        assert!(result.is_err(), "expected refund failure");
        assert_eq!(
            self.snapshot(),
            before,
            "host-modeled rollback must restore all accounts"
        );
        result
    }
    /// Mutates packed vault fixtures to test custody, shortfalls and malformed token state.
    fn vault_state(&self, change: impl FnOnce(&mut TokenAccount)) {
        let a = &self.funding.vault;
        let mut t = TokenAccount::unpack(&a.try_borrow_data().unwrap()).unwrap();
        change(&mut t);
        TokenAccount::pack(t, &mut a.try_borrow_mut_data().unwrap()).unwrap();
    }
    /// Execute actual submission, optionally attestation, through existing main-branch handlers.
    fn submit(&self, attest: bool) -> AccountInfo<'static> {
        let f = &self.funding;
        let student = info(
            public_key(70),
            system_program::ID,
            true,
            true,
            vec![],
            false,
        );
        let key = Pubkey::find_program_address(&[SUBMISSION_SEED, f.milestone.key.as_ref()], &ID).0;
        let submission = info(
            key,
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
        NOW.store(400, Ordering::SeqCst);
        if attest {
            let verifier = info(
                public_key(140),
                system_program::ID,
                true,
                false,
                vec![],
                false,
            );
            execute(
                vec![
                    verifier,
                    f.internship.clone(),
                    f.milestone.clone(),
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
        }
        submission
    }
}
/// Reads raw token units from a valid packed account for conservation and payout assertions.
fn balance(account: &AccountInfo) -> u64 {
    TokenAccount::unpack(&account.try_borrow_data().unwrap())
        .unwrap()
        .amount
}

/// Checks both eligible states at the exact cutoff, exact principal repayment, sponsor-only rent return and the terminal status.
#[test]
fn funded_and_assigned_refunds_at_exact_cutoff_return_principal_and_rent() {
    let _env = Environment::new();
    for assigned in [false, true] {
        let r = Refund::new(2, assigned);
        let before = r.snapshot();
        let mut expected: Milestone = load(&r.funding.milestone);
        expected.status = MilestoneStatus::Refunded;
        let sponsor_lamports = r.funding.sponsor.lamports();
        let vault_lamports = r.funding.vault.lamports();
        r.refund().unwrap();
        assert_eq!(balance(&r.funding.source), 1000);
        assert_eq!(TRANSFER_AMOUNT.load(Ordering::SeqCst), 100);
        assert_eq!(
            r.funding.sponsor.lamports(),
            sponsor_lamports + vault_lamports
        );
        assert_eq!(r.funding.vault.lamports(), 0);
        assert_eq!(*r.funding.vault.owner, system_program::ID);
        assert!(r
            .funding
            .vault
            .try_borrow_data()
            .unwrap()
            .iter()
            .all(|b| *b == 0));
        assert_eq!(load::<Milestone>(&r.funding.milestone), expected);
        assert_eq!(
            r.funding.internship.try_borrow_data().unwrap().to_vec(),
            before[1].2
        );
        assert_eq!(
            r.funding.mint.try_borrow_data().unwrap().to_vec(),
            before[3].2
        );
        assert!(!r.funding.authority.is_signer);
        // Eight approved accounts, no System CPI or CompletionRecord initialization in refund.
        assert_eq!(r.accounts().len(), 8);
    }
}

/// Proves the exclusive submission/inclusive refund boundary for both Funded and Assigned milestones.
#[test]
fn refunds_are_rejected_one_second_before_cutoff_and_allowed_after_it() {
    let _env = Environment::new();
    for assigned in [false, true] {
        let r = Refund::new(2, assigned);
        NOW.store(299, Ordering::SeqCst);
        error(r.reject(), ProofOfWorkError::RefundTooEarly);
        assert_eq!(TRANSFER_AMOUNT.load(Ordering::SeqCst), 0);
        NOW.store(301, Ordering::SeqCst);
        r.refund().unwrap();
    }
}

/// Uses a real native SPL donation transfer and checks that surplus tokens and all vault lamports return to the sponsor.
#[test]
fn unsolicited_tokens_and_extra_vault_lamports_return_to_recorded_sponsor() {
    let _env = Environment::new();
    let r = Refund::new(2, false);
    // Donate from the sponsor's remaining balance using the real checked transfer processor.
    let f = &r.funding;
    let ix = spl_token::instruction::transfer_checked(
        &spl_token::ID,
        f.source.key,
        f.mint.key,
        f.vault.key,
        f.sponsor.key,
        &[],
        35,
        DEMO_DECIMALS,
    )
    .unwrap();
    spl_token::processor::Processor::process(
        &spl_token::ID,
        &[
            f.source.clone(),
            f.mint.clone(),
            f.vault.clone(),
            f.sponsor.clone(),
        ],
        &ix.data,
    )
    .unwrap();
    **f.vault.try_borrow_mut_lamports().unwrap() += 123;
    let rent = f.vault.lamports();
    let sponsor_lamports = f.sponsor.lamports();
    r.refund().unwrap();
    assert_eq!(balance(&f.source), 1000);
    assert_eq!(TRANSFER_AMOUNT.load(Ordering::SeqCst), 135);
    assert_eq!(f.sponsor.lamports(), sponsor_lamports + rent);
    assert_eq!(
        Mint::unpack(&f.mint.try_borrow_data().unwrap())
            .unwrap()
            .supply,
        1000
    );
}

/// Separately proves typed signer validation, writable constraints and recorded-sponsor authorization.
#[test]
fn only_recorded_sponsor_with_required_privileges_can_refund() {
    let _env = Environment::new();
    for kind in 0..3 {
        let mut r = Refund::new(2, false);
        match kind {
            0 => r.funding.sponsor.is_signer = false,
            1 => r.funding.sponsor.is_writable = false,
            2 => {
                r.funding.sponsor = info(
                    public_key(210),
                    system_program::ID,
                    true,
                    true,
                    vec![],
                    false,
                )
            }
            _ => unreachable!(),
        }
        let expected = match kind {
            // Signer deserialization precedes the account's explicit constraints.
            0 => anchor_error(ErrorCode::AccountNotSigner),
            1 => anchor_error(ErrorCode::ConstraintMut),
            2 => ProgramError::Custom(u32::from(ProofOfWorkError::InvalidRole)),
            _ => unreachable!(),
        };
        assert_eq!(r.reject(), Err(expected), "sponsor case {kind}");
        assert_eq!(TRANSFER_AMOUNT.load(Ordering::SeqCst), 0);
    }
}

/// Keeps a valid live vault while proving every noneligible status fails the handler state gate.
#[test]
fn all_other_statuses_are_rejected_even_with_empty_submission_fields() {
    let _env = Environment::new();
    for status in [
        MilestoneStatus::Created,
        MilestoneStatus::Submitted,
        MilestoneStatus::Verified,
        MilestoneStatus::Settled,
        MilestoneStatus::Refunded,
    ] {
        let r = Refund::new(2, false);
        r.funding.milestone_state(|m| m.status = status);
        error(r.reject(), ProofOfWorkError::InvalidState);
    }
}

/// Executes submission and optional attestation, then proves elapsed time cannot unlock a sponsor refund.
#[test]
fn timely_submitted_or_verified_work_never_becomes_refundable() {
    let _env = Environment::new();
    for attest in [false, true] {
        let r = Refund::new(2, true);
        let submission = r.submit(attest);
        let bytes = submission.try_borrow_data().unwrap().to_vec();
        NOW.store(1_000_000, Ordering::SeqCst);
        error(r.reject(), ProofOfWorkError::InvalidState);
        assert_eq!(submission.try_borrow_data().unwrap().to_vec(), bytes);
    }
}

/// Proves either a linked submission or nonzero verification time blocks refund despite an eligible status.
#[test]
fn submission_or_verification_binding_blocks_refund_even_in_eligible_status() {
    let _env = Environment::new();
    for assigned in [false, true] {
        for kind in 0..2 {
            let r = Refund::new(2, assigned);
            r.funding.milestone_state(|m| {
                if kind == 0 {
                    m.submission = public_key(210);
                } else {
                    m.verified_at = 1;
                }
            });
            error(r.reject(), ProofOfWorkError::BindingMismatch);
        }
    }
}

/// Checks exact ownership, binding and seed errors for parent/child substitutions and all four stored bumps.
#[test]
fn parent_child_ownership_pdas_and_all_stored_bumps_are_validated() {
    let _env = Environment::new();
    for kind in 0..10 {
        let mut r = Refund::new(2, false);
        match kind {
            0 => r.funding.internship.assign(&system_program::ID),
            1 => r.funding.milestone.assign(&system_program::ID),
            2 => r
                .funding
                .milestone_state(|m| m.internship = public_key(210)),
            3 => r.funding.milestone_state(|m| m.sponsor = public_key(210)),
            4 => r
                .funding
                .milestone_state(|m| m.bump = m.bump.wrapping_sub(1)),
            5 => r
                .funding
                .milestone_state(|m| m.vault_bump = m.vault_bump.wrapping_sub(1)),
            6 => r.funding.milestone_state(|m| {
                m.vault_authority_bump = m.vault_authority_bump.wrapping_sub(1)
            }),
            7 => {
                let mut i: Internship = load(&r.funding.internship);
                i.bump = i.bump.wrapping_sub(1);
                store(&r.funding.internship, &i);
            }
            8 => {
                let bytes = r.funding.internship.try_borrow_data().unwrap().to_vec();
                r.funding.internship = info(public_key(210), ID, false, false, bytes, false);
            }
            9 => {
                let bytes = r.funding.milestone.try_borrow_data().unwrap().to_vec();
                r.funding.milestone = info(public_key(210), ID, false, true, bytes, false);
            }
            _ => unreachable!(),
        }
        let expected = match kind {
            0 | 1 => anchor_error(ErrorCode::AccountOwnedByWrongProgram),
            2 | 3 => ProgramError::Custom(u32::from(ProofOfWorkError::BindingMismatch)),
            4..=9 => anchor_error(ErrorCode::ConstraintSeeds),
            _ => unreachable!(),
        };
        assert_eq!(r.reject(), Err(expected), "parent/child case {kind}");
    }
}

/// Distinguishes vault seed, token-binding, custody and unpack failures without weakening modeled rollback assertions.
#[test]
fn vault_address_authority_owner_mint_delegate_close_authority_and_native_checks() {
    let _env = Environment::new();
    for kind in 0..9 {
        let mut r = Refund::new(2, false);
        match kind {
            0 => {
                let bytes = r.funding.vault.try_borrow_data().unwrap().to_vec();
                r.funding.vault = info(public_key(210), spl_token::ID, false, true, bytes, false);
            }
            1 => {
                r.funding.authority = info(
                    public_key(210),
                    system_program::ID,
                    false,
                    false,
                    vec![],
                    false,
                )
            }
            2 => r.funding.vault.assign(&system_program::ID),
            3 => r.vault_state(|v| v.owner = public_key(210)),
            4 => r.vault_state(|v| v.mint = public_key(210)),
            5 => r.vault_state(|v| v.delegate = COption::Some(public_key(210))),
            6 => r.vault_state(|v| v.close_authority = COption::Some(*r.funding.authority.key)),
            7 => r.vault_state(|v| v.is_native = COption::Some(1)),
            8 => {
                r.funding.vault = info(
                    *r.funding.vault.key,
                    spl_token::ID,
                    false,
                    true,
                    vec![1; 10],
                    false,
                )
            }
            _ => unreachable!(),
        }
        let expected = match kind {
            0 => anchor_error(ErrorCode::ConstraintSeeds),
            // The vault's token::authority check runs before the authority PDA's seeds check.
            1 | 3 => anchor_error(ErrorCode::ConstraintTokenOwner),
            2 => anchor_error(ErrorCode::AccountOwnedByWrongProgram),
            4 => anchor_error(ErrorCode::ConstraintTokenMint),
            5..=7 => ProgramError::Custom(u32::from(ProofOfWorkError::InvalidVault)),
            // anchor-spl propagates SPL Pack's malformed-data error without an Anchor code.
            8 => ProgramError::InvalidAccountData,
            _ => unreachable!(),
        };
        assert_eq!(r.reject(), Err(expected), "vault case {kind}");
    }
}

/// Checks destination identity, internal owner/mint and program ownership, including Anchor duplicate-account rejection.
#[test]
fn canonical_sponsor_ata_internal_owner_mint_and_alias_constraints_are_enforced() {
    let _env = Environment::new();
    for kind in 0..5 {
        let mut r = Refund::new(2, false);
        match kind {
            0 => {
                let bytes = r.funding.source.try_borrow_data().unwrap().to_vec();
                r.funding.source = info(public_key(210), spl_token::ID, false, true, bytes, false);
            }
            1 => r.funding.source_state(|v| v.owner = public_key(210)),
            2 => r.funding.source_state(|v| v.mint = public_key(210)),
            3 => r.funding.source.assign(&system_program::ID),
            4 => r.funding.source = r.funding.vault.clone(),
            _ => unreachable!(),
        }
        let expected = match kind {
            0 => ProgramError::Custom(u32::from(ProofOfWorkError::InvalidDestination)),
            1 => anchor_error(ErrorCode::ConstraintTokenOwner),
            2 => anchor_error(ErrorCode::ConstraintTokenMint),
            3 => anchor_error(ErrorCode::AccountOwnedByWrongProgram),
            // Anchor 1.2.2 checks duplicate mutable accounts before token constraints.
            // The alias never reaches the handler's defensive InvalidDestination check.
            4 => anchor_error(ErrorCode::ConstraintDuplicateMutableAccount),
            _ => unreachable!(),
        };
        assert_eq!(r.reject(), Err(expected), "ATA case {kind}");
    }
}

/// Checks configured mint terms, classic ownership, program identity/executability and uninitialized mint deserialization.
#[test]
fn approved_classic_nonfreezable_mint_and_executable_token_program_are_required() {
    let _env = Environment::new();
    for kind in 0..9 {
        let mut r = Refund::new(2, false);
        let token2022 = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
        match kind {
            0 | 1 => {
                let bytes = r.funding.mint.try_borrow_data().unwrap().to_vec();
                let key = if kind == 0 {
                    public_key(210)
                } else {
                    spl_token::native_mint::ID
                };
                r.funding.mint = info(key, spl_token::ID, false, false, bytes, false);
            }
            2 => r.funding.mint.assign(&token2022),
            3 | 4 => {
                let mut m = Mint::unpack(&r.funding.mint.try_borrow_data().unwrap()).unwrap();
                if kind == 3 {
                    m.freeze_authority = COption::Some(public_key(210));
                } else {
                    m.decimals = 9;
                }
                Mint::pack(m, &mut r.funding.mint.try_borrow_mut_data().unwrap()).unwrap();
            }
            5 => r
                .funding
                .milestone_state(|m| m.reward_mint = public_key(210)),
            6 => r.funding.token = info(token2022, system_program::ID, false, false, vec![], true),
            7 => r.funding.token.executable = false,
            8 => {
                r.funding.mint = info(
                    DEMO_MINT,
                    spl_token::ID,
                    false,
                    false,
                    vec![0; Mint::LEN],
                    false,
                )
            }
            _ => unreachable!(),
        }
        let expected = match kind {
            0 | 1 | 3..=5 => ProgramError::Custom(u32::from(ProofOfWorkError::InvalidMint)),
            2 => anchor_error(ErrorCode::AccountOwnedByWrongProgram),
            6 => anchor_error(ErrorCode::InvalidProgramId),
            7 => anchor_error(ErrorCode::InvalidProgramExecutable),
            // A classic-owned mint with zeroed bytes fails SPL unpack's initialization check.
            8 => ProgramError::UninitializedAccount,
            _ => unreachable!(),
        };
        assert_eq!(r.reject(), Err(expected), "mint/program case {kind}");
    }
}

/// Requires sufficient principal backing and valid positive reward/deadline terms before any disposal.
#[test]
fn shortfall_zero_principal_and_malformed_deadlines_fail_closed() {
    let _env = Environment::new();
    let r = Refund::new(2, false);
    r.vault_state(|v| v.amount = 99);
    error(r.reject(), ProofOfWorkError::InsufficientEscrow);
    for kind in 0..3 {
        let r = Refund::new(2, false);
        r.funding.milestone_state(|m| match kind {
            0 => m.reward_amount = 0,
            1 => m.assign_by = 0,
            _ => m.submit_by = m.assign_by,
        });
        error(r.reject(), ProofOfWorkError::InvalidTerms);
    }
}

/// Exercises maximum-u64 principal and surplus totals while preserving exact raw-unit repayment.
#[test]
fn maximum_raw_balance_refunds_without_overflow() {
    let _env = Environment::new();
    // Covers both a maximum principal and maximum surplus-plus-principal total.
    for principal in [100, u64::MAX] {
        let r = Refund::new(2, false);
        r.funding.milestone_state(|m| m.reward_amount = principal);
        r.vault_state(|v| v.amount = u64::MAX);
        r.funding.source_state(|v| v.amount = 0);
        let mut mint = Mint::unpack(&r.funding.mint.try_borrow_data().unwrap()).unwrap();
        mint.supply = u64::MAX;
        Mint::pack(mint, &mut r.funding.mint.try_borrow_mut_data().unwrap()).unwrap();
        r.refund().unwrap();
        assert_eq!(balance(&r.funding.source), u64::MAX);
        assert_eq!(TRANSFER_AMOUNT.load(Ordering::SeqCst), u64::MAX);
    }
}

/// Proves replay fails while loading the closed vault and cannot create another payout.
#[test]
fn repeated_refund_is_rejected_without_additional_payout() {
    let _env = Environment::new();
    let r = Refund::new(2, false);
    r.refund().unwrap();
    // Closing the vault leaves zero lamports and System ownership. Typed account loading
    // rejects it before the handler can evaluate InvalidState; the live-vault status
    // matrix separately proves that Refunded is rejected by the handler itself.
    assert_eq!(
        r.reject(),
        Err(anchor_error(ErrorCode::AccountNotInitialized))
    );
    assert_eq!(balance(&r.funding.source), 1000);
    assert_eq!(
        load::<Milestone>(&r.funding.milestone).status,
        MilestoneStatus::Refunded
    );
}

/// Checks exact substitution failures and unchanged snapshots for both milestone escrows.
#[test]
fn cross_milestone_vault_authority_and_parent_substitution_preserve_both_escrows() {
    let _env = Environment::new();
    for kind in 0..3 {
        let mut r = Refund::new(2, false);
        let other = Refund::new(3, false);
        let before = other.snapshot();
        match kind {
            0 => r.funding.vault = other.funding.vault.clone(),
            1 => r.funding.authority = other.funding.authority.clone(),
            2 => {
                r.funding.internship = info(
                    public_key(210),
                    ID,
                    false,
                    false,
                    other.funding.internship.try_borrow_data().unwrap().to_vec(),
                    false,
                )
            }
            _ => unreachable!(),
        }
        let expected = match kind {
            0 | 2 => anchor_error(ErrorCode::ConstraintSeeds),
            // Substituting authority first invalidates the original vault's internal owner binding.
            1 => anchor_error(ErrorCode::ConstraintTokenOwner),
            _ => unreachable!(),
        };
        assert_eq!(r.reject(), Err(expected), "cross-milestone case {kind}");
        assert_eq!(other.snapshot(), before);
    }
}

/// Injects transfer, close and residual-balance failures and verifies restored host snapshots and status.
/// This tests error propagation with modeled rollback, not Solana transaction atomicity.
#[test]
fn transfer_close_and_residual_balance_faults_have_modeled_full_rollback() {
    let _env = Environment::new();
    for fault in 1..=3 {
        let r = Refund::new(2, false);
        FAULT.store(fault, Ordering::SeqCst);
        let result = r.reject();
        if fault < 3 {
            assert_eq!(result, Err(ProgramError::Custom(9000 + fault as u32)));
        } else {
            error(result, ProofOfWorkError::InvalidVault);
        }
        assert_eq!(
            load::<Milestone>(&r.funding.milestone).status,
            MilestoneStatus::Funded
        );
        FAULT.store(0, Ordering::SeqCst);
    }
}

/// Uses real native SPL frozen-account and overflow errors, including close failure after token transfer.
/// Account restoration remains host-modeled even though SPL rejection logic is real.
#[test]
fn actual_token_transfer_and_close_rejections_have_modeled_rollback() {
    let _env = Environment::new();
    for kind in 0..4 {
        let r = Refund::new(2, false);
        match kind {
            0 => r.funding.source_state(|v| v.state = AccountState::Frozen),
            1 => r.vault_state(|v| v.state = AccountState::Frozen),
            2 => r.funding.source_state(|v| v.amount = u64::MAX),
            3 => **r.funding.sponsor.try_borrow_mut_lamports().unwrap() = u64::MAX,
            _ => unreachable!(),
        }
        let result = r.reject();
        let expected = if kind < 2 {
            spl_token::error::TokenError::AccountFrozen
        } else {
            spl_token::error::TokenError::Overflow
        };
        assert_eq!(result, Err(expected.into()));
    }
}

/// Requires the exact Anchor mut-constraint error for each writable account when supplied readonly.
#[test]
fn writable_flags_are_enforced_for_every_mutable_account() {
    let _env = Environment::new();
    for kind in 0..4 {
        let mut r = Refund::new(2, false);
        match kind {
            0 => r.funding.sponsor.is_writable = false,
            1 => r.funding.milestone.is_writable = false,
            2 => r.funding.vault.is_writable = false,
            _ => r.funding.source.is_writable = false,
        }
        assert_eq!(
            r.reject(),
            Err(anchor_error(ErrorCode::ConstraintMut)),
            "readonly account case {kind}"
        );
    }
}

/// Proves the CPI emulator rejects absent/unrelated PDA signer seeds before the SPL processor can move funds.
#[test]
fn native_cpi_signer_emulation_rejects_missing_and_wrong_seeds() {
    let _env = Environment::new();
    let r = Refund::new(2, false);
    let f = &r.funding;
    let ix = spl_token::instruction::transfer_checked(
        &spl_token::ID,
        f.vault.key,
        f.mint.key,
        f.source.key,
        f.authority.key,
        &[],
        100,
        DEMO_DECIMALS,
    )
    .unwrap();
    let accounts = [
        f.vault.clone(),
        f.mint.clone(),
        f.source.clone(),
        f.authority.clone(),
    ];
    let before = r.snapshot();
    assert!(!f.authority.is_signer);
    assert_eq!(
        HostStubs.sol_invoke_signed(&ix, &accounts, &[]),
        Err(ProgramError::MissingRequiredSignature)
    );
    let other = public_key(210);
    let (_, bump) = Pubkey::find_program_address(&[b"vault_authority", other.as_ref()], &ID);
    assert_eq!(
        HostStubs.sol_invoke_signed(
            &ix,
            &accounts,
            &[&[b"vault_authority", other.as_ref(), &[bump]]]
        ),
        Err(ProgramError::MissingRequiredSignature)
    );
    assert_eq!(r.snapshot(), before);
}

/// Pins the compiled account order, permissions, no-argument encoding and independently derived discriminator.
#[test]
fn compiled_refund_abi_matches_approved_order_flags_and_no_arguments() {
    use anchor_lang::ToAccountMetas;
    let _env = Environment::new();
    let r = Refund::new(2, false);
    let f = &r.funding;
    let metas = proof_of_work::accounts::RefundUnclaimedMilestone {
        sponsor: *f.sponsor.key,
        internship: *f.internship.key,
        milestone: *f.milestone.key,
        reward_mint: *f.mint.key,
        vault: *f.vault.key,
        vault_authority: *f.authority.key,
        sponsor_ata: *f.source.key,
        token_program: *f.token.key,
    }
    .to_account_metas(None);
    assert_eq!(metas.len(), 8);
    let writable = [true, false, true, false, true, false, true, false];
    for (i, (meta, account)) in metas.iter().zip(r.accounts()).enumerate() {
        assert_eq!(meta.pubkey, *account.key);
        assert_eq!(meta.is_signer, i == 0);
        assert_eq!(meta.is_writable, writable[i]);
    }
    // Independently pinned SHA-256("global:refund_unclaimed_milestone")[..8].
    assert_eq!(
        instruction::RefundUnclaimedMilestone {}.data(),
        [112, 42, 51, 34, 159, 247, 92, 4]
    );
}
