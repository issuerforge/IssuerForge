use anchor_lang::prelude::*;

use crate::constants::{FIRST_POLICY_VERSION, ISSUER_SEED, POLICY_SEED, TOKEN_SEED};
use crate::error::ForgeError;
use crate::quorum;
use crate::rules::layout::RULES_BYTES;
use crate::state::{IssuerConfig, PolicyConfig, TokenConfig, POLICY_CONFIG_LEN};

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
    /// — only the quorum among `remaining_accounts` does.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
    // `remaining_accounts` are the wallets authorising the change. Each must
    // sign the transaction and be in the issuer's membership with a role
    // that grants the right to authorise; there must be at least `quorum_n`
    // of them.
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

    // FR-035: a policy change is an action of the issuer's wallets by quorum,
    // and the program checks it, not the console.
    let approvals = quorum::approvals_from(ctx.remaining_accounts)?;
    quorum::check(&ctx.accounts.issuer_config, &approvals)?;

    let author = approvals[0];
    let now = Clock::get()?.unix_timestamp;
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

    // The last action: until this line the previous version stays current,
    // so a refusal at any check above does not leave the token on a policy
    // the program just rejected.
    ctx.accounts.token_config.policy_version = args.version;
    Ok(())
}
