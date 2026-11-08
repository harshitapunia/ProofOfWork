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

    pub fn create_internship(ctx: Context<CreateInternship>, internship_id: u64) -> Result<()> {
        instructions::finance::create_internship::handle_create_internship(ctx, internship_id)
    }
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
