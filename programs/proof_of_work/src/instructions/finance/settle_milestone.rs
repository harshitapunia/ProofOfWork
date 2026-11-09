use crate::{
    config::{DEMO_DECIMALS, DEMO_MINT},
    errors::ProofOfWorkError,
    seeds::{
        COMPLETION_SEED, INTERNSHIP_SEED, MILESTONE_SEED, SUBMISSION_SEED, VAULT_AUTHORITY_SEED,
        VAULT_SEED,
    },
    state::{CompletionRecord, Internship, Milestone, MilestoneStatus, Submission},
};
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::get_associated_token_address_with_program_id,
    token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked},
};

/// Approved permissionless settlement interface. Only the completion payer must sign.
#[derive(Accounts)]
pub struct SettleMilestone<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(seeds = [INTERNSHIP_SEED, internship.sponsor.as_ref(), &internship.internship_id.to_le_bytes()], bump = internship.bump)]
    pub internship: Account<'info, Internship>,
    #[account(mut,
        seeds = [MILESTONE_SEED, internship.key().as_ref(), &milestone.milestone_id.to_le_bytes()], bump = milestone.bump,
        has_one = internship @ ProofOfWorkError::BindingMismatch,
        constraint = milestone.sponsor == internship.sponsor @ ProofOfWorkError::BindingMismatch)]
    pub milestone: Account<'info, Milestone>,
    #[account(seeds = [SUBMISSION_SEED, milestone.key().as_ref()], bump = submission.bump,
        address = milestone.submission @ ProofOfWorkError::BindingMismatch,
        constraint = submission.milestone == milestone.key() @ ProofOfWorkError::BindingMismatch,
        constraint = submission.student == milestone.student @ ProofOfWorkError::BindingMismatch)]
    pub submission: Account<'info, Submission>,
    #[account(init, payer = caller, space = CompletionRecord::SPACE,
        seeds = [COMPLETION_SEED, milestone.key().as_ref()], bump)]
    pub completion_record: Account<'info, CompletionRecord>,
    #[account(address = DEMO_MINT @ ProofOfWorkError::InvalidMint,
        constraint = milestone.reward_mint == reward_mint.key() @ ProofOfWorkError::InvalidMint,
        constraint = reward_mint.key() != token::spl_token::native_mint::ID @ ProofOfWorkError::InvalidMint,
        constraint = reward_mint.freeze_authority.is_none() @ ProofOfWorkError::InvalidMint,
        constraint = reward_mint.decimals == DEMO_DECIMALS @ ProofOfWorkError::InvalidMint)]
    pub reward_mint: Account<'info, Mint>,
    #[account(mut, seeds = [VAULT_SEED, milestone.key().as_ref()], bump = milestone.vault_bump,
        token::mint = reward_mint, token::authority = vault_authority, token::token_program = token_program)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: Unallocated transfer authority; the stored canonical milestone-specific bump is validated.
    #[account(seeds = [VAULT_AUTHORITY_SEED, milestone.key().as_ref()], bump = milestone.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, token::mint = reward_mint, token::token_program = token_program,
        constraint = student_ata.owner == milestone.student @ ProofOfWorkError::InvalidDestination,
        address = get_associated_token_address_with_program_id(&milestone.student, &reward_mint.key(), &token_program.key()) @ ProofOfWorkError::InvalidDestination)]
    pub student_ata: Account<'info, TokenAccount>,
    #[account(mut, token::mint = reward_mint, token::token_program = token_program,
        constraint = sponsor_ata.owner == milestone.sponsor @ ProofOfWorkError::InvalidDestination,
        address = get_associated_token_address_with_program_id(&milestone.sponsor, &reward_mint.key(), &token_program.key()) @ ProofOfWorkError::InvalidDestination)]
    pub sponsor_ata: Account<'info, TokenAccount>,
    /// CHECK: Only receives vault lamports; the immutable sponsor address is checked, without a signature.
    #[account(mut, address = milestone.sponsor @ ProofOfWorkError::InvalidDestination)]
    pub sponsor: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Pays the exact reward, returns unsolicited surplus and vault rent to the sponsor, and records completion.
/// All CPI errors propagate: the Solana runtime atomically rolls back completion init and all movements.
pub fn handle_settle_milestone(ctx: Context<SettleMilestone>) -> Result<()> {
    let milestone = &ctx.accounts.milestone;
    let submission = &ctx.accounts.submission;
    require!(
        milestone.status == MilestoneStatus::Verified,
        ProofOfWorkError::InvalidState
    );
    require!(
        milestone.student != Pubkey::default()
            && milestone.student.is_on_curve()
            && milestone.student != milestone.sponsor
            && milestone.student != milestone.verifier
            && milestone.verifier != Pubkey::default()
            && milestone.verifier.is_on_curve()
            && milestone.verifier != milestone.sponsor,
        ProofOfWorkError::InvalidRole
    );
    require!(
        milestone.reward_amount > 0
            && milestone.requirements_hash != [0; 32]
            && submission.evidence_hash != [0; 32]
            && 0 < milestone.assign_by
            && milestone.assign_by < milestone.submit_by
            && submission.submitted_at > 0
            && submission.submitted_at < milestone.submit_by
            && milestone.verified_at >= submission.submitted_at,
        ProofOfWorkError::InvalidTerms
    );
    let vault = &ctx.accounts.vault;
    require!(
        vault.delegate.is_none() && vault.close_authority.is_none() && !vault.is_native(),
        ProofOfWorkError::InvalidVault
    );
    require!(
        vault.key() != ctx.accounts.student_ata.key()
            && vault.key() != ctx.accounts.sponsor_ata.key()
            && ctx.accounts.student_ata.key() != ctx.accounts.sponsor_ata.key(),
        ProofOfWorkError::InvalidDestination
    );
    require!(
        vault.amount >= milestone.reward_amount,
        ProofOfWorkError::InsufficientEscrow
    );
    let surplus = vault
        .amount
        .checked_sub(milestone.reward_amount)
        .ok_or(ProofOfWorkError::ArithmeticOverflow)?;
    let settled_at = Clock::get()?.unix_timestamp;
    let milestone_key = milestone.key();
    let bump = [milestone.vault_authority_bump];
    let authority_seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, milestone_key.as_ref(), &bump];
    let signer_seeds = &[authority_seeds];
    let transfer = |destination, amount| {
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.reward_mint.to_account_info(),
                    to: destination,
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
            ctx.accounts.reward_mint.decimals,
        )
    };
    transfer(
        ctx.accounts.student_ata.to_account_info(),
        milestone.reward_amount,
    )?;
    if surplus > 0 {
        transfer(ctx.accounts.sponsor_ata.to_account_info(), surplus)?;
    }
    ctx.accounts.vault.reload()?;
    require!(
        ctx.accounts.vault.amount == 0,
        ProofOfWorkError::InvalidVault
    );
    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.sponsor.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        },
        signer_seeds,
    ))?;
    ctx.accounts.completion_record.set_inner(CompletionRecord {
        milestone: milestone_key,
        student: milestone.student,
        sponsor: milestone.sponsor,
        verifier: milestone.verifier,
        submission: submission.key(),
        requirements_hash: milestone.requirements_hash,
        evidence_hash: submission.evidence_hash,
        verified_at: milestone.verified_at,
        settled_at,
        bump: ctx.bumps.completion_record,
    });
    ctx.accounts.milestone.status = MilestoneStatus::Settled;
    Ok(())
}
