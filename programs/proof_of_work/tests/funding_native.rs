//! Native Anchor funding tests with the real classic SPL Token processor invoked by a host CPI stub.
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
            for (meta, account) in instruction.accounts.iter().zip(accounts) {
                if meta.pubkey != *account.key
                    || (meta.is_signer && !account.is_signer)
                    || (meta.is_writable && !account.is_writable)
                {
                    return Err(ProgramError::MissingRequiredSignature);
                }
            }
            let transfer =
                match spl_token::instruction::TokenInstruction::unpack(&instruction.data)? {
                    spl_token::instruction::TokenInstruction::TransferChecked {
                        amount,
                        decimals,
                    } => {
                        if decimals != DEMO_DECIMALS {
                            return Err(ProgramError::InvalidInstructionData);
                        }
                        TRANSFER_AMOUNT.store(amount, Ordering::SeqCst);
                        true
                    }
                    spl_token::instruction::TokenInstruction::InitializeAccount3 { .. } => false,
                    _ => return Err(ProgramError::InvalidInstructionData),
                };
            if transfer && FAULT.load(Ordering::SeqCst) == 1 {
                return Err(ProgramError::Custom(9001));
            }
            spl_token::processor::Processor::process(&spl_token::ID, accounts, &instruction.data)?;
            if transfer && FAULT.load(Ordering::SeqCst) == 2 {
                // Fault injection only: verify a post-CPI escrow shortfall fails closed and rolls back.
                let vault = &accounts[2];
                let mut state = spl_token::state::Account::unpack(&vault.try_borrow_data()?)?;
                state.amount -= 1;
                spl_token::state::Account::pack(state, &mut vault.try_borrow_mut_data()?)?;
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
                milestone_id: 2,
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
    fn source_state(&self, change: impl FnOnce(&mut TokenAccount)) {
        let mut t = TokenAccount::unpack(&self.source.try_borrow_data().unwrap()).unwrap();
        change(&mut t);
        TokenAccount::pack(t, &mut self.source.try_borrow_mut_data().unwrap()).unwrap();
    }
    fn milestone_state(&self, change: impl FnOnce(&mut Milestone)) {
        let mut m: Milestone = load(&self.milestone);
        change(&mut m);
        store(&self.milestone, &m);
    }
    /// Captures every account to assert modeled rollback includes rent, token balances, owners and state.
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
    fn reject(&self) {
        let before = self.snapshot();
        assert!(self.fund().is_err());
        assert_eq!(self.snapshot(), before);
    }
}

