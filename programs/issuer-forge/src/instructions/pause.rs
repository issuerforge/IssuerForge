//! Pausing circulation of a token and lifting the pause (FR-016).
//!
//! **The pause is the mint's own.** `Pausable` on the mint is authoritative:
//! the token program refuses every transfer, every mint and every burn while
//! it is set, before it would call the hook, so no rule of ours has to be
//! right for a pause to hold. The authority is the `TokenConfig` PDA, and
//! this file is the only place that signs for it to pause or resume —
//! `TokenConfig.paused_at` is written beside it as a mirror for the journal
//! and the screens, and nothing reads the mirror to decide anything.
//!
//! **Only through a proposal (FR-019), as a seizure.** A pause stops other
//! people's funds, so it takes the quorum and a reason (FR-017), and the
//! approvers are named after the accounts (FR-019c) for the same reason as
//! in `seize.rs`. The urgent case needs no second path either:
//! `propose_action`, `approve_action` and this instruction fit in one
//! transaction signed by two members.
//!
//! **A pause of a paused mint is refused, and so is the lifting of a pause
//! that is not there.** The token program would accept both in silence; the
//! journal would then show a second pause under another case that changed
//! nothing, and the mirror would move to a moment when nothing happened.
//!
//! **"Except the issuer's own actions" (FR-016) is the seizure.** It burns
//! and mints, both of which a pause refuses to any authority, so `seize`
//! lifts the pause for the length of its own instruction and puts it back
//! (`resume_for` and `pause_for` below). Nobody else's instruction can run
//! inside that window: it is one instruction, and the pause is set again
//! before it returns.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::spl_token_2022::extension::pausable::{self, PausableConfig};
use anchor_spl::token_2022::spl_token_2022::extension::{
    BaseStateWithExtensions, StateWithExtensions,
};
use anchor_spl::token_2022::spl_token_2022::state::Mint as SplMint;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::constants::{ISSUER_SEED, PROPOSAL_SEED, TOKEN_SEED};
use crate::error::ForgeError;
use crate::quorum;
use crate::state::{ActionKind, ActionProposal, ComplianceReason, IssuerConfig, TokenConfig};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CirculationArgs {
    /// Repeated from the proposal, as in `seize`: the program compares the
    /// two, and the journal reads the reason from this instruction.
    pub reason: ComplianceReason,
}

/// One account list for both directions: pausing and resuming touch the same
/// accounts and differ only in which way the flag goes.
#[derive(Accounts)]
pub struct ChangeCirculation<'info> {
    #[account(
        seeds = [ISSUER_SEED, issuer_config.issuer_id.as_ref()],
        bump = issuer_config.bump,
    )]
    pub issuer_config: Box<Account<'info, IssuerConfig>>,

    /// Writable for the mirror; also the pause authority the program signs as.
    #[account(
        mut,
        seeds = [TOKEN_SEED, token_config.mint.as_ref()],
        bump = token_config.bump,
        constraint = token_config.issuer == issuer_config.key() @ ForgeError::TokenNotFromThisIssuer,
    )]
    pub token_config: Box<Account<'info, TokenConfig>>,

    #[account(
        mut,
        constraint = mint.key() == token_config.mint @ ForgeError::HolderAccountMismatch,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        seeds = [PROPOSAL_SEED, proposal.mint.as_ref(), &proposal.nonce.to_le_bytes()],
        bump = proposal.bump,
        constraint = proposal.issuer == issuer_config.key() @ ForgeError::ProposalNotForThisIssuer,
    )]
    pub proposal: Box<Account<'info, ActionProposal>>,

    pub token_program: Interface<'info, TokenInterface>,
    // `remaining_accounts` are the proposal's approvers, in its order —
    // read-only and unsigned, as in `seize`. There is no signer of our own:
    // executing a matured proposal grants nothing, whoever pays the fee.
}

/// Whether the mint's circulation is paused, read from the extension itself.
///
/// A mint without `Pausable` reads as never paused: `create_token` always
/// adds it, and a mint without it is one no pause could have been set on.
pub(crate) fn is_paused(mint: &AccountInfo) -> Result<bool> {
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<SplMint>::unpack(&data)?;
    Ok(state
        .get_extension::<PausableConfig>()
        .map(|config| bool::from(config.paused))
        .unwrap_or(false))
}

fn toggle<'info>(
    token_program: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    token_config: &Account<'info, TokenConfig>,
    pause: bool,
) -> Result<()> {
    let authority = token_config.key();
    let instruction = if pause {
        pausable::instruction::pause(token_program.key, mint.key, &authority, &[])?
    } else {
        pausable::instruction::resume(token_program.key, mint.key, &authority, &[])?
    };
    let mint_key = token_config.mint;
    let signer: &[&[u8]] = &[TOKEN_SEED, mint_key.as_ref(), &[token_config.bump]];
    invoke_signed(
        &instruction,
        &[
            mint.clone(),
            token_config.to_account_info(),
            token_program.clone(),
        ],
        &[signer],
    )?;
    Ok(())
}

/// Lifts the pause for the rest of one instruction; `pause_for` puts it back.
pub(crate) fn resume_for<'info>(
    token_program: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    token_config: &Account<'info, TokenConfig>,
) -> Result<()> {
    toggle(token_program, mint, token_config, false)
}

pub(crate) fn pause_for<'info>(
    token_program: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    token_config: &Account<'info, TokenConfig>,
) -> Result<()> {
    toggle(token_program, mint, token_config, true)
}

pub(crate) fn pause_handler(ctx: Context<ChangeCirculation>, args: CirculationArgs) -> Result<()> {
    change(ctx, ActionKind::pause(args.reason)?, true)
}

pub(crate) fn resume_handler(ctx: Context<ChangeCirculation>, args: CirculationArgs) -> Result<()> {
    change(ctx, ActionKind::resume(args.reason)?, false)
}

fn change(ctx: Context<ChangeCirculation>, action: ActionKind, pause: bool) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let accounts = &ctx.accounts;

    require!(
        accounts.proposal.mint == accounts.token_config.mint,
        ForgeError::ProposalNotForThisToken
    );
    accounts.proposal.live(now)?;
    // The variant is compared along with the reason: a proposal to pause
    // must never execute as a resumption, nor the other way round.
    require!(
        action == accounts.proposal.action,
        ForgeError::ProposalBodyMismatch
    );
    let approvals = accounts.proposal.approvals();
    quorum::check(&accounts.issuer_config, approvals)?;
    quorum::require_listed(ctx.remaining_accounts, approvals)?;

    let mint = accounts.mint.to_account_info();
    if pause {
        require!(!is_paused(&mint)?, ForgeError::MintAlreadyPaused);
    } else {
        require!(is_paused(&mint)?, ForgeError::MintNotPaused);
    }
    toggle(
        &accounts.token_program.to_account_info(),
        &mint,
        &accounts.token_config,
        pause,
    )?;

    ctx.accounts.token_config.paused_at = if pause { now } else { 0 };
    // The last action, as in `seize`.
    ctx.accounts.proposal.executed_at = now;
    Ok(())
}
