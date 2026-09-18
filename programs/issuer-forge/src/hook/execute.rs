//! `Execute` — the point at which the rule becomes inescapable (FR-002,
//! FR-011, FR-012).
//!
//! The token program calls this instruction inside every `transfer_checked`
//! of a mint with the `TransferHook` extension. It cannot be bypassed from a
//! wallet, through CPI from a foreign program, or with delegated authority:
//! the check lives not in the app but in the token itself.
//!
//! **What the hook does and does not do.** It reads — the status accounts,
//! the counter, the policy — assembles a `TransferContext` and hands the
//! decision to the evaluator (`rules::evaluate`). Not a single rule is
//! written a second time here: there would be nothing to diverge from the TS
//! half. The hook writes exactly one account — the sender's window counter,
//! and only after an allow.
//!
//! **A missing account is a refusal, not a skip** (FR-013). That is why the
//! status accounts are taken untyped: `Account<'info, T>` would yield the
//! Anchor error "account not initialized", while the holder must see
//! `SENDER_STATUS_MISSING` — the name of the reason, not a failure.
use anchor_lang::prelude::*;
use anchor_lang::{AccountDeserialize, AccountSerialize};
use anchor_spl::token_2022::spl_token_2022::extension::transfer_hook::TransferHookAccount;
use anchor_spl::token_2022::spl_token_2022::extension::{BaseStateWithExtensions, StateWithExtensions};
use anchor_spl::token_2022::spl_token_2022::state::Account as SplTokenAccount;
use anchor_spl::token_interface::{Mint, TokenAccount};
use spl_transfer_hook_interface::error::TransferHookError;

use crate::constants::TOKEN_SEED;
use crate::hook::attestation;
use crate::rules::evaluate::{
    evaluate, period_window_seconds, PartyContext, SourceState, StatusRecord, TransferContext,
    VelocityCounterView,
};
use crate::state::{HolderStatus, PolicyConfig, TokenConfig, VelocityCounter};

/// The field order **is the protocol**: it must match the list in
/// `extra_accounts.rs` line for line, because the token program hands the
/// accounts over by exactly that list. A reordering here does not break the
/// build — it makes the hook read someone else's account as its own.
#[derive(Accounts)]
pub struct Execute<'info> {
    #[account(token::mint = mint)]
    pub source_token: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(token::mint = mint)]
    pub destination_token: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: the owner of the transfer source; the token program passes it.
    pub owner: UncheckedAccount<'info>,

    /// CHECK: the extra account list; the token program checks its address.
    pub extra_account_meta_list: UncheckedAccount<'info>,

    #[account(
        seeds = [TOKEN_SEED, mint.key().as_ref()],
        bump = token_config.bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    /// The current policy version. The token program resolves its address
    /// from the `policy_version` field in `TokenConfig`, so slipping in
    /// another version is impossible; the check below remains a second lock,
    /// not the only one.
    pub policy_config: AccountLoader<'info, PolicyConfig>,

    /// CHECK: parsed by hand — a missing account must yield our refusal code,
    /// not an Anchor error.
    pub sender_status: UncheckedAccount<'info>,

    /// CHECK: the same; the only account the hook writes.
    #[account(mut)]
    pub sender_velocity: UncheckedAccount<'info>,

    /// CHECK: the same, for the recipient.
    pub recipient_status: UncheckedAccount<'info>,

    /// CHECK: the SAS program. Needed as an account because the external
    /// attestation PDAs in the list refer to it.
    pub sas_program: UncheckedAccount<'info>,

    /// CHECK: the sender's attestation; parsed by `hook::attestation`.
    pub sender_attestation: UncheckedAccount<'info>,

    /// CHECK: the recipient's attestation.
    pub recipient_attestation: UncheckedAccount<'info>,
}

/// A token account in the transferring state.
///
/// Without this check the hook could be called directly, outside a transfer.
/// Such a call moves no funds by itself, but it moves the **window counter**
/// — i.e. gives outsiders a way to spend someone else's period limit. The
/// flag is set by the token program itself for the duration of the CPI.
fn require_transferring(info: &AccountInfo) -> Result<()> {
    let data = info.try_borrow_data()?;
    let state = StateWithExtensions::<SplTokenAccount>::unpack(&data)
        .map_err(|_| error!(crate::error::ForgeError::HolderAccountMismatch))?;
    let extension = state
        .get_extension::<TransferHookAccount>()
        .map_err(|_| ProgramError::from(TransferHookError::ProgramCalledOutsideOfTransfer))?;
    if !bool::from(extension.transferring) {
        return Err(ProgramError::from(TransferHookError::ProgramCalledOutsideOfTransfer).into());
    }
    Ok(())
}

