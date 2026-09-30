//! Seizure under an order (FR-015), and keeping what was seized apart from
//! free circulation (FR-020).
//!
//! **A burn and a mint, not a transfer, and that is forced.** The token's
//! transfer hook is this very program, and the runtime refuses
//! `issuer_forge → Token-2022 → issuer_forge` as reentrancy — so a
//! `transfer_checked` signed by the permanent delegate cannot run from here
//! at all. Neither `burn` nor `mint_to` calls the hook. The permanent
//! delegate burns `amount` from the holder's account without the holder's
//! signature, and the mint authority mints the same `amount` into the vault;
//! both authorities are the `TokenConfig` PDA. Supply is the same after the
//! instruction as before, which is why the reserve is not checked: nothing
//! came into existence.
//!
//! **The vault is the issuer's account the specification asks for** — the
//! `TokenConfig` PDA's associated account, created here on the first
//! seizure. Its balance **is** the seized amount, exactly, and that is what
//! makes FR-020 readable from the chain: free circulation is supply minus
//! the vault minus the frozen balances. Nothing else ever lands there — its
//! owner has no status in the issuer's register, so the hook refuses every
//! transfer to it, and only this program mints.
//!
//! **The named quorum travels in the instruction (FR-019c).** The approvers
//! follow the accounts in `remaining_accounts`, exactly as the proposal holds
//! them, and the program refuses any other list. The only signer here is the
//! payer, and the proposal account is closed afterwards — without this, the
//! indexer, which reads instructions and not accounts, would have nobody to
//! name as having authorised the seizure, and a journal that names the payer
//! instead would state something false.
//!
//! **A pause does not stop it (FR-016, T028).** Circulation paused is
//! exactly when an order may have to be carried out; the pause is lifted for
//! the burn and the mint and set again before the instruction returns.
//!
//! **Only through a proposal (FR-019), with no second path beside it.**
//! `set_policy` also takes co-signers in `remaining_accounts`; here that path
//! would add nothing, because `propose_action`, `approve_action` and `seize`
//! fit in one transaction signed by both members — the same "at once", with
//! one list of approvers instead of two and the body on chain in the
//! proposal account. The price is the proposal's rent, returned on close.
use anchor_lang::prelude::*;
use anchor_spl::associated_token::{
    self, get_associated_token_address_with_program_id, AssociatedToken,
};
use anchor_spl::token_2022::spl_token_2022::extension::StateWithExtensions;
use anchor_spl::token_2022::spl_token_2022::state::{Account as SplTokenAccount, AccountState};
use anchor_spl::token_interface::{
    burn, freeze_account, mint_to, thaw_account, Burn, FreezeAccount, Mint, MintTo, ThawAccount,
    TokenAccount, TokenInterface,
};

use crate::constants::{ISSUER_SEED, PROPOSAL_SEED, TOKEN_SEED};
use crate::error::ForgeError;
use crate::instructions::pause;
use crate::quorum;
use crate::state::{ActionKind, ActionProposal, ComplianceReason, IssuerConfig, TokenConfig};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SeizeArgs {
    /// Repeated from the proposal on purpose. The program compares the two;
    /// the indexer and the journal verifier then read the whole seizure from
    /// this one instruction instead of joining it with the `propose` days
    /// earlier.
    pub amount: u64,
    pub reason: ComplianceReason,
}

#[derive(Accounts)]
pub struct Seize<'info> {
    #[account(
        seeds = [ISSUER_SEED, issuer_config.issuer_id.as_ref()],
        bump = issuer_config.bump,
    )]
    pub issuer_config: Box<Account<'info, IssuerConfig>>,

    #[account(
        seeds = [TOKEN_SEED, token_config.mint.as_ref()],
        bump = token_config.bump,
        constraint = token_config.issuer == issuer_config.key() @ ForgeError::TokenNotFromThisIssuer,
    )]
    pub token_config: Box<Account<'info, TokenConfig>>,

    /// Writable: the burn lowers its supply and the mint raises it back.
    #[account(
        mut,
        constraint = mint.key() == token_config.mint @ ForgeError::HolderAccountMismatch,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    /// The account the order names, whoever owns it. Which account it is,
    /// is part of what the quorum approved.
    #[account(
        mut,
        constraint = source.mint == token_config.mint @ ForgeError::HolderAccountMismatch,
    )]
    pub source: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: pinned to the `TokenConfig` PDA's associated account; only the
    /// ATA program can create an account at that address, and it creates it
    /// as a token account of this mint owned by that PDA.
    #[account(
        mut,
        address = get_associated_token_address_with_program_id(
            &token_config.key(),
            &token_config.mint,
            &token_program.key(),
        ) @ ForgeError::SeizureVaultMismatch,
    )]
    pub vault: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [PROPOSAL_SEED, proposal.mint.as_ref(), &proposal.nonce.to_le_bytes()],
        bump = proposal.bump,
        constraint = proposal.issuer == issuer_config.key() @ ForgeError::ProposalNotForThisIssuer,
    )]
    pub proposal: Box<Account<'info, ActionProposal>>,

    /// Pays for the vault on the first seizure. Grants nothing — the quorum
    /// is in `proposal`.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    // `remaining_accounts` are the proposal's approvers, in its order —
    // read-only and unsigned: they signed `propose_action` and
    // `approve_action`, and are named here so the journal can say so.
}

