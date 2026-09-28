//! An officer's freeze and its lifting (FR-014).
//!
//! **The token program does the freezing; this file decides who may ask and
//! remembers that someone did.** A frozen Token-2022 account can neither send
//! nor receive — the token program refuses both before the hook is ever
//! called — so FR-014 needs no rule in the hook. What it needs is the two
//! things the token program cannot give: that only the officer asks
//! (`authority::require_officer`), and that the freeze is not mistaken for
//! the default frozen state of an account nobody has onboarded yet
//! (`FreezeRecord`, which `thaw_holder` refuses to step over).
//!
//! **One signature, no quorum.** FR-019 puts the quorum on actions that touch
//! other people's funds — seizure and pause. A freeze moves nothing: the
//! funds stay where they are, and the one who froze them can be answered by
//! the same officer lifting it. That is also why this file adds no
//! `ActionKind`.
//!
//! **Every call states a reason (FR-017),** the lifting included: a record
//! that says why an account was frozen and not why it stopped being frozen is
//! half a record.
use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::state::AccountState;
use anchor_spl::token_interface::{
    freeze_account, thaw_account, FreezeAccount, Mint, ThawAccount, TokenAccount, TokenInterface,
};

use crate::authority::require_officer;
use crate::constants::{FREEZE_SEED, ISSUER_SEED, TOKEN_SEED};
use crate::error::ForgeError;
use crate::state::{ComplianceReason, FreezeRecord, IssuerConfig, TokenConfig};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct FreezeHolderArgs {
    pub reason: ComplianceReason,
}

/// An officer freezes one token account (FR-014).
#[derive(Accounts)]
pub struct FreezeHolder<'info> {
    #[account(
        seeds = [ISSUER_SEED, issuer_config.issuer_id.as_ref()],
        bump = issuer_config.bump,
    )]
    pub issuer_config: Account<'info, IssuerConfig>,

    #[account(
        seeds = [TOKEN_SEED, token_config.mint.as_ref()],
        bump = token_config.bump,
        constraint = token_config.issuer == issuer_config.key() @ ForgeError::TokenNotFromThisIssuer,
    )]
    pub token_config: Account<'info, TokenConfig>,

    #[account(constraint = mint.key() == token_config.mint @ ForgeError::HolderAccountMismatch)]
    pub mint: InterfaceAccount<'info, Mint>,

    /// Any account of this mint, whoever owns it. The owner is not an
    /// argument here, unlike in `thaw_holder`: nothing is derived from it, it
    /// is only written down.
    #[account(
        mut,
        constraint = token_account.mint == token_config.mint @ ForgeError::HolderAccountMismatch,
    )]
    pub token_account: InterfaceAccount<'info, TokenAccount>,

    /// `init`, not `init_if_needed`: an account frozen once is not frozen
    /// again on top. A second case against the same account is a matter for
    /// the case system; here the freeze either exists or it does not, and one
    /// record says by whom and why.
    #[account(
        init,
        payer = payer,
        space = 8 + FreezeRecord::INIT_SPACE,
        seeds = [FREEZE_SEED, token_account.key().as_ref()],
        bump,
    )]
    pub freeze_record: Account<'info, FreezeRecord>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub officer: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn freeze_handler(ctx: Context<FreezeHolder>, args: FreezeHolderArgs) -> Result<()> {
    require_officer(&ctx.accounts.issuer_config, &ctx.accounts.officer.key())?;
    args.reason.validate()?;

    let was_thawed = ctx.accounts.token_account.state != AccountState::Frozen;

    let record = &mut ctx.accounts.freeze_record;
    record.mint = ctx.accounts.token_config.mint;
    record.token_account = ctx.accounts.token_account.key();
    record.wallet = ctx.accounts.token_account.owner;
    record.officer = ctx.accounts.officer.key();
    record.payer = ctx.accounts.payer.key();
    record.reason = args.reason;
    record.frozen_at = Clock::get()?.unix_timestamp;
    record.was_thawed = was_thawed;
    record.bump = ctx.bumps.freeze_record;

    // An account nobody has onboarded is frozen already, and the token
    // program refuses to freeze a frozen account. The record is what matters
    // for it: without one, the first routine thaw would onboard an account
    // an officer meant to stop.
    if was_thawed {
        let mint_key = ctx.accounts.token_config.mint;
        let signer: &[&[u8]] = &[
            TOKEN_SEED,
            mint_key.as_ref(),
            &[ctx.accounts.token_config.bump],
        ];
        freeze_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            FreezeAccount {
                account: ctx.accounts.token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                authority: ctx.accounts.token_config.to_account_info(),
            },
            &[signer],
        ))?;
    }

    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UnfreezeHolderArgs {
    pub reason: ComplianceReason,
}

/// An officer lifts a freeze (FR-014).
///
/// The account goes back to the state it was frozen in, not to "thawed" —
/// see `FreezeRecord::was_thawed`.
#[derive(Accounts)]
pub struct UnfreezeHolder<'info> {
    #[account(
        seeds = [ISSUER_SEED, issuer_config.issuer_id.as_ref()],
        bump = issuer_config.bump,
    )]
    pub issuer_config: Account<'info, IssuerConfig>,

    #[account(
        seeds = [TOKEN_SEED, token_config.mint.as_ref()],
        bump = token_config.bump,
        constraint = token_config.issuer == issuer_config.key() @ ForgeError::TokenNotFromThisIssuer,
    )]
    pub token_config: Account<'info, TokenConfig>,

    #[account(constraint = mint.key() == token_config.mint @ ForgeError::HolderAccountMismatch)]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = token_account.mint == token_config.mint @ ForgeError::HolderAccountMismatch,
    )]
    pub token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [FREEZE_SEED, token_account.key().as_ref()],
        bump = freeze_record.bump,
        close = rent_recipient,
    )]
    pub freeze_record: Account<'info, FreezeRecord>,

    /// Whoever paid for the record gets the rent back, not whoever lifts it.
    /// CHECK: compared with `freeze_record.payer`; nothing is read from it.
    #[account(mut, address = freeze_record.payer)]
    pub rent_recipient: UncheckedAccount<'info>,

    pub officer: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub(crate) fn unfreeze_handler(
    ctx: Context<UnfreezeHolder>,
    args: UnfreezeHolderArgs,
) -> Result<()> {
    // Any officer, not only the one who froze it: the one who froze it may
    // have left, and a freeze nobody can lift is a seizure without a quorum.
    require_officer(&ctx.accounts.issuer_config, &ctx.accounts.officer.key())?;
    args.reason.validate()?;

    if ctx.accounts.freeze_record.was_thawed
        && ctx.accounts.token_account.state == AccountState::Frozen
    {
        let mint_key = ctx.accounts.token_config.mint;
        let signer: &[&[u8]] = &[
            TOKEN_SEED,
            mint_key.as_ref(),
            &[ctx.accounts.token_config.bump],
        ];
        thaw_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            ThawAccount {
                account: ctx.accounts.token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                authority: ctx.accounts.token_config.to_account_info(),
            },
            &[signer],
        ))?;
    }

    Ok(())
}
