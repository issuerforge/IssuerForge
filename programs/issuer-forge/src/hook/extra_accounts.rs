//! `ExtraAccountMetaList` — the list of accounts the token program must hand
//! to the hook on every transfer.
//!
//! This is what makes FR-012 possible: the list lives on chain, and the
//! token program resolves it **itself**, whoever initiated the transfer — a
//! wallet, a foreign program through CPI or a delegate. The client "adds"
//! nothing: it can only fail to add, and then the transfer does not happen.
//!
//! **The seed layout is the result of spike T057**, and every line of it is
//! a constraint, not a choice:
//! - `credential` and `schema` are taken as **slices of `TokenConfig`
//!   data**: two 32-byte literals make 68 bytes and never fit into a 32-byte
//!   `address_config`;
//! - the policy version is also taken as a data slice, not as a number from
//!   the client — otherwise a transfer could be run against an old version;
//! - a party's wallet is taken as a slice of the `owner` field of its token
//!   account;
//! - the SAS program is a separate account, because an external PDA is
//!   specified by the discriminator "128 + the program account's index".
use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, CreateAccount};
use anchor_spl::token_interface::Mint;
use spl_tlv_account_resolution::account::ExtraAccountMeta;
use spl_tlv_account_resolution::seeds::Seed;
use spl_tlv_account_resolution::state::ExtraAccountMetaList;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

use crate::constants::{HOLDER_SEED, POLICY_SEED, TOKEN_SEED, VELOCITY_SEED};
use crate::hook::attestation::SAS_PROGRAM_ID;
use crate::state::{
    TokenConfig, TOKEN_CONFIG_CREDENTIAL_OFFSET, TOKEN_CONFIG_POLICY_VERSION_OFFSET,
    TOKEN_CONFIG_SCHEMA_OFFSET,
};

/// The indices of the accounts the token program always passes to the hook.
///
/// The order is set by the `spl-transfer-hook-interface`, not by us; the
/// numbers are named here because they are also the `account_index` in every
/// seed below, and an unnamed two among them would read as anything.
const SOURCE_TOKEN: u8 = 0;
const MINT: u8 = 1;
const DESTINATION_TOKEN: u8 = 2;

/// The indices of our accounts in the same list. The order must match the
/// `Execute` fields — otherwise the hook reads something other than what the
/// token program resolved.
const TOKEN_CONFIG: u8 = 5;
const SAS_PROGRAM: u8 = 10;

/// The offset of the `owner` field in an SPL token account: `mint` takes the first 32 bytes.
const TOKEN_ACCOUNT_OWNER_OFFSET: u8 = 32;

/// How many accounts we add beyond those the token program passes.
pub const EXTRA_ACCOUNT_COUNT: usize = 8;

fn wallet_seed(token_account_index: u8) -> Seed {
    Seed::AccountData {
        account_index: token_account_index,
        data_index: TOKEN_ACCOUNT_OWNER_OFFSET,
        length: 32,
    }
}

fn token_config_slice(offset: u8, length: u8) -> Seed {
    Seed::AccountData {
        account_index: TOKEN_CONFIG,
        data_index: offset,
        length,
    }
}

fn holder_meta(token_account_index: u8, seed: &[u8], writable: bool) -> Result<ExtraAccountMeta> {
    Ok(ExtraAccountMeta::new_with_seeds(
        &[
            Seed::Literal { bytes: seed.to_vec() },
            Seed::AccountKey { index: MINT },
            wallet_seed(token_account_index),
        ],
        false,
        writable,
    )?)
}

/// The list in the same order `Execute` reads it in.
pub fn extra_account_metas() -> Result<Vec<ExtraAccountMeta>> {
    Ok(vec![
        // 5: TokenConfig — the credential, the schema and the policy version are taken from it.
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: TOKEN_SEED.to_vec(),
                },
                Seed::AccountKey { index: MINT },
            ],
            false,
            false,
        )?,
        // 6: the current policy version. The number is taken from TokenConfig
        // data, so slipping in an old version is impossible — its address
        // simply will not match.
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: POLICY_SEED.to_vec(),
                },
                Seed::AccountKey { index: MINT },
                token_config_slice(TOKEN_CONFIG_POLICY_VERSION_OFFSET, 4),
            ],
            false,
            false,
        )?,
        // 7, 8: the sender's status and their window counter. The counter is
        // the only account the hook writes.
        holder_meta(SOURCE_TOKEN, HOLDER_SEED, false)?,
        holder_meta(SOURCE_TOKEN, VELOCITY_SEED, true)?,
        // 9: the recipient's status. The recipient's counter is not needed:
        // the period limit restricts whoever sends.
        holder_meta(DESTINATION_TOKEN, HOLDER_SEED, false)?,
        // 10: the SAS program itself — it must be an account in the list so
        // the external PDAs below can refer to it.
        ExtraAccountMeta::new_with_pubkey(&SAS_PROGRAM_ID, false, false)?,
        // 11, 12: the parties' attestations. Both are present **always**,
        // regardless of whether the policy accepts the `provider` source: a
        // denial applies from any source (FR-008a1), so not looking into it
        // is not an option.
        ExtraAccountMeta::new_external_pda_with_seeds(
            SAS_PROGRAM,
            &attestation_seeds(SOURCE_TOKEN),
            false,
            false,
        )?,
        ExtraAccountMeta::new_external_pda_with_seeds(
            SAS_PROGRAM,
            &attestation_seeds(DESTINATION_TOKEN),
            false,
            false,
        )?,
    ])
}

