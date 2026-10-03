//! Changing what the platform's operational key may do, or which key it is
//! (FR-035, FR-035b).
//!
//! **Narrowing takes one admin, everything else the quorum**
//! (`delegation::require_change_authorised`). Revocation is the action of the
//! hour a key leaks, and it grants nobody anything; a grant or a rotation
//! hands the platform a power over the issuer's holders.
//!
//! **Two paths, as in `set_policy`.** The immediate one takes its signatures
//! in `remaining_accounts`; the deferred one takes a matured proposal raised
//! under the issuer's own scope and, after the accounts, its approvers
//! unsigned and in its order (FR-019c). A proposal always takes the quorum,
//! even for a narrowing — it was raised to be authorised by one.
//!
//! **The deferred path executes a transition, not a destination**
//! (`ActionKind::SetDelegation`). A proposal raised before a revocation
//! refuses after it, so an emergency revocation cannot be undone by a grant
//! that was already circulating.
use anchor_lang::prelude::*;

use crate::constants::ISSUER_SEED;
use crate::error::ForgeError;
use crate::quorum;
use crate::state::{delegation, ActionKind, ActionProposal, IssuerConfig};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SetDelegationArgs {
    /// The key that will hold the delegation. The current one for a change of
    /// powers, another one for a rotation.
    pub operational_key: Pubkey,
    /// The powers it will hold, a mask over `state::delegation`. Zero is a
    /// full revocation.
    pub mask: u8,
}

#[derive(Accounts)]
pub struct SetDelegation<'info> {
    #[account(
        mut,
        seeds = [ISSUER_SEED, issuer_config.issuer_id.as_ref()],
        bump = issuer_config.bump,
    )]
    pub issuer_config: Account<'info, IssuerConfig>,

    /// A matured proposal, on the deferred path. No `seeds`, for the reason
    /// `set_policy` gives; the handler checks it is this issuer's and raised
    /// under the issuer's scope.
    #[account(mut)]
    pub proposal: Option<Box<Account<'info, ActionProposal>>>,
    // `remaining_accounts`: on the immediate path the signing members, on the
    // deferred path the proposal's approvers. There is no signer of our own —
    // whoever pays the fee is granted nothing by it.
}

pub(crate) fn handler(ctx: Context<SetDelegation>, args: SetDelegationArgs) -> Result<()> {
    let issuer_key = ctx.accounts.issuer_config.key();
    let issuer = &ctx.accounts.issuer_config;

    // The target is valid against the membership as it is now, and it
    // changes something. Built as the stored form so the deferred path can
    // compare it whole.
    let target = ActionKind::set_delegation(issuer, args.operational_key, args.mask)?;
    let now = Clock::get()?.unix_timestamp;

    match &ctx.accounts.proposal {
        Some(proposal) => {
            require_keys_eq!(
                proposal.issuer,
                issuer_key,
                ForgeError::ProposalNotForThisIssuer
            );
            require_keys_eq!(
                proposal.scope,
                issuer_key,
                ForgeError::ProposalScopeMismatch
            );
            proposal.live(now)?;
            if target != proposal.action {
                // Two refusals, because they ask for two different things: a
                // body that was never approved is a client error, a delegation
                // that moved underneath is a reason to propose again.
                let same_destination = matches!(
                    proposal.action,
                    ActionKind::SetDelegation { operational_key, mask, .. }
                        if operational_key == args.operational_key && mask == args.mask
                );
                return if same_destination {
                    err!(ForgeError::DelegationChangedSinceProposal)
                } else {
                    err!(ForgeError::ProposalBodyMismatch)
                };
            }
            let approvals = proposal.approvals();
            quorum::check(issuer, approvals)?;
            quorum::require_listed(ctx.remaining_accounts, approvals)?;
        }
        None => {
            let approvals = quorum::approvals_from(ctx.remaining_accounts)?;
            let narrowing = delegation::is_narrowing(issuer, &args.operational_key, args.mask);
            delegation::require_change_authorised(issuer, &approvals, narrowing)?;
        }
    }

    let issuer = &mut ctx.accounts.issuer_config;
    issuer.operational_key = args.operational_key;
    issuer.delegation_mask = args.mask;
    // The last action, as in `set_policy`.
    if let Some(proposal) = ctx.accounts.proposal.as_mut() {
        proposal.executed_at = now;
    }
    Ok(())
}