fn is_frozen(account: &AccountInfo) -> Result<bool> {
    let data = account.try_borrow_data()?;
    let state = StateWithExtensions::<SplTokenAccount>::unpack(&data)
        .map_err(|_| error!(ForgeError::SeizureVaultMismatch))?;
    Ok(state.base.state == AccountState::Frozen)
}

pub(crate) fn handler(ctx: Context<Seize>, args: SeizeArgs) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let accounts = &ctx.accounts;

    require!(
        accounts.proposal.mint == accounts.token_config.mint,
        ForgeError::ProposalNotForThisToken
    );
    accounts.proposal.live(now)?;
    // The account, the amount and the reason are all compared: the quorum
    // authorised taking this much from this account for this case, and
    // nothing else.
    require!(
        ActionKind::seize(accounts.source.key(), args.amount, args.reason)?
            == accounts.proposal.action,
        ForgeError::ProposalBodyMismatch
    );
    let approvals = accounts.proposal.approvals();
    quorum::check(&accounts.issuer_config, approvals)?;
    quorum::require_listed(ctx.remaining_accounts, approvals)?;

    // Burning from the vault and minting back into it would record a
    // seizure that took nothing from anyone.
    require_keys_neq!(
        accounts.source.key(),
        accounts.vault.key(),
        ForgeError::SeizureFromTheVault
    );

    let token_program = accounts.token_program.to_account_info();
    let mint = accounts.mint.to_account_info();
    let source = accounts.source.to_account_info();
    let vault = accounts.vault.to_account_info();
    let authority = accounts.token_config.to_account_info();
    let mint_key = accounts.token_config.mint;
    let signer: &[&[u8]] = &[TOKEN_SEED, mint_key.as_ref(), &[accounts.token_config.bump]];

    if vault.data_is_empty() {
        associated_token::create(CpiContext::new(
            accounts.associated_token_program.to_account_info(),
            associated_token::Create {
                payer: accounts.payer.to_account_info(),
                associated_token: vault.clone(),
                authority: authority.clone(),
                mint: mint.clone(),
                system_program: accounts.system_program.to_account_info(),
                token_program: token_program.clone(),
            },
        ))?;
    }
    // `DefaultAccountState = Frozen` applies to the vault as to anyone, and
    // the token program refuses to mint onto a frozen account. It stays
    // thawed afterwards: its owner is a PDA only this program signs for.
    if is_frozen(&vault)? {
        thaw_account(CpiContext::new_with_signer(
            token_program.clone(),
            ThawAccount {
                account: vault.clone(),
                mint: mint.clone(),
                authority: authority.clone(),
            },
            &[signer],
        ))?;
    }

    // The token program refuses a burn from a frozen account even to the
    // permanent delegate — and a frozen account is the usual target: the
    // officer freezes first, alone, and the quorum follows. So the account
    // is thawed for the burn and put back as it was, `FreezeRecord` and all.
    let source_was_frozen = accounts.source.state == AccountState::Frozen;
    if source_was_frozen {
        thaw_account(CpiContext::new_with_signer(
            token_program.clone(),
            ThawAccount {
                account: source.clone(),
                mint: mint.clone(),
                authority: authority.clone(),
            },
            &[signer],
        ))?;
    }

    // A pause refuses burn and mint to every authority, the permanent
    // delegate included, and FR-016 exempts exactly this: the issuer's own
    // action under an order. Lifted here and set again below, inside one
    // instruction, so no transfer of anyone else's can see it lifted.
    let mint_was_paused = pause::is_paused(&mint)?;
    if mint_was_paused {
        pause::resume_for(&token_program, &mint, &accounts.token_config)?;
    }

    // Burn first: supply never rises above what it was, not even between
    // two CPIs, so the reserve invariant holds at every step and not only
    // at the end.
    burn(
        CpiContext::new_with_signer(
            token_program.clone(),
            Burn {
                mint: mint.clone(),
                from: source.clone(),
                authority: authority.clone(),
            },
            &[signer],
        ),
        args.amount,
    )?;

    if source_was_frozen {
        freeze_account(CpiContext::new_with_signer(
            token_program.clone(),
            FreezeAccount {
                account: source,
                mint: mint.clone(),
                authority: authority.clone(),
            },
            &[signer],
        ))?;
    }

    mint_to(
        CpiContext::new_with_signer(
            token_program.clone(),
            MintTo {
                mint: mint.clone(),
                to: vault,
                authority,
            },
            &[signer],
        ),
        args.amount,
    )?;

    if mint_was_paused {
        pause::pause_for(&token_program, &mint, &accounts.token_config)?;
    }

    // The last action, as in `set_policy`: a refusal anywhere above leaves
    // the proposal unexecuted.
    ctx.accounts.proposal.executed_at = now;
    Ok(())
}