/// Runs the real native SPL initializer and TransferChecked processor; no SBF VM or network is used.
#[test]
fn funding_moves_exact_reward_initializes_valid_escrow_and_enables_assignment() {
    let _env = Environment::new();
    let f = Funding::new();
    let rent = f.sponsor.lamports();
    f.fund().unwrap();
    let source = TokenAccount::unpack(&f.source.try_borrow_data().unwrap()).unwrap();
    let vault = TokenAccount::unpack(&f.vault.try_borrow_data().unwrap()).unwrap();
    assert_eq!(source.amount, 900);
    assert_eq!(vault.amount, 100);
    assert_eq!(source.amount + vault.amount, 1000);
    assert_eq!(TRANSFER_AMOUNT.load(Ordering::SeqCst), 100);
    assert_eq!(*f.vault.owner, spl_token::ID);
    assert_eq!(vault.mint, DEMO_MINT);
    assert_eq!(vault.owner, *f.authority.key);
    assert_eq!(vault.delegate, COption::None);
    assert_eq!(vault.close_authority, COption::None);
    assert_eq!(vault.is_native, COption::None);
    assert_eq!(vault.state, AccountState::Initialized);
    assert_eq!(
        rent - f.sponsor.lamports(),
        Rent::default().minimum_balance(TokenAccount::LEN)
    );
    assert_eq!(
        load::<Milestone>(&f.milestone).status,
        MilestoneStatus::Funded
    );
    execute(
        vec![f.sponsor.clone(), f.internship.clone(), f.milestone.clone()],
        instruction::AssignStudent {
            student: public_key(70),
        }
        .data(),
    )
    .unwrap();
    assert_eq!(
        load::<Milestone>(&f.milestone).status,
        MilestoneStatus::Assigned
    );
}
/// Rejects missing sponsor privileges or unrelated authority, preserving all account state.
#[test]
fn funding_requires_recorded_sponsor_signature_and_rent_payer() {
    let _env = Environment::new();
    for kind in 0..3 {
        let mut f = Funding::new();
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
        f.reject();
    }
}
/// Parent and child derivations, owners and stored bindings must all match the same internship.
#[test]
fn funding_rejects_parent_child_substitutions_and_corrupt_bindings() {
    let _env = Environment::new();
    for kind in 0..7 {
        let mut f = Funding::new();
        if kind == 0 {
            f.internship.assign(&system_program::ID);
        }
        if kind == 1 {
            let bytes = f.internship.try_borrow_data().unwrap().to_vec();
            f.internship = info(public_key(210), ID, false, false, bytes, false);
        }
        if kind == 2 {
            f.milestone_state(|m| m.internship = public_key(210));
        }
        if kind == 3 {
            f.milestone_state(|m| m.sponsor = public_key(210));
        }
        if kind == 4 {
            f.milestone_state(|m| m.bump = m.bump.wrapping_sub(1));
        }
        if kind == 5 {
            let mut i: Internship = load(&f.internship);
            i.bump = i.bump.wrapping_sub(1);
            store(&f.internship, &i);
        }
        if kind == 6 {
            let bytes = f.milestone.try_borrow_data().unwrap().to_vec();
            f.milestone = info(public_key(210), ID, false, true, bytes, false);
        }
        f.reject();
    }
}
/// Canonical ATA address, token authority, mint and token-program ownership are separately enforced.
#[test]
fn funding_rejects_invalid_source_accounts() {
    let _env = Environment::new();
    for kind in 0..5 {
        let mut f = Funding::new();
        if kind == 0 {
            let bytes = f.source.try_borrow_data().unwrap().to_vec();
            f.source = info(public_key(210), spl_token::ID, false, true, bytes, false);
        }
        if kind == 1 {
            f.source_state(|t| t.owner = public_key(210));
        }
        if kind == 2 {
            f.source_state(|t| t.mint = public_key(210));
        }
        if kind == 3 {
            f.source.assign(&system_program::ID);
        }
        if kind == 4 {
            f.source.is_writable = false;
        }
        f.reject();
    }
}
/// Wrong, frozen-authority, native and wrong-decimal mint data must fail before funds are retained.
#[test]
fn funding_rejects_invalid_mints() {
    let _env = Environment::new();
    for kind in 0..7 {
        let mut f = Funding::new();
        if kind < 2 {
            let key = if kind == 0 {
                public_key(210)
            } else {
                spl_token::native_mint::ID
            };
            let bytes = f.mint.try_borrow_data().unwrap().to_vec();
            f.mint = info(key, spl_token::ID, false, false, bytes, false);
        }
        if kind == 2 {
            f.mint.assign(&system_program::ID);
        }
        if kind == 3 || kind == 4 {
            let mut m = Mint::unpack(&f.mint.try_borrow_data().unwrap()).unwrap();
            if kind == 3 {
                m.freeze_authority = COption::Some(public_key(210));
            } else {
                m.decimals = 9;
            }
            Mint::pack(m, &mut f.mint.try_borrow_mut_data().unwrap()).unwrap();
        }
        if kind == 5 {
            f.milestone_state(|m| m.reward_mint = public_key(210));
        }
        if kind == 6 {
            f.mint = info(DEMO_MINT, spl_token::ID, false, false, vec![1; 81], false);
        }
        f.reject();
    }
}
/// The executable classic token program is mandatory; enabling IDL interfaces never permits Token-2022.
#[test]
fn funding_rejects_wrong_token_program() {
    let _env = Environment::new();
    for kind in 0..3 {
        let mut f = Funding::new();
        if kind == 0 {
            f.token = info(
                pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
                system_program::ID,
                false,
                false,
                vec![],
                true,
            );
        }
        if kind == 1 {
            f.token.executable = false;
        }
        if kind == 2 {
            f.token = info(
                public_key(210),
                system_program::ID,
                false,
                false,
                vec![],
                true,
            );
        }
        f.reject();
    }
}
/// Vault, authority and both immutable recorded bumps must remain bound to the canonical child PDA.
#[test]
fn funding_rejects_incorrect_vault_authority_or_bumps() {
    let _env = Environment::new();
    for kind in 0..4 {
        let mut f = Funding::new();
        if kind == 0 {
            f.vault = info(
                public_key(210),
                system_program::ID,
                false,
                true,
                vec![0; TokenAccount::LEN],
                false,
            );
        }
        if kind == 1 {
            f.authority = info(
                public_key(210),
                system_program::ID,
                false,
                false,
                vec![],
                false,
            );
        }
        if kind == 2 {
            f.milestone_state(|m| m.vault_bump = m.vault_bump.wrapping_sub(1));
        }
        if kind == 3 {
            f.milestone_state(|m| m.vault_authority_bump = m.vault_authority_bump.wrapping_sub(1));
        }
        f.reject();
    }
}
/// A neighboring milestone's otherwise canonical vault or authority cannot substitute for this milestone's.
#[test]
fn funding_rejects_cross_milestone_vault_substitution() {
    let _env = Environment::new();
    for vault in [true, false] {
        let mut f = Funding::new();
        let other = Pubkey::find_program_address(
            &[
                MILESTONE_SEED,
                f.internship.key.as_ref(),
                &3u64.to_le_bytes(),
            ],
            &ID,
        )
        .0;
        if vault {
            let key = Pubkey::find_program_address(&[b"vault", other.as_ref()], &ID).0;
            f.vault = info(
                key,
                system_program::ID,
                false,
                true,
                vec![0; TokenAccount::LEN],
                false,
            );
        } else {
            let key = Pubkey::find_program_address(&[b"vault_authority", other.as_ref()], &ID).0;
            f.authority = info(key, system_program::ID, false, false, vec![], false);
        }
        f.reject();
    }
}
/// Insufficient balance and corrupted zero reward cannot initialize a retained escrow or change status.
#[test]
fn funding_rejects_insufficient_balance_and_zero_reward() {
    let _env = Environment::new();
    let f = Funding::new();
    f.source_state(|t| t.amount = 99);
    let before = f.snapshot();
    error(f.fund(), ProofOfWorkError::InsufficientEscrow);
    assert_eq!(f.snapshot(), before);
    let f = Funding::new();
    f.milestone_state(|m| m.reward_amount = 0);
    let before = f.snapshot();
    error(f.fund(), ProofOfWorkError::InvalidTerms);
    assert_eq!(f.snapshot(), before);
}
/// Funding must occur strictly before assign_by, and only from Created state.
#[test]
fn funding_rejects_deadline_boundary_and_all_other_states() {
    let _env = Environment::new();
    for now in [200, 201] {
        NOW.store(100, Ordering::SeqCst);
        let f = Funding::new();
        NOW.store(now, Ordering::SeqCst);
        f.reject();
    }
    NOW.store(100, Ordering::SeqCst);
    for state in [
        MilestoneStatus::Funded,
        MilestoneStatus::Assigned,
        MilestoneStatus::Submitted,
        MilestoneStatus::Verified,
        MilestoneStatus::Settled,
        MilestoneStatus::Refunded,
    ] {
        let f = Funding::new();
        f.milestone_state(|m| m.status = state);
        let before = f.snapshot();
        error(f.fund(), ProofOfWorkError::InvalidState);
        assert_eq!(f.snapshot(), before);
    }
}
/// A successfully funded vault cannot be initialized or funded twice.
#[test]
fn funding_rejects_duplicate_without_additional_transfer() {
    let _env = Environment::new();
    let f = Funding::new();
    f.fund().unwrap();
    f.reject();
    assert_eq!(
        TokenAccount::unpack(&f.source.try_borrow_data().unwrap())
            .unwrap()
            .amount,
        900
    );
    assert_eq!(
        TokenAccount::unpack(&f.vault.try_borrow_data().unwrap())
            .unwrap()
            .amount,
        100
    );
}
/// A real SPL rejection for a frozen source must restore the modeled account/rent snapshot.
#[test]
fn funding_token_processor_rejection_rolls_back() {
    let _env = Environment::new();
    let f = Funding::new();
    f.source_state(|t| t.state = AccountState::Frozen);
    f.reject();
}
/// Fault-injected CPI failure and post-transfer shortfall both fail closed with full modeled rollback.
#[test]
fn funding_failed_cpi_and_reloaded_balance_mismatch_roll_back() {
    let _env = Environment::new();
    for fault in [1, 2] {
        let f = Funding::new();
        FAULT.store(fault, Ordering::SeqCst);
        let before = f.snapshot();
        let result = f.fund();
        if fault == 1 {
            assert_eq!(result, Err(ProgramError::Custom(9001)));
        } else {
            error(result, ProofOfWorkError::InsufficientEscrow);
        }
        assert_eq!(f.snapshot(), before);
        FAULT.store(0, Ordering::SeqCst);
    }
}
/// Funds at the final valid second, including exact-balance and maximum-u64 raw token amounts.
#[test]
fn funding_accepts_deadline_before_cutoff_and_exact_or_maximum_balance() {
    let _env = Environment::new();
    for amount in [100, u64::MAX] {
        let f = Funding::new();
        f.source_state(|t| t.amount = amount);
        f.milestone_state(|m| m.reward_amount = amount);
        let mut mint = Mint::unpack(&f.mint.try_borrow_data().unwrap()).unwrap();
        mint.supply = amount;
        Mint::pack(mint, &mut f.mint.try_borrow_mut_data().unwrap()).unwrap();
        NOW.store(199, Ordering::SeqCst);
        f.fund().unwrap();
        assert_eq!(
            TokenAccount::unpack(&f.source.try_borrow_data().unwrap())
                .unwrap()
                .amount,
            0
        );
        assert_eq!(
            TokenAccount::unpack(&f.vault.try_borrow_data().unwrap())
                .unwrap()
                .amount,
            amount
        );
        NOW.store(100, Ordering::SeqCst);
    }
}