fn attestation_seeds(token_account_index: u8) -> [Seed; 4] {
    [
        Seed::Literal {
            bytes: b"attestation".to_vec(),
        },
        token_config_slice(TOKEN_CONFIG_CREDENTIAL_OFFSET, 32),
        token_config_slice(TOKEN_CONFIG_SCHEMA_OFFSET, 32),
        wallet_seed(token_account_index),
    ]
}

/// Creating the list for a freshly issued token.
///
/// A separate instruction rather than inside `create_token`: the list
/// belongs to the **hook interface**, not to the issuance, and it will have
/// to be updated independently of the mint (for instance when a new kind of
/// status source appears). The client puts both instructions into one
/// transaction (T020).
#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: the seeds set the address, this instruction writes the content.
    /// There is nothing to type it with — it is a `spl-tlv-account-resolution`
    /// TLV buffer, not an Anchor account.
    #[account(
        mut,
        seeds = [b"extra-account-metas", token_config.mint.as_ref()],
        bump,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    #[account(
        seeds = [TOKEN_SEED, token_config.mint.as_ref()],
        bump = token_config.bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    #[account(constraint = mint.key() == token_config.mint)]
    pub mint: InterfaceAccount<'info, Mint>,

    pub system_program: Program<'info, System>,
}

pub(crate) fn handler(ctx: Context<InitializeExtraAccountMetaList>) -> Result<()> {
    let metas = extra_account_metas()?;
    let size = ExtraAccountMetaList::size_of(metas.len())?;
    let lamports = Rent::get()?.minimum_balance(size);

    let mint = ctx.accounts.token_config.mint;
    let bump = ctx.bumps.extra_account_meta_list;
    let signer: &[&[u8]] = &[b"extra-account-metas", mint.as_ref(), &[bump]];

    system_program::create_account(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            CreateAccount {
                from: ctx.accounts.payer.to_account_info(),
                to: ctx.accounts.extra_account_meta_list.to_account_info(),
            },
            &[signer],
        ),
        lamports,
        size as u64,
        &crate::ID,
    )?;

    let mut data = ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?;
    ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &metas)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every `address_config` is exactly 32 bytes, and no configuration
    /// "almost" fits in them: one that did not fit is not created at all.
    #[test]
    fn every_configuration_fits_the_address_config() {
        let metas = extra_account_metas().expect("builds");
        assert_eq!(metas.len(), EXTRA_ACCOUNT_COUNT);
    }

    /// The attestation is the tightest configuration: 13 + 4 + 4 + 4 = 25 of
    /// 32 (T057). The naive variant with two literals gives 68 and never
    /// fits.
    #[test]
    fn the_attestation_seeds_stay_inside_the_budget() {
        let seeds = attestation_seeds(SOURCE_TOKEN);
        let packed: usize = seeds.iter().map(|seed| usize::from(seed.tlv_size())).sum();
        assert_eq!(packed, 25);
        assert!(packed <= 32);
    }

    /// The sender's counter is the only account the hook writes. A stray
    /// writable in the list would mean the transfer locks an account it does
    /// not change.
    #[test]
    fn only_the_senders_counter_is_writable() {
        let metas = extra_account_metas().expect("builds");
        let writable: Vec<usize> = metas
            .iter()
            .enumerate()
            .filter(|(_, meta)| bool::from(meta.is_writable))
            .map(|(index, _)| index)
            .collect();
        assert_eq!(writable, vec![3]);
    }

    #[test]
    fn nothing_in_the_list_signs() {
        let metas = extra_account_metas().expect("builds");
        assert!(metas.iter().all(|meta| !bool::from(meta.is_signer)));
    }
}
