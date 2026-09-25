//! Deferred signing of a quorum action (FR-019b).
//!
//! **What is new here is the delay, not the quorum.** The threshold rule came
//! with T014 and lives in `quorum.rs`; it is called from here over the
//! addresses the proposal collected exactly as `set_policy` calls it over the
//! signers of one transaction. Nothing about "how many, and whose" changes
//! because the signatures arrived on different days.
//!
//! **A proposal authorises nothing by itself.** It holds a body and a list of
//! addresses; the on-chain effect belongs to the instruction of the action,
//! which takes this account and refuses unless the quorum is in it. That is
//! FR-019b read literally — an action below the quorum "is visible in the
//! console, has no on-chain effect" — and it is also what Anchor forces: the
//! accounts a seizure needs are not the accounts a pause needs, and one
//! instruction has one account list.
//!
//! **The term is the revocation.** FR-019b asks for a term after which the
//! proposal is revoked; here that is the passage of time and not an
//! instruction anyone has to remember to send. `close_action_proposal` only
//! returns the rent afterwards — it decides nothing.
use anchor_lang::prelude::*;

use crate::constants::{ISSUER_SEED, MAX_MEMBERS, PROPOSAL_SEED, TOKEN_SEED};
use crate::error::ForgeError;
use crate::state::{
    role, validate_term, ActionProposal, IssuerConfig, ProposedAction, TokenConfig,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProposeActionArgs {
    /// The client-chosen number in the seeds.
    pub nonce: u64,
    /// How long the proposal may gather signatures, in seconds from now.
    /// Bounds in `state::proposal`.
    pub term_seconds: i64,
    /// The action with its body in full. What the account keeps is the body's
    /// digest; the body itself stays in this instruction's data, which is
    /// where this project's indexer reads everything from.
    pub action: ProposedAction,
}

/// Raising a proposal. The proposer's signature is the first approval.
///
/// The proposer must be a member who may authorise actions — an observer and
/// an attestor cannot raise one either. That is not a formality: a proposal
/// visible in the console is a claim about what the issuer intends, and the
/// right to make that claim is the same right as the right to sign it.
#[derive(Accounts)]
#[instruction(args: ProposeActionArgs)]
pub struct ProposeAction<'info> {
    #[account(
        seeds = [ISSUER_SEED, issuer_config.issuer_id.as_ref()],
        bump = issuer_config.bump,
    )]
    pub issuer_config: Account<'info, IssuerConfig>,

    /// The token the action is about. Present so that a proposal cannot be
    /// raised against a mint this issuer does not own: an approver reading
    /// the console must not have to check that themselves.
    #[account(
        seeds = [TOKEN_SEED, token_config.mint.as_ref()],
        bump = token_config.bump,
        constraint = token_config.issuer == issuer_config.key() @ ForgeError::TokenNotFromThisIssuer,
    )]
    pub token_config: Account<'info, TokenConfig>,

    #[account(
        init,
        payer = payer,
        space = 8 + ActionProposal::INIT_SPACE,
        seeds = [PROPOSAL_SEED, token_config.mint.as_ref(), &args.nonce.to_le_bytes()],
        bump,
    )]
    pub proposal: Box<Account<'info, ActionProposal>>,

    /// Who pays the rent. Separate from `proposer` on purpose: the platform
    /// may carry the cost of a proposal, and paying for it must grant nothing.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub proposer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub(crate) fn propose_handler(
    ctx: Context<ProposeAction>,
    args: ProposeActionArgs,
) -> Result<()> {
    require!(
        ctx.accounts
            .issuer_config
            .member_has(&ctx.accounts.proposer.key(), role::AUTHORISING),
        ForgeError::NotAnAuthorisingSigner
    );
    validate_term(args.term_seconds)?;

    // The body is checked before anyone is asked to approve it. A digest of
    // bytes that could not have come out of `encode` would collect signatures
    // for days and only then fail at execution.
    let action = args.action.stored()?;

    let now = Clock::get()?.unix_timestamp;
    let proposal = &mut ctx.accounts.proposal;
    proposal.mint = ctx.accounts.token_config.mint;
    proposal.issuer = ctx.accounts.issuer_config.key();
    proposal.payer = ctx.accounts.payer.key();
    proposal.nonce = args.nonce;
    proposal.action = action;
    proposal.approvals = [Pubkey::default(); MAX_MEMBERS];
    proposal.approval_count = 0;
    proposal.created_at = now;
    // `checked_add` rather than `+`: the term is a signed argument, and a
    // bound check that overflows first proves nothing.
    proposal.expires_at = now
        .checked_add(args.term_seconds)
        .ok_or(ForgeError::ProposalTermOutOfRange)?;
    proposal.executed_at = 0;
    proposal.bump = ctx.bumps.proposal;

    proposal.add_approval(ctx.accounts.proposer.key())?;
    Ok(())
}

