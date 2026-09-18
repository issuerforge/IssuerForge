//! A foreign program that transfers our token via CPI.
//!
//! **This is not an integration example but a measurement tool.** The
//! project's main promise reads: the token itself enforces the rule, not the
//! app (`docs/SPEC.md`, FR-002). There is only one way to prove it — transfer
//! past our app and get refused. Three vectors of four (a third-party client,
//! a delegate, splitting) do that from the client side; the fourth requires
//! **another program on chain**, because a relay program is exactly what
//! checks living in an app are bypassed with.
//!
//! The program has no state, no authority and no checks of its own: it makes
//! exactly one CPI and nothing more. Everything that happens next is the
//! decision of the token program and our hook, and that is what is measured
//! (SC-002).
//!
//! **Deployed together with the demo and nowhere else.** It is not in the
//! product: `docs/PLAN.md` does not list it, and `tools/demo` is the only
//! thing that calls it.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

declare_id!("9ZCmUGqkrtBrm83uiiMwBgRrV2cBPE9HGMgA25iRJGkQ");

/// `TokenInstruction::TransferChecked` — index 12 in the token program.
///
/// The instruction is assembled by hand rather than through
/// `anchor_spl::token_interface::transfer_checked`: that one builds a
/// **fixed** account list and passes no `remaining_accounts` into the CPI.
/// Without them the token program has nothing to hand to the hook, and the
/// refusal comes as "missing account" — i.e. the SC-002 measurement would
/// prove broken wiring, not the rule at work. The first demo run found this
/// (T024).
const TRANSFER_CHECKED: u8 = 12;

#[program]
pub mod attacker {
    use super::*;

    /// A transfer through a relay: the owner signs, this program calls.
    ///
    /// The hook's extra accounts arrive in `remaining_accounts` and go into
    /// the CPI unchanged — both in the metadata list and in the
    /// `AccountInfo` list.
    pub fn relay_transfer<'info>(
        ctx: Context<'_, '_, '_, 'info, RelayTransfer<'info>>,
        amount: u64,
        decimals: u8,
    ) -> Result<()> {
        let mut data = Vec::with_capacity(10);
        data.push(TRANSFER_CHECKED);
        data.extend_from_slice(&amount.to_le_bytes());
        data.push(decimals);

        let mut metas = vec![
            AccountMeta::new(ctx.accounts.source.key(), false),
            AccountMeta::new_readonly(ctx.accounts.mint.key(), false),
            AccountMeta::new(ctx.accounts.destination.key(), false),
            AccountMeta::new_readonly(ctx.accounts.authority.key(), true),
        ];
        let mut infos = vec![
            ctx.accounts.source.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.destination.to_account_info(),
            ctx.accounts.authority.to_account_info(),
        ];

        for account in ctx.remaining_accounts {
            metas.push(AccountMeta {
                pubkey: *account.key,
                is_signer: account.is_signer,
                is_writable: account.is_writable,
            });
            infos.push(account.clone());
        }

        invoke(
            &Instruction {
                program_id: ctx.accounts.token_program.key(),
                accounts: metas,
                data,
            },
            &infos,
        )?;

        Ok(())
    }
}

/// There is deliberately no constraint on the accounts here.
///
/// This program is not meant to protect anything: its job is to be the most
/// convenient bypass possible. The checks it is tempting to add here exist
/// in the token program and in the hook, and those are the ones that must
/// fire.
#[derive(Accounts)]
pub struct RelayTransfer<'info> {
    #[account(mut)]
    pub source: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    pub authority: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}