/// Reads a `HolderStatus` from an untyped account.
///
/// Three states are three different things, and each has its own refusal
/// code on the way out: an empty account means "no record", a foreign owner
/// or an unreadable body means "source unavailable", and a record about
/// another holder is unavailable too, because we do not know what the real
/// one would have said.
fn read_holder(info: &AccountInfo, mint: &Pubkey, wallet: &Pubkey) -> SourceState<StatusRecord> {
    if info.data_is_empty() {
        return SourceState::Absent;
    }
    if info.owner != &crate::ID {
        return SourceState::Unavailable;
    }
    let data = info.data.borrow();
    let mut slice: &[u8] = &data;
    match HolderStatus::try_deserialize(&mut slice) {
        Ok(status) if status.mint == *mint && status.wallet == *wallet => {
            SourceState::Record(status.record())
        }
        _ => SourceState::Unavailable,
    }
}

/// The window counter. `None` — the account does not exist, and that is a
/// refusal if the policy has a period limit (`VELOCITY_COUNTER_MISSING`).
fn read_counter(info: &AccountInfo, mint: &Pubkey, wallet: &Pubkey) -> Option<VelocityCounter> {
    if info.data_is_empty() || info.owner != &crate::ID {
        return None;
    }
    let data = info.data.borrow();
    let mut slice: &[u8] = &data;
    match VelocityCounter::try_deserialize(&mut slice) {
        Ok(counter) if counter.mint == *mint && counter.wallet == *wallet => Some(counter),
        _ => None,
    }
}

fn write_counter(info: &AccountInfo, counter: &VelocityCounter) -> Result<()> {
    let mut data = info.try_borrow_mut_data()?;
    let mut slice: &mut [u8] = &mut data;
    counter.try_serialize(&mut slice)?;
    Ok(())
}

pub(crate) fn handler(ctx: Context<Execute>, amount: u64) -> Result<()> {
    // Both parties must be in the transferring state: otherwise this is not a transfer.
    require_transferring(&ctx.accounts.source_token.to_account_info())?;
    require_transferring(&ctx.accounts.destination_token.to_account_info())?;

    let mint = ctx.accounts.mint.key();
    let sender = ctx.accounts.source_token.owner;
    let recipient = ctx.accounts.destination_token.owner;
    let token_config = &ctx.accounts.token_config;

    let counter = read_counter(
        &ctx.accounts.sender_velocity.to_account_info(),
        &mint,
        &sender,
    );

    let context = TransferContext {
        sender: PartyContext {
            provider: attestation::read(
                &ctx.accounts.sender_attestation.to_account_info(),
                &token_config.attestation_credential,
                &token_config.attestation_schema,
                &sender,
            ),
            register: read_holder(
                &ctx.accounts.sender_status.to_account_info(),
                &mint,
                &sender,
            ),
        },
        recipient: PartyContext {
            provider: attestation::read(
                &ctx.accounts.recipient_attestation.to_account_info(),
                &token_config.attestation_credential,
                &token_config.attestation_schema,
                &recipient,
            ),
            register: read_holder(
                &ctx.accounts.recipient_status.to_account_info(),
                &mint,
                &recipient,
            ),
        },
        amount,
        velocity: counter.as_ref().map(VelocityCounter::view),
        mint_policy_version: token_config.policy_version,
        policy_version: 0,
        now: Clock::get()?.unix_timestamp,
    };

    let policy = ctx.accounts.policy_config.load()?;
    // A policy of another mint with the same version number is the only thing
    // seed resolution does not rule out by itself (the address is derived
    // from the mint, but the account could have come from a client that
    // bypassed the resolution).
    require_keys_eq!(
        policy.mint,
        mint,
        crate::error::ForgeError::PolicyVersionMismatch
    );
    let context = TransferContext {
        policy_version: policy.version,
        ..context
    };

    evaluate(&policy.rules, &context)?;

    // The counter moves **only after an allow**: a refused transfer spends no
    // limit, otherwise a refusal would cost the holder the window.
    if let (Some(mut counter), Some(window)) = (counter, period_window_seconds(&policy.rules)) {
        let closed = context.now >= counter.window_start.saturating_add(i64::from(window));
        if closed {
            counter.window_start = context.now;
            counter.spent_in_window = amount;
        } else {
            counter.spent_in_window = counter.spent_in_window.saturating_add(amount);
        }
        drop(policy);
        write_counter(&ctx.accounts.sender_velocity.to_account_info(), &counter)?;
    }

    Ok(())
}
