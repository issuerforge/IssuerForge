//! Further issuance (FR-022, FR-035): the reserve gate of `create_token`,
//! behind the issuer's quorum.
//!
//! **The same gate as the initial issuance, not a second one.** The latest
//! attestation, signed by the current attestor, still current, and covering
//! `supply + amount` — `require_latest` and `ReserveCheck`, exactly as
//! `create_token` calls them. Supply is read from the mint here, so two
//! issuances each of which fits on its own do not both pass (SC-005).
//!
//! **Only through a proposal (FR-019), as a seizure.** Issuance is an action
//! with funds; `propose_action`, `approve_action` and this instruction fit in
//! one transaction when both members are at hand, and the approvers follow
//! the accounts (FR-019c) for the reason `seize.rs` gives.
//!
//! **Only into a member's own account.** `mint_to` does not call the hook, so
//! tokens minted onto a holder's account would arrive there without any rule
//! having been checked. They land with someone who may authorise actions —
//! as the initial issuance lands with the founder — and reach holders by a
//! transfer the hook checks. The owner is checked against the membership as
//! it is at execution, so a member removed since the proposal receives
//! nothing.
//!
//! **A pause stops it**, at the token program: issuance is not among the
//! issuer's actions FR-016 exempts.
//!
//! **The platform's fee is cut from the approved amount (FR-038)**, at the
//! rate `TokenConfig` declares: the treasury's associated account receives
//! `fee_on(amount)`, the approved account the rest. The gate sees the whole
//! `amount`, so a fee the reserve does not cover is never issued (FR-038b).
//! The rate is read at execution and never written back, so whatever becomes
//! of it later changes nothing already issued (FR-038c). The treasury's
//! account is created on the first fee and thawed — `DefaultAccountState =
//! Frozen` applies to it as to anyone, and anyone may create it first — but
//! not over an officer's `FreezeRecord`, which `thaw_holder` respects too.
use anchor_lang::prelude::*;
use anchor_spl::associated_token::{
    self, get_associated_token_address_with_program_id, AssociatedToken,
};
use anchor_spl::token_2022::spl_token_2022::extension::StateWithExtensions;
use anchor_spl::token_2022::spl_token_2022::state::{Account as SplTokenAccount, AccountState};
use anchor_spl::token_interface::{
    mint_to, thaw_account, Mint, MintTo, ThawAccount, TokenAccount, TokenInterface,
};

use crate::constants::{FREEZE_SEED, ISSUER_SEED, PROPOSAL_SEED, TOKEN_SEED};
use crate::error::ForgeError;
use crate::quorum;
use crate::reserve::{require_latest, ReserveCheck};
use crate::state::{
    role, ActionKind, ActionProposal, IssuerConfig, ReserveAttestation, TokenConfig,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MintArgs {
    /// Repeated from the proposal, as in `seize`: the program compares the
    /// two, and the indexer reads the issuance from this one instruction.
    pub amount: u64,
}

#[derive(Accounts)]
pub struct MintTokens<'info> {
    #[account(
        seeds = [ISSUER_SEED, issuer_config.issuer_id.as_ref()],
        bump = issuer_config.bump,
    )]
    pub issuer_config: Box<Account<'info, IssuerConfig>>,

    /// The mint authority the program signs as.
    #[account(
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

    /// The latest attestation of this token. No `seeds`: every attestation
    /// is created by `init` at its PDA, and which one it is — this mint's,
    /// the latest — is what `require_latest` checks.
    pub attestation: Box<Account<'info, ReserveAttestation>>,

    /// The account the quorum approved. Which account it is, is part of the
    /// proposal; whose it is, the handler checks.
    #[account(
        mut,
        constraint = destination.mint == token_config.mint @ ForgeError::HolderAccountMismatch,
    )]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: the wallet `TokenConfig` declares; the ATA program needs it to
    /// create its account, nothing is read from it.
    #[account(address = token_config.treasury @ ForgeError::TreasuryAccountMismatch)]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: pinned to the treasury's associated account; only the ATA
    /// program can create an account at that address, and it creates it as a
    /// token account of this mint owned by the treasury.
    #[account(
        mut,
        address = get_associated_token_address_with_program_id(
            &token_config.treasury,
            &token_config.mint,
            &token_program.key(),
        ) @ ForgeError::TreasuryAccountMismatch,
    )]
    pub treasury_account: UncheckedAccount<'info>,

    /// CHECK: only whether it exists is read — an officer's freeze of the
    /// treasury's account, which issuance must not thaw.
    #[account(seeds = [FREEZE_SEED, treasury_account.key().as_ref()], bump)]
    pub treasury_freeze: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [PROPOSAL_SEED, proposal.scope.as_ref(), &proposal.nonce.to_le_bytes()],
        bump = proposal.bump,
        constraint = proposal.issuer == issuer_config.key() @ ForgeError::ProposalNotForThisIssuer,
    )]
    pub proposal: Box<Account<'info, ActionProposal>>,

    /// Pays for the treasury's account on the first fee. Grants nothing —
    /// the quorum is in `proposal`.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    // `remaining_accounts` are the proposal's approvers, in its order —
    // read-only and unsigned, as in `seize`.
}

