//! The platform's fee on issuance (FR-038), paid one way on both paths
//! tokens come into existence: the initial issuance in `create_token` and
//! further issuance in `mint`.
//!
//! **One function, for the same reason the reserve gate is one.** Two copies
//! of "create the treasury's account, thaw it, mint the fee" would one day
//! disagree about the officer's freeze, and the fee would quietly behave
//! differently depending on whether the issuance was the first.
//!
//! The fee is cut from the approved amount, not added on top: whoever calls
//! this mints `amount − fee` to the recipient, and the gate has already seen
//! the whole `amount` (FR-038b).
use anchor_lang::prelude::*;
use anchor_spl::associated_token;
use anchor_spl::token_2022::spl_token_2022::extension::StateWithExtensions;
use anchor_spl::token_2022::spl_token_2022::state::{Account as SplTokenAccount, AccountState};
use anchor_spl::token_interface::{mint_to, thaw_account, MintTo, ThawAccount};

use crate::error::ForgeError;

/// Everything the fee needs on its way into the treasury's associated
/// account.
pub(crate) struct Treasury<'a, 'info> {
    /// The wallet `TokenConfig.treasury` declares.
    pub wallet: &'a AccountInfo<'info>,
    /// Its associated account of this mint; the caller pins the address.
    pub account: &'a AccountInfo<'info>,
    /// The officer's `FreezeRecord` of `account`. `None` only where one
    /// cannot exist — in `create_token`, whose mint did not exist before the
    /// instruction, so no officer could have frozen anything of it.
    pub freeze: Option<&'a AccountInfo<'info>>,
    pub mint: &'a AccountInfo<'info>,
    /// The `TokenConfig` PDA: the mint and freeze authority.
    pub authority: &'a AccountInfo<'info>,
    /// Pays the rent of the treasury's account on the first fee.
    pub payer: &'a AccountInfo<'info>,
    pub token_program: &'a AccountInfo<'info>,
    pub associated_token_program: &'a AccountInfo<'info>,
    pub system_program: &'a AccountInfo<'info>,
}

impl Treasury<'_, '_> {
    /// Mints `fee` to the treasury's account, creating and thawing it on the
    /// way. A zero fee touches nothing, so a token without a fee never gets
    /// a treasury account.
    ///
    /// The account is created on the first fee and thawed —
    /// `DefaultAccountState = Frozen` applies to it as to anyone, and anyone
    /// may create it first — but not over an officer's `FreezeRecord`, which
    /// `thaw_holder` respects too.
    pub fn credit(&self, fee: u64, signer: &[&[u8]]) -> Result<()> {
        if fee == 0 {
            return Ok(());
        }
        if self.account.data_is_empty() {
            associated_token::create(CpiContext::new(
                self.associated_token_program.clone(),
                associated_token::Create {
                    payer: self.payer.clone(),
                    associated_token: self.account.clone(),
                    authority: self.wallet.clone(),
                    mint: self.mint.clone(),
                    system_program: self.system_program.clone(),
                    token_program: self.token_program.clone(),
                },
            ))?;
        }
        if is_frozen(self.account)? {
            if let Some(freeze) = self.freeze {
                require!(freeze.data_is_empty(), ForgeError::TreasuryFrozenByOfficer);
            }
            thaw_account(CpiContext::new_with_signer(
                self.token_program.clone(),
                ThawAccount {
                    account: self.account.clone(),
                    mint: self.mint.clone(),
                    authority: self.authority.clone(),
                },
                &[signer],
            ))?;
        }
        mint_to(
            CpiContext::new_with_signer(
                self.token_program.clone(),
                MintTo {
                    mint: self.mint.clone(),
                    to: self.account.clone(),
                    authority: self.authority.clone(),
                },
                &[signer],
            ),
            fee,
        )
    }
}

fn is_frozen(account: &AccountInfo) -> Result<bool> {
    let data = account.try_borrow_data()?;
    let state = StateWithExtensions::<SplTokenAccount>::unpack(&data)
        .map_err(|_| error!(ForgeError::TreasuryAccountMismatch))?;
    Ok(state.base.state == AccountState::Frozen)
}
