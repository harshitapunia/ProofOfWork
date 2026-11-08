use crate::{
    config::{DEMO_DECIMALS, DEMO_MINT},
    errors::ProofOfWorkError,
    seeds::{INTERNSHIP_SEED, MILESTONE_SEED, VAULT_AUTHORITY_SEED, VAULT_SEED},
    state::{Internship, Milestone, MilestoneStatus},
};
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::get_associated_token_address_with_program_id,
    token::{self, Mint, Token, TokenAccount, TransferChecked},
};

#[derive(Accounts)]
pub struct FundMilestone<'info> {
    #[account(mut, address = internship.sponsor @ ProofOfWorkError::InvalidRole)]
    pub sponsor: Signer<'info>,
    #[account(seeds = [INTERNSHIP_SEED, internship.sponsor.as_ref(), &internship.internship_id.to_le_bytes()], bump = internship.bump)]
    pub internship: Account<'info, Internship>,
    #[account(mut, seeds = [MILESTONE_SEED, internship.key().as_ref(), &milestone.milestone_id.to_le_bytes()], bump = milestone.bump,
        has_one = internship @ ProofOfWorkError::BindingMismatch,
        constraint = milestone.sponsor == internship.sponsor @ ProofOfWorkError::BindingMismatch)]
    pub milestone: Account<'info, Milestone>,
    #[account(address = DEMO_MINT @ ProofOfWorkError::InvalidMint,
        constraint = milestone.reward_mint == reward_mint.key() @ ProofOfWorkError::InvalidMint,
        constraint = reward_mint.key() != token::spl_token::native_mint::ID @ ProofOfWorkError::InvalidMint,
        constraint = reward_mint.freeze_authority.is_none() @ ProofOfWorkError::InvalidMint,
        constraint = reward_mint.decimals == DEMO_DECIMALS @ ProofOfWorkError::InvalidMint)]
    pub reward_mint: Account<'info, Mint>,
    #[account(mut, token::mint = reward_mint, token::authority = sponsor, token::token_program = token_program,
        address = get_associated_token_address_with_program_id(&sponsor.key(), &reward_mint.key(), &token_program.key()) @ ProofOfWorkError::InvalidDestination)]
    pub sponsor_ata: Account<'info, TokenAccount>,
    #[account(init, payer = sponsor, seeds = [VAULT_SEED, milestone.key().as_ref()], bump,
        token::mint = reward_mint, token::authority = vault_authority, token::token_program = token_program)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: Unallocated transfer authority; canonical milestone-specific seeds checked by Anchor.
    #[account(seeds = [VAULT_AUTHORITY_SEED, milestone.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Funds a fresh classic SPL vault with exactly the sponsor's recorded positive reward before assign_by.
/// Requires Created state, the canonical sponsor ATA and both previously recorded canonical vault bumps.
/// Rejects invalid state, late funding, insufficient tokens or a mismatched reloaded escrow balance.
/// All CPIs must succeed before Funded is written; transaction rollback is supplied by the Solana runtime.
pub fn handle_fund_milestone(ctx: Context<FundMilestone>) -> Result<()> {
    let milestone = &ctx.accounts.milestone;
    require!(
        milestone.status == MilestoneStatus::Created,
        ProofOfWorkError::InvalidState
    );
    require!(
        Clock::get()?.unix_timestamp < milestone.assign_by,
        ProofOfWorkError::DeadlinePassed
    );
    require!(milestone.reward_amount > 0, ProofOfWorkError::InvalidTerms);
    require!(
        ctx.bumps.vault == milestone.vault_bump
            && ctx.bumps.vault_authority == milestone.vault_authority_bump,
        ProofOfWorkError::InvalidVault
    );
    let vault = &ctx.accounts.vault;
    require!(
        vault.amount == 0
            && vault.delegate.is_none()
            && vault.close_authority.is_none()
            && !vault.is_native(),
        ProofOfWorkError::InvalidVault
    );
    require!(
        ctx.accounts.sponsor_ata.key() != vault.key(),
        ProofOfWorkError::InvalidDestination
    );
    require!(
        ctx.accounts.sponsor_ata.amount >= milestone.reward_amount,
        ProofOfWorkError::InsufficientEscrow
    );
    let amount = milestone.reward_amount;
    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.sponsor_ata.to_account_info(),
                mint: ctx.accounts.reward_mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.sponsor.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.reward_mint.decimals,
    )?;
    ctx.accounts.vault.reload()?;
    require!(
        ctx.accounts.vault.amount == amount,
        ProofOfWorkError::InsufficientEscrow
    );
    ctx.accounts.milestone.status = MilestoneStatus::Funded;
    Ok(())
}
