use crate::{seeds::INTERNSHIP_SEED, state::Internship};
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(internship_id: u64)]
pub struct CreateInternship<'info> {
    #[account(mut)]
    pub sponsor: Signer<'info>,
    #[account(init, payer = sponsor, space = Internship::SPACE,
        seeds = [INTERNSHIP_SEED, sponsor.key().as_ref(), &internship_id.to_le_bytes()], bump)]
    pub internship: Account<'info, Internship>,
    pub system_program: Program<'info, System>,
}

/// Initializes the sponsor-scoped internship with its immutable sponsor, ID and canonical bump.
/// Anchor requires the sponsor signature and rent payment and rejects a wrong PDA or existing account.
pub fn handle_create_internship(ctx: Context<CreateInternship>, internship_id: u64) -> Result<()> {
    ctx.accounts.internship.set_inner(Internship {
        sponsor: ctx.accounts.sponsor.key(),
        internship_id,
        bump: ctx.bumps.internship,
    });
    Ok(())
}
