use crate::{
    config::{DEMO_DECIMALS, DEMO_MINT},
    errors::ProofOfWorkError,
    seeds::{vault_authority_seeds, vault_seeds, INTERNSHIP_SEED, MILESTONE_SEED},
    state::{Internship, Milestone, MilestoneStatus},
};
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token};

#[derive(Accounts)]
#[instruction(milestone_id: u64)]
pub struct CreateMilestone<'info> {
    #[account(mut, address = internship.sponsor @ ProofOfWorkError::InvalidRole)]
    pub sponsor: Signer<'info>,
    #[account(seeds = [INTERNSHIP_SEED, internship.sponsor.as_ref(), &internship.internship_id.to_le_bytes()], bump = internship.bump)]
    pub internship: Account<'info, Internship>,
    #[account(init, payer = sponsor, space = Milestone::SPACE,
        seeds = [MILESTONE_SEED, internship.key().as_ref(), &milestone_id.to_le_bytes()], bump)]
    pub milestone: Account<'info, Milestone>,
    #[account(address = DEMO_MINT @ ProofOfWorkError::InvalidMint,
        constraint = reward_mint.key() != anchor_spl::token::spl_token::native_mint::ID @ ProofOfWorkError::InvalidMint,
        constraint = reward_mint.freeze_authority.is_none() @ ProofOfWorkError::InvalidMint,
        constraint = reward_mint.decimals == DEMO_DECIMALS @ ProofOfWorkError::InvalidMint)]
    pub reward_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Creates an unfunded milestone with immutable terms, canonical vault bumps and unset work bindings.
/// Anchor requires the parent sponsor signature, canonical PDAs and the approved classic DEMO mint.
/// Returns `InvalidTerms` for zero reward/hash or invalid deadlines and `InvalidRole` for an invalid verifier;
/// account constraints reject an incorrect, native, freezable or wrong-decimal mint and duplicate creation.
pub fn handle_create_milestone(
    ctx: Context<CreateMilestone>,
    milestone_id: u64,
    reward_amount: u64,
    requirements_hash: [u8; 32],
    assign_by: i64,
    submit_by: i64,
    verifier: Pubkey,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        reward_amount > 0
            && requirements_hash != [0; 32]
            && 0 < now
            && now < assign_by
            && assign_by < submit_by,
        ProofOfWorkError::InvalidTerms
    );
    require!(
        verifier != Pubkey::default()
            && verifier.is_on_curve()
            && verifier != ctx.accounts.sponsor.key(),
        ProofOfWorkError::InvalidRole
    );
    let address = ctx.accounts.milestone.key();
    let (_, vault_bump) = Pubkey::find_program_address(&vault_seeds(&address), ctx.program_id);
    let (_, vault_authority_bump) =
        Pubkey::find_program_address(&vault_authority_seeds(&address), ctx.program_id);
    ctx.accounts.milestone.set_inner(Milestone {
        internship: ctx.accounts.internship.key(),
        sponsor: ctx.accounts.sponsor.key(),
        student: Pubkey::default(),
        verifier,
        reward_mint: ctx.accounts.reward_mint.key(),
        submission: Pubkey::default(),
        requirements_hash,
        milestone_id,
        reward_amount,
        assign_by,
        submit_by,
        verified_at: 0,
        status: MilestoneStatus::Created,
        bump: ctx.bumps.milestone,
        vault_bump,
        vault_authority_bump,
    });
    Ok(())
}
