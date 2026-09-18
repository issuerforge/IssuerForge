use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::state::AccountState;
use anchor_spl::token_interface::{
    thaw_account, Mint, ThawAccount, TokenAccount, TokenInterface,
};

use crate::authority::require_routine;
use crate::constants::{HOLDER_SEED, ISSUER_SEED, TOKEN_SEED, VELOCITY_SEED};
use crate::error::ForgeError;
use crate::state::{delegation, HolderStatus, HolderStatusInput, IssuerConfig, TokenConfig, VelocityCounter};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ThawHolderArgs {
    /// The account owner. Must match the token account's `owner` — otherwise
    /// the status would land at an address a transfer never reads.
    pub wallet: Pubkey,
    /// The initial status — only for the **first** thaw.
    ///
    /// `None` means "the record already exists, I am not touching it": that
    /// is what a repeat thaw after an officer's freeze looks like (T026). A
    /// mismatch between the intent and the account state is rejected, not
    /// interpreted, so no call changes the status silently.
    pub status: Option<HolderStatusInput>,
}

/// Thawing a holder's account (FR-008b).
///
/// **The hook creates no accounts** — it has neither a payer nor a system
/// program signature — so `HolderStatus` and `VelocityCounter` are created
/// here, in advance. An account that lacks them gets a transfer refusal, not
/// a skipped check (FR-013).
///
/// A thaw **is not a permission to transfer** (FR-008b1): it only lifts
/// `DefaultAccountState = Frozen`, after which every transfer goes through
/// the policy rules separately. An account thawed yesterday is refused today
/// if its status no longer satisfies the current version.
#[derive(Accounts)]
#[instruction(args: ThawHolderArgs)]
pub struct ThawHolder<'info> {
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

    #[account(
        mut,
        constraint = mint.key() == token_config.mint @ ForgeError::HolderAccountMismatch,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    /// The holder's token account. Both checks are mandatory: the account
    /// address proves neither its mint nor its owner, and the status is
    /// derived from `wallet` specifically.
    #[account(
        mut,
        constraint = token_account.mint == token_config.mint @ ForgeError::HolderAccountMismatch,
        constraint = token_account.owner == args.wallet @ ForgeError::HolderAccountMismatch,
    )]
    pub token_account: InterfaceAccount<'info, TokenAccount>,

    /// `init_if_needed`, because an account is legitimately thawed a second
    /// time — after an officer's freeze. A repeat creation overwrites
    /// nothing: what is written is decided by `updated_at`, not by the
    /// account's existence.
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + HolderStatus::INIT_SPACE,
        seeds = [HOLDER_SEED, token_config.mint.as_ref(), args.wallet.as_ref()],
        bump,
    )]
    pub holder_status: Account<'info, HolderStatus>,

    /// Likewise `init_if_needed` — and **no window value is written here**,
    /// only the account's own identity. Resetting the window with the
    /// operational key would lift the period limit with a routine action,
    /// i.e. grant a power the delegation mask does not have and cannot have
    /// (FR-035a).
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + VelocityCounter::INIT_SPACE,
        seeds = [VELOCITY_SEED, token_config.mint.as_ref(), args.wallet.as_ref()],
        bump,
    )]
    pub velocity_counter: Account<'info, VelocityCounter>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// The platform's operational key or an authorised member of the membership.
    pub authority: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn thaw_handler(ctx: Context<ThawHolder>, args: ThawHolderArgs) -> Result<()> {
    require_routine(
        &ctx.accounts.issuer_config,
        &ctx.accounts.authority.key(),
        delegation::THAW_HOLDER,
    )?;

    let now = Clock::get()?.unix_timestamp;
    let holder = &mut ctx.accounts.holder_status;

    match (holder.is_written(), args.status) {
        // The first thaw: the status comes with it.
        (false, Some(status)) => {
            holder.mint = ctx.accounts.token_config.mint;
            holder.wallet = args.wallet;
            holder.bump = ctx.bumps.holder_status;
            holder.apply(&status, now)?;
        }
        // A repeat: the status already exists, and only `set_holder_status`
        // changes it — under its own delegation power. Otherwise a key with
        // nothing but `THAW_HOLDER` would overwrite the status registry
        // through a repeat call.
        (true, None) => {}
        (false, None) => return err!(ForgeError::HolderStatusRequired),
        (true, Some(_)) => return err!(ForgeError::HolderStatusAlreadySet),
    }

    // The counter: only its own identity. The window values stay as the last
    // transfer left them — which is exactly why they are not mentioned here.
    let counter = &mut ctx.accounts.velocity_counter;
    counter.mint = ctx.accounts.token_config.mint;
    counter.wallet = args.wallet;
    counter.bump = ctx.bumps.velocity_counter;

    // A frozen account is the default state (`DefaultAccountState`), but the
    // token program would reject thawing an already thawed one, while the
    // status accounts are already created by then. Skipping here makes the
    // instruction idempotent for what it is called a second time for.
    if ctx.accounts.token_account.state == AccountState::Frozen {
        let mint_key = ctx.accounts.token_config.mint;
        let signer: &[&[u8]] = &[TOKEN_SEED, mint_key.as_ref(), &[ctx.accounts.token_config.bump]];
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

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SetHolderStatusArgs {
    pub wallet: Pubkey,
    pub status: HolderStatusInput,
}

/// Updating the issuer's own status registry (FR-008a, FR-008b1).
///
/// The second half of the pair: `thaw_holder` creates the record, this
/// instruction changes it — lowers the tier, changes the jurisdiction, sets
/// an expiry or turns on `denied`. It is what makes FR-008b1 enforceable:
/// the account stays thawed, and a transfer from it stops passing that very
/// moment, because the status is read on **every** transfer, not at thaw
/// time.
///
/// There is deliberately no token account here: a status change freezes
/// nothing. A freeze is a separate compliance action with a reason and a
/// case (T026, FR-014).
#[derive(Accounts)]
#[instruction(args: SetHolderStatusArgs)]
pub struct SetHolderStatus<'info> {
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

    /// Without `init`: this instruction does not create a record that does
    /// not exist. Creation is tied to the thaw, because a status without a
    /// thawed account means nothing, and a `HolderStatus` without a
    /// `VelocityCounter` would give a transfer refusal where the issuer
    /// considers the holder in order.
    #[account(
        mut,
        seeds = [HOLDER_SEED, token_config.mint.as_ref(), args.wallet.as_ref()],
        bump = holder_status.bump,
    )]
    pub holder_status: Account<'info, HolderStatus>,

    pub authority: Signer<'info>,
}

pub(crate) fn set_status_handler(
    ctx: Context<SetHolderStatus>,
    args: SetHolderStatusArgs,
) -> Result<()> {
    require_routine(
        &ctx.accounts.issuer_config,
        &ctx.accounts.authority.key(),
        delegation::SET_HOLDER_STATUS,
    )?;

    let now = Clock::get()?.unix_timestamp;
    ctx.accounts.holder_status.apply(&args.status, now)
}