/// Neither the sponsor nor another signed wallet can spend, delegate or seize PDA-controlled escrow.
#[test]
fn funded_escrow_rejects_independent_wallet_withdrawals_and_authority_changes() {
    let _env = Environment::new();
    let f = Funding::new();
    f.fund().unwrap();
    assert!(!f.authority.key.is_on_curve());
    for caller in [*f.sponsor.key, public_key(210)] {
        // Signature privileges are modeled; no wallet or private key is generated.
        let signer = info(caller, system_program::ID, true, false, vec![], false);
        let before = f.snapshot();
        let transfer = spl_token::instruction::transfer_checked(
            &spl_token::ID,
            f.vault.key,
            f.mint.key,
            f.source.key,
            signer.key,
            &[],
            1,
            DEMO_DECIMALS,
        )
        .unwrap();
        assert_eq!(
            spl_token::processor::Processor::process(
                &spl_token::ID,
                &[
                    f.vault.clone(),
                    f.mint.clone(),
                    f.source.clone(),
                    signer.clone()
                ],
                &transfer.data
            ),
            Err(spl_token::error::TokenError::OwnerMismatch.into())
        );
        let delegate = info(
            public_key(220),
            system_program::ID,
            false,
            false,
            vec![],
            false,
        );
        let approve = spl_token::instruction::approve(
            &spl_token::ID,
            f.vault.key,
            delegate.key,
            signer.key,
            &[],
            1,
        )
        .unwrap();
        assert_eq!(
            spl_token::processor::Processor::process(
                &spl_token::ID,
                &[f.vault.clone(), delegate, signer.clone()],
                &approve.data
            ),
            Err(spl_token::error::TokenError::OwnerMismatch.into())
        );
        for kind in [
            spl_token::instruction::AuthorityType::AccountOwner,
            spl_token::instruction::AuthorityType::CloseAccount,
        ] {
            let change = spl_token::instruction::set_authority(
                &spl_token::ID,
                f.vault.key,
                Some(&caller),
                kind,
                signer.key,
                &[],
            )
            .unwrap();
            assert_eq!(
                spl_token::processor::Processor::process(
                    &spl_token::ID,
                    &[f.vault.clone(), signer.clone()],
                    &change.data
                ),
                Err(spl_token::error::TokenError::OwnerMismatch.into())
            );
        }
        assert_eq!(f.snapshot(), before);
    }
}

