use anchor_lang::prelude::*;

use crate::constants::{FIRST_POLICY_VERSION, ISSUER_SEED, POLICY_SEED, TOKEN_SEED};
use crate::error::ForgeError;
use crate::quorum;
use crate::rules::layout::RULES_BYTES;
use crate::state::{
    ActionKind, ActionProposal, IssuerConfig, PolicyConfig, TokenConfig, POLICY_CONFIG_LEN,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SetPolicyArgs {
    /// The new version number. Must be exactly the next after the current
    /// one: a skip would make "the previous version" underivable from the
    /// number, and the history a list with gaps that nothing can verify.
    pub version: u32,
    /// The rules in the canonical layout, exactly `RULES_BYTES` bytes.
    ///
    /// A `Vec<u8>`, not an array: Borsh describes it as `bytes`, and the IDL
    /// stays readable for the client. The program checks the length.
    pub rules: Vec<u8>,
}

/// Changing a token's policy (FR-009, FR-010).
///
/// Policy is data, so the change takes effect without re-issuing the token,
/// without migrating holders and without any action on their part: on the
/// next transfer the hook reads the new version, because
/// `TokenConfig.policy_version` already points at it.
///
/// **The quorum comes from one of two places, never from both** (T025). Either
/// the authorising wallets sign this very transaction and arrive in
/// `remaining_accounts`, or they signed an `ActionProposal` on different days
/// and it arrives in `proposal`. The threshold rule is the same one in both
/// cases — `quorum::check` does not know which path it is serving.
#[derive(Accounts)]
#[instruction(args: SetPolicyArgs)]
pub struct SetPolicy<'info> {
    #[account(
        seeds = [ISSUER_SEED, issuer_config.issuer_id.as_ref()],
        bump = issuer_config.bump,
    )]
    pub issuer_config: Account<'info, IssuerConfig>,

    /// Must come before `policy_config`: its `mint` is a seed of the next
    /// account, and Anchor checks fields in declaration order.
    #[account(
        mut,
        seeds = [TOKEN_SEED, token_config.mint.as_ref()],
        bump = token_config.bump,
        constraint = token_config.issuer == issuer_config.key() @ ForgeError::TokenNotFromThisIssuer,
    )]
    pub token_config: Account<'info, TokenConfig>,

    /// The new version. `init` here is the immutability of history (FR-010):
    /// a version that already exists is not created a second time, and the
    /// program has no instruction that would open it for writing.
    #[account(
        init,
        payer = payer,
        space = POLICY_CONFIG_LEN,
        seeds = [POLICY_SEED, token_config.mint.as_ref(), &args.version.to_le_bytes()],
        bump,
    )]
    pub policy_config: AccountLoader<'info, PolicyConfig>,

    /// Who pays the rent for the new version. This signature grants no powers
    /// — only the quorum does, whichever of the two paths it came by.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,

    /// A matured proposal, on the deferred path (FR-019b).
    ///
    /// No `seeds` constraint on it, and that is deliberate rather than an
    /// omission: an optional account cannot name its own fields in a seed
    /// expression, and it does not need to. `Account<ActionProposal>` already
    /// proves the owner and the discriminator, `propose_action` is the only
    /// way such an account comes to exist, and it creates it through `init`
    /// at its PDA — so every `ActionProposal` is at its address by
    /// construction. What still has to be checked is that it is **this**
    /// issuer's and **this** token's, and the handler checks exactly that.
    #[account(mut)]
    pub proposal: Option<Box<Account<'info, ActionProposal>>>,
    // `remaining_accounts` are the wallets authorising the change on the
    // immediate path. Each must sign the transaction and be in the issuer's
    // membership with a role that grants the right to authorise; there must
    // be at least `quorum_n` of them. On the deferred path there must be
    // none.
}

pub(crate) fn handler(ctx: Context<SetPolicy>, args: SetPolicyArgs) -> Result<()> {
    require!(
        args.rules.len() == RULES_BYTES,
        ForgeError::PolicyRulesNotCanonical
    );

    // The next version and only it. The condition "current ≥ first" is not
    // redundant here: it makes `set_policy` unable to write the first version
    // at all. The first is written by `create_token` (T018) with the same
    // `PolicyConfig::write`, so the state "the token exists, the policy does
    // not" never exists for a moment — and neither the hook nor the console
    // has to handle it.
    let current = ctx.accounts.token_config.policy_version;
    require!(
        current >= FIRST_POLICY_VERSION
            && Some(args.version) == current.checked_add(1),
        ForgeError::PolicyVersionNotNext
    );

    let now = Clock::get()?.unix_timestamp;

    // FR-035: a policy change is an action of the issuer's wallets by quorum,
    // and the program checks it, not the console.
    let approvals = match &ctx.accounts.proposal {
        Some(proposal) => {
            // One source of authorisation, never two. A union of the two
            // would let a proposal one signature short be finished by a
            // co-signer in this transaction — defensible on its own, but it
            // would also make "who authorised this" two lists that the
            // journal has to join, and the wallet that appears in both would
            // read as a duplicate.
            require!(
                ctx.remaining_accounts.is_empty(),
                ForgeError::QuorumSourceAmbiguous
            );
            require!(
                proposal.issuer == ctx.accounts.issuer_config.key(),
                ForgeError::ProposalNotForThisIssuer
            );
            require!(
                proposal.mint == ctx.accounts.token_config.mint,
                ForgeError::ProposalNotForThisToken
            );
            proposal.live(now)?;
            // The digest is recomputed from the bytes this transaction
            // carries, by the same function that computed it at proposal
            // time. That is what binds the execution to exactly the rules the
            // approvers were shown, and it is why the proposal needs to store
            // only 32 bytes of them.
            require!(
                ActionKind::set_policy(args.version, &args.rules)? == proposal.action,
                ForgeError::ProposalBodyMismatch
            );
            proposal.approvals().to_vec()
        }
        None => quorum::approvals_from(ctx.remaining_accounts)?,
    };
    quorum::check(&ctx.accounts.issuer_config, &approvals)?;

    let author = approvals[0];
    let bump = ctx.bumps.policy_config;

    {
        let mut policy = ctx.accounts.policy_config.load_init()?;
        policy.write(
            args.version,
            ctx.accounts.token_config.mint,
            author,
            &args.rules,
            now,
            bump,
        )?;
    }

    // The last actions: until these lines the previous version stays current
    // and the proposal stays unexecuted, so a refusal at any check above does
    // not leave the token on a policy the program just rejected, nor burn a
    // proposal that never took effect.
    ctx.accounts.token_config.policy_version = args.version;
    if let Some(proposal) = ctx.accounts.proposal.as_mut() {
        proposal.executed_at = now;
    }
    Ok(())
}
