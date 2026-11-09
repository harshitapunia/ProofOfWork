//! Shared ProofOfWork Anchor accounts and instruction namespaces.

use anchor_lang::prelude::*;

pub mod config;
pub mod errors;
pub mod instructions;
pub mod seeds;
pub mod state;

pub use instructions::finance::*;
pub use instructions::verification::*;

declare_id!("J2FkqDuuuHT14gxjVMhSryrX3Bs4Knct45NMLA79dGdZ");

#[program]
pub mod proof_of_work {
    use super::*;

    /// Creates an internship PDA funded and authorized by its sponsor; rejects invalid accounts or reuse.
    pub fn create_internship(ctx: Context<CreateInternship>, internship_id: u64) -> Result<()> {
        instructions::finance::create_internship::handle_create_internship(ctx, internship_id)
    }
    /// Creates a sponsor-authorized `Created` milestone after validating its parent, DEMO mint and terms.
    /// Rejects invalid authority, verifier, reward, hash, deadlines or account initialization; moves no tokens.
    pub fn create_milestone(
        ctx: Context<CreateMilestone>,
        milestone_id: u64,
        reward_amount: u64,
        requirements_hash: [u8; 32],
        assign_by: i64,
        submit_by: i64,
        verifier: Pubkey,
    ) -> Result<()> {
        instructions::finance::create_milestone::handle_create_milestone(
            ctx,
            milestone_id,
            reward_amount,
            requirements_hash,
            assign_by,
            submit_by,
            verifier,
        )
    }

    /// Deposits the sponsor's full reward into the dedicated vault, then transitions Created to Funded.
    /// Rejects incorrect authority/accounts, expired terms, repeated funding or failed checked transfers.
    pub fn fund_milestone(ctx: Context<FundMilestone>) -> Result<()> {
        instructions::finance::fund_milestone::handle_fund_milestone(ctx)
    }

    /// Returns unclaimed escrow to the sponsor after the submission cutoff, then closes the vault.
    pub fn refund_unclaimed_milestone(ctx: Context<RefundUnclaimedMilestone>) -> Result<()> {
        instructions::finance::refund_unclaimed_milestone::handle_refund_unclaimed_milestone(ctx)
    }

    pub fn assign_student(ctx: Context<AssignStudent>, student: Pubkey) -> Result<()> {
        instructions::verification::assign_student::handle_assign_student(ctx, student)
    }

    pub fn submit_milestone(ctx: Context<SubmitMilestone>, evidence_hash: [u8; 32]) -> Result<()> {
        instructions::verification::submit_milestone::handle_submit_milestone(ctx, evidence_hash)
    }

    pub fn attest_milestone(
        ctx: Context<AttestMilestone>,
        expected_student: Pubkey,
        expected_requirements_hash: [u8; 32],
        expected_evidence_hash: [u8; 32],
    ) -> Result<()> {
        instructions::verification::attest_milestone::handle_attest_milestone(
            ctx,
            expected_student,
            expected_requirements_hash,
            expected_evidence_hash,
        )
    }
}
