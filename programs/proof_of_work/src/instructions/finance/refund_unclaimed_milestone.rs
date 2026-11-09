use crate::{
    config::{DEMO_DECIMALS, DEMO_MINT},
    errors::ProofOfWorkError,
    seeds::{INTERNSHIP_SEED, MILESTONE_SEED, VAULT_AUTHORITY_SEED, VAULT_SEED},
    state::{Internship, Milestone, MilestoneStatus},
};
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::get_associated_token_address_with_program_id,
    token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked},
};

/// Approved sponsor-only refund interface. The sponsor also receives the vault's lamports.
#[derive(Accounts)]
pub struct RefundUnclaimedMilestone<'info> {
    #[account(mut, address = internship.sponsor @ ProofOfWorkError::InvalidRole)]
    pub sponsor: Signer<'info>,
    #[account(seeds = [INTERNSHIP_SEED, internship.sponsor.as_ref(), &internship.internship_id.to_le_bytes()], bump = internship.bump)]
    pub internship: Account<'info, Internship>,
    #[account(mut,
        seeds = [MILESTONE_SEED, internship.key().as_ref(), &milestone.milestone_id.to_le_bytes()], bump = milestone.bump,
        has_one = internship @ ProofOfWorkError::BindingMismatch,
        constraint = milestone.sponsor == internship.sponsor @ ProofOfWorkError::BindingMismatch)]
    pub milestone: Account<'info, Milestone>,
    #[account(address = DEMO_MINT @ ProofOfWorkError::InvalidMint,
        constraint = milestone.reward_mint == reward_mint.key() @ ProofOfWorkError::InvalidMint,
        constraint = reward_mint.key() != token::spl_token::native_mint::ID @ ProofOfWorkError::InvalidMint,
        constraint = reward_mint.freeze_authority.is_none() @ ProofOfWorkError::InvalidMint,
        constraint = reward_mint.decimals == DEMO_DECIMALS @ ProofOfWorkError::InvalidMint)]
    pub reward_mint: Account<'info, Mint>,
    #[account(mut, seeds = [VAULT_SEED, milestone.key().as_ref()], bump = milestone.vault_bump,
        token::mint = reward_mint, token::authority = vault_authority, token::token_program = token_program)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: Unallocated transfer authority; validated milestone-specific seeds and stored canonical bump.
    #[account(seeds = [VAULT_AUTHORITY_SEED, milestone.key().as_ref()], bump = milestone.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, token::mint = reward_mint, token::authority = sponsor, token::token_program = token_program,
        address = get_associated_token_address_with_program_id(&sponsor.key(), &reward_mint.key(), &token_program.key()) @ ProofOfWorkError::InvalidDestination)]
    pub sponsor_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// Returns principal, surplus and vault rent only for expired milestones with no submitted work.
/// CPI failures propagate; transaction atomicity is provided by the Solana runtime, without compensation.
pub fn handle_refund_unclaimed_milestone(ctx: Context<RefundUnclaimedMilestone>) -> Result<()> {
    let milestone = &ctx.accounts.milestone;
    require!(
        matches!(
            milestone.status,
            MilestoneStatus::Funded | MilestoneStatus::Assigned
        ),
        ProofOfWorkError::InvalidState
    );
    require!(
        milestone.submission == Pubkey::default() && milestone.verified_at == 0,
        ProofOfWorkError::BindingMismatch
    );
    require!(
        milestone.reward_amount > 0
            && 0 < milestone.assign_by
            && milestone.assign_by < milestone.submit_by,
        ProofOfWorkError::InvalidTerms
    );
    require!(
        Clock::get()?.unix_timestamp >= milestone.submit_by,
        ProofOfWorkError::RefundTooEarly
    );
    let vault = &ctx.accounts.vault;
    require!(
        vault.delegate.is_none() && vault.close_authority.is_none() && !vault.is_native(),
        ProofOfWorkError::InvalidVault
    );
    require!(
        vault.key() != ctx.accounts.sponsor_ata.key(),
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
    let refund_amount = milestone
        .reward_amount
        .checked_add(surplus)
        .ok_or(ProofOfWorkError::ArithmeticOverflow)?;
    let milestone_key = milestone.key();
    let bump = [milestone.vault_authority_bump];
    let authority_seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, milestone_key.as_ref(), &bump];
    let signer_seeds = &[authority_seeds];
    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.reward_mint.to_account_info(),
                to: ctx.accounts.sponsor_ata.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        ),
        refund_amount,
        ctx.accounts.reward_mint.decimals,
    )?;
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
    ctx.accounts.milestone.status = MilestoneStatus::Refunded;
    Ok(())
}