/// Adding a signature to a proposal already raised.
///
/// Membership is checked here **and** again at execution, and the second
/// check is the one that counts: a member removed in between stops filling
/// the quorum, because `quorum::check` reads the membership as it is at the
/// moment of the action, not as it was when the signature was given.
#[derive(Accounts)]
pub struct ApproveAction<'info> {
    #[account(
        seeds = [ISSUER_SEED, issuer_config.issuer_id.as_ref()],
        bump = issuer_config.bump,
    )]
    pub issuer_config: Account<'info, IssuerConfig>,

    #[account(
        mut,
        seeds = [PROPOSAL_SEED, proposal.mint.as_ref(), &proposal.nonce.to_le_bytes()],
        bump = proposal.bump,
        constraint = proposal.issuer == issuer_config.key() @ ForgeError::ProposalNotForThisIssuer,
    )]
    pub proposal: Box<Account<'info, ActionProposal>>,

    pub approver: Signer<'info>,
}

pub(crate) fn approve_handler(ctx: Context<ApproveAction>) -> Result<()> {
    require!(
        ctx.accounts
            .issuer_config
            .member_has(&ctx.accounts.approver.key(), role::AUTHORISING),
        ForgeError::NotAnAuthorisingSigner
    );

    let now = Clock::get()?.unix_timestamp;
    let proposal = &mut ctx.accounts.proposal;
    proposal.live(now)?;
    proposal.add_approval(ctx.accounts.approver.key())?;
    Ok(())
}

/// Returning the rent of a proposal that is over — executed, or past its term.
///
/// **This instruction revokes nothing.** The revocation already happened when
/// the term ran out; what is left is an account nobody needs. It is here so
/// that the rent of every lapsed proposal does not stay locked forever, and
/// it goes back to whoever paid it, not to whoever closes it.
///
/// The named record of who authorised the action does not live here: it lives
/// in the journal, which the indexer builds from the `propose` and `approve`
/// instructions themselves (FR-019c, FR-018).
#[derive(Accounts)]
pub struct CloseActionProposal<'info> {
    #[account(
        seeds = [ISSUER_SEED, issuer_config.issuer_id.as_ref()],
        bump = issuer_config.bump,
    )]
    pub issuer_config: Account<'info, IssuerConfig>,

    #[account(
        mut,
        seeds = [PROPOSAL_SEED, proposal.mint.as_ref(), &proposal.nonce.to_le_bytes()],
        bump = proposal.bump,
        constraint = proposal.issuer == issuer_config.key() @ ForgeError::ProposalNotForThisIssuer,
        close = rent_recipient,
    )]
    pub proposal: Box<Account<'info, ActionProposal>>,

    /// Whoever paid the rent gets it back. Pinned to the address in the
    /// account, so closing is not a way to collect other people's lamports.
    /// CHECK: compared with `proposal.payer`; nothing is read from it.
    #[account(mut, address = proposal.payer)]
    pub rent_recipient: UncheckedAccount<'info>,

    /// A member who may authorise actions. Closing decides nothing, but
    /// leaving it open to anyone would let a stranger erase the account the
    /// console reads a finished action from.
    pub member: Signer<'info>,
}

pub(crate) fn close_handler(ctx: Context<CloseActionProposal>) -> Result<()> {
    require!(
        ctx.accounts
            .issuer_config
            .member_has(&ctx.accounts.member.key(), role::AUTHORISING),
        ForgeError::NotAnAuthorisingSigner
    );

    let now = Clock::get()?.unix_timestamp;
    ctx.accounts.proposal.closable(now)?;
    Ok(())
}