fn is_frozen(account: &AccountInfo) -> Result<bool> {
    let data = account.try_borrow_data()?;
    let state = StateWithExtensions::<SplTokenAccount>::unpack(&data)
        .map_err(|_| error!(ForgeError::TreasuryAccountMismatch))?;
    Ok(state.base.state == AccountState::Frozen)
}

pub(crate) fn handler(ctx: Context<MintTokens>, args: MintArgs) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let accounts = &ctx.accounts;

    require!(
        accounts.proposal.scope == accounts.token_config.mint,
        ForgeError::ProposalNotForThisToken
    );
    accounts.proposal.live(now)?;
    require!(
        ActionKind::mint(accounts.destination.key(), args.amount)? == accounts.proposal.action,
        ForgeError::ProposalBodyMismatch
    );
    let approvals = accounts.proposal.approvals();
    quorum::check(&accounts.issuer_config, approvals)?;
    quorum::require_listed(ctx.remaining_accounts, approvals)?;

    require!(
        accounts
            .issuer_config
            .member_has(&accounts.destination.owner, role::AUTHORISING),
        ForgeError::IssuanceToANonMember
    );

    require_latest(&accounts.token_config, &accounts.attestation)?;
    ReserveCheck {
        attested: accounts.attestation.amount,
        attested_at: accounts.attestation.attested_at,
        max_age: accounts.token_config.attestation_max_age,
        supply: accounts.mint.supply,
        minting: args.amount,
        now,
    }
    .require_within_reserve()?;

    let token_program = accounts.token_program.to_account_info();
    let mint = accounts.mint.to_account_info();
    let authority = accounts.token_config.to_account_info();
    let mint_key = accounts.token_config.mint;
    let signer: &[&[u8]] = &[TOKEN_SEED, mint_key.as_ref(), &[accounts.token_config.bump]];

    let fee = accounts.token_config.fee_on(args.amount);
    if fee > 0 {
        let treasury = accounts.treasury_account.to_account_info();
        if treasury.data_is_empty() {
            associated_token::create(CpiContext::new(
                accounts.associated_token_program.to_account_info(),
                associated_token::Create {
                    payer: accounts.payer.to_account_info(),
                    associated_token: treasury.clone(),
                    authority: accounts.treasury.to_account_info(),
                    mint: mint.clone(),
                    system_program: accounts.system_program.to_account_info(),
                    token_program: token_program.clone(),
                },
            ))?;
        }
        if is_frozen(&treasury)? {
            require!(
                accounts.treasury_freeze.data_is_empty(),
                ForgeError::TreasuryFrozenByOfficer
            );
            thaw_account(CpiContext::new_with_signer(
                token_program.clone(),
                ThawAccount {
                    account: treasury.clone(),
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
                    to: treasury,
                    authority: authority.clone(),
                },
                &[signer],
            ),
            fee,
        )?;
    }

    mint_to(
        CpiContext::new_with_signer(
            token_program,
            MintTo {
                mint,
                to: accounts.destination.to_account_info(),
                authority,
            },
            &[signer],
        ),
        args.amount - fee,
    )?;

    // The last action, as in `seize`.
    ctx.accounts.proposal.executed_at = now;
    Ok(())
}