/// Real native funding composes with all existing verification handlers without changing escrow bindings.
#[test]
fn actual_funding_assignment_submission_and_attestation_preserve_escrow() {
    let _env = Environment::new();
    let f = Funding::new();
    f.fund().unwrap();
    let student = info(
        public_key(70),
        system_program::ID,
        true,
        true,
        vec![],
        false,
    );
    execute(
        vec![f.sponsor.clone(), f.internship.clone(), f.milestone.clone()],
        instruction::AssignStudent {
            student: *student.key,
        }
        .data(),
    )
    .unwrap();
    let (key, _) = Pubkey::find_program_address(&[SUBMISSION_SEED, f.milestone.key.as_ref()], &ID);
    let submission = info(
        key,
        system_program::ID,
        false,
        true,
        vec![0; Submission::SPACE],
        false,
    );
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
    let milestone: Milestone = load(&f.milestone);
    assert_eq!(milestone.status, MilestoneStatus::Verified);
    assert_eq!(milestone.reward_amount, 100);
    assert_eq!(
        milestone.vault_bump,
        Pubkey::find_program_address(&[b"vault", f.milestone.key.as_ref()], &ID).1
    );
    assert_eq!(
        milestone.vault_authority_bump,
        Pubkey::find_program_address(&[b"vault_authority", f.milestone.key.as_ref()], &ID).1
    );
    let vault = TokenAccount::unpack(&f.vault.try_borrow_data().unwrap()).unwrap();
    assert_eq!(vault.amount, 100);
    assert_eq!(vault.owner, *f.authority.key);
    assert_eq!(vault.delegate, COption::None);
    assert_eq!(vault.close_authority, COption::None);
}
