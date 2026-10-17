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
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{mint_to, Mint, MintTo, TokenAccount, TokenInterface};

use crate::constants::{ISSUER_SEED, PROPOSAL_SEED, TOKEN_SEED};
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

    #[account(
        mut,
        seeds = [PROPOSAL_SEED, proposal.scope.as_ref(), &proposal.nonce.to_le_bytes()],
        bump = proposal.bump,
        constraint = proposal.issuer == issuer_config.key() @ ForgeError::ProposalNotForThisIssuer,
    )]
    pub proposal: Box<Account<'info, ActionProposal>>,

    pub token_program: Interface<'info, TokenInterface>,
    // `remaining_accounts` are the proposal's approvers, in its order —
    // read-only and unsigned, as in `seize`. There is no signer of our own:
    // executing a matured proposal grants nothing, whoever pays the fee.
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

    let mint_key = accounts.token_config.mint;
    let signer: &[&[u8]] = &[TOKEN_SEED, mint_key.as_ref(), &[accounts.token_config.bump]];
    mint_to(
        CpiContext::new_with_signer(
            accounts.token_program.to_account_info(),
            MintTo {
                mint: accounts.mint.to_account_info(),
                to: accounts.destination.to_account_info(),
                authority: accounts.token_config.to_account_info(),
            },
            &[signer],
        ),
        args.amount,
    )?;

    // The last action, as in `seize`.
    ctx.accounts.proposal.executed_at = now;
    Ok(())
}
