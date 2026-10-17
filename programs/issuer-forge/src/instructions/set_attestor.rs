//! Changing the terms a token's reserve is attested under: who attests, and
//! how long an attestation stays current (FR-023b, FR-024a).
//!
//! **The quorum of a policy change, on both of its paths** (FR-023b). The
//! immediate one takes the signatures in `remaining_accounts`; the deferred
//! one takes a matured proposal raised under the token and, after the
//! accounts, its approvers unsigned and in its order (FR-019c).
//!
//! **History is not touched.** Every `ReserveAttestation` keeps the attestor
//! that signed it, and none of them is opened for writing here: what changes
//! is who may sign the **next** one. The latest attestation stays the one the
//! reserve check reads, now held to the new terms: a shorter period can
//! expire it on the spot, which is the point of shortening it, and a new
//! attestor stops it counting at once (`require_latest`).
//!
//! **The deferred path executes a transition** (`ActionKind::SetAttestor`),
//! for the reason `set_delegation` gives: a proposal raised before another
//! change of the terms refuses after it.
use anchor_lang::prelude::*;

use crate::constants::{ISSUER_SEED, TOKEN_SEED};
use crate::error::ForgeError;
use crate::quorum;
use crate::state::{ActionKind, ActionProposal, ComplianceReason, IssuerConfig, TokenConfig};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SetAttestorArgs {
    /// The attestor from now on. The current one when only the period
    /// changes.
    pub attestor: Pubkey,
    /// The validity period from now on, seconds. The current one when only
    /// the attestor changes.
    pub attestation_max_age: i64,
    /// Why (FR-017). On the deferred path it must be the reason the proposal
    /// holds — it is part of what the approvers signed.
    pub reason: ComplianceReason,
}

#[derive(Accounts)]
pub struct SetAttestor<'info> {
    #[account(
        seeds = [ISSUER_SEED, issuer_config.issuer_id.as_ref()],
        bump = issuer_config.bump,
    )]
    pub issuer_config: Account<'info, IssuerConfig>,

    #[account(
        mut,
        seeds = [TOKEN_SEED, token_config.mint.as_ref()],
        bump = token_config.bump,
        constraint = token_config.issuer == issuer_config.key() @ ForgeError::TokenNotFromThisIssuer,
    )]
    pub token_config: Account<'info, TokenConfig>,

    /// A matured proposal, on the deferred path. No `seeds`, for the reason
    /// `set_policy` gives; the handler checks it is this issuer's and this
    /// token's.
    #[account(mut)]
    pub proposal: Option<Box<Account<'info, ActionProposal>>>,
    // `remaining_accounts`: on the immediate path the signing members, on the
    // deferred path the proposal's approvers. There is no signer of our own —
    // whoever pays the fee is granted nothing by it.
}

pub(crate) fn handler(ctx: Context<SetAttestor>, args: SetAttestorArgs) -> Result<()> {
    let issuer = &ctx.accounts.issuer_config;
    let token = &ctx.accounts.token_config;

    // Built as the stored form, against the membership and the terms as they
    // are now, so the deferred path can compare it whole.
    let target = ActionKind::set_attestor(
        issuer,
        token,
        args.attestor,
        args.attestation_max_age,
        args.reason,
    )?;
    let now = Clock::get()?.unix_timestamp;

    let approvals = match &ctx.accounts.proposal {
        Some(proposal) => {
            require_keys_eq!(
                proposal.issuer,
                issuer.key(),
                ForgeError::ProposalNotForThisIssuer
            );
            require_keys_eq!(
                proposal.scope,
                token.mint,
                ForgeError::ProposalNotForThisToken
            );
            proposal.live(now)?;
            if target != proposal.action {
                // Two refusals for two different requests, as in
                // `set_delegation`: a body nobody approved is a client error,
                // terms that moved underneath are a reason to propose again.
                let same_destination = matches!(
                    proposal.action,
                    ActionKind::SetAttestor { attestor, max_age, reason, .. }
                        if attestor == args.attestor
                            && max_age == args.attestation_max_age
                            && reason == args.reason
                );
                return if same_destination {
                    err!(ForgeError::AttestationTermsChangedSinceProposal)
                } else {
                    err!(ForgeError::ProposalBodyMismatch)
                };
            }
            quorum::require_listed(ctx.remaining_accounts, proposal.approvals())?;
            proposal.approvals().to_vec()
        }
        None => quorum::approvals_from(ctx.remaining_accounts)?,
    };
    quorum::check(issuer, &approvals)?;

    let token = &mut ctx.accounts.token_config;
    token.attestor = args.attestor;
    token.attestation_max_age = args.attestation_max_age;
    // The last action, as in `set_policy`.
    if let Some(proposal) = ctx.accounts.proposal.as_mut() {
        proposal.executed_at = now;
    }
    Ok(())
}
