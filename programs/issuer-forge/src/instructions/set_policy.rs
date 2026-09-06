use anchor_lang::prelude::*;

use crate::constants::{FIRST_POLICY_VERSION, ISSUER_SEED, POLICY_SEED, TOKEN_SEED};
use crate::error::ForgeError;
use crate::quorum;
use crate::rules::layout::RULES_BYTES;
use crate::state::{IssuerConfig, PolicyConfig, TokenConfig, POLICY_CONFIG_LEN};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SetPolicyArgs {
    /// Номер нової версії. Мусить бути рівно наступним за чинною: пропуск
    /// зробив би «попередню версію» невиводимою з номера, а історію — переліком
    /// з дірками, який нічим не звірити.
    pub version: u32,
    /// Правила в канонічній розкладці, рівно `RULES_BYTES` байтів.
    ///
    /// `Vec<u8>`, а не масив: Borsh описує його як `bytes`, і IDL лишається
    /// читабельним для клієнта. Довжину перевіряє програма.
    pub rules: Vec<u8>,
}

/// Зміна політики токена (FR-009, FR-010).
///
/// Політика — дані, тож зміна набуває сили без повторного випуску токена, без
/// міграції холдерів і без жодної дії з їхнього боку: хук на наступному переказі
/// читає нову версію, бо `TokenConfig.policy_version` уже вказує на неї.
#[derive(Accounts)]
#[instruction(args: SetPolicyArgs)]
pub struct SetPolicy<'info> {
    #[account(
        seeds = [ISSUER_SEED, issuer_config.issuer_id.as_ref()],
        bump = issuer_config.bump,
    )]
    pub issuer_config: Account<'info, IssuerConfig>,

    /// Мусить іти перед `policy_config`: його `mint` є seed'ом наступного
    /// акаунта, а Anchor перевіряє поля в порядку оголошення.
    #[account(
        mut,
        seeds = [TOKEN_SEED, token_config.mint.as_ref()],
        bump = token_config.bump,
        constraint = token_config.issuer == issuer_config.key() @ ForgeError::TokenNotFromThisIssuer,
    )]
    pub token_config: Account<'info, TokenConfig>,

    /// Нова версія. `init` тут і є незмінністю історії (FR-010): версія, яка вже
    /// існує, не створюється вдруге, а інструкції, що відкрила б її на запис, у
    /// програмі немає.
    #[account(
        init,
        payer = payer,
        space = POLICY_CONFIG_LEN,
        seeds = [POLICY_SEED, token_config.mint.as_ref(), &args.version.to_le_bytes()],
        bump,
    )]
    pub policy_config: AccountLoader<'info, PolicyConfig>,

    /// Хто платить оренду за нову версію. Повноважень цей підпис не дає — їх
    /// дає тільки кворум серед `remaining_accounts`.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
    // `remaining_accounts` — гаманці, що санкціонують зміну. Кожен мусить
    // підписати транзакцію й стояти у складі емітента з роллю, яка дає право
    // санкціонувати; їх має бути не менше за `quorum_n`.
}

pub(crate) fn handler(ctx: Context<SetPolicy>, args: SetPolicyArgs) -> Result<()> {
    require!(
        args.rules.len() == RULES_BYTES,
        ForgeError::PolicyRulesNotCanonical
    );

    // Наступна версія й тільки вона. Умова «чинна ≥ першої» тут не зайва: вона
    // робить `set_policy` нездатним записати першу версію взагалі. Першу пише
    // `create_token` (T018) тією ж функцією `PolicyConfig::write`, тож стану
    // «токен є, політики немає» не існує ні миті — і його не доводиться
    // обробляти ані хуку, ані консолі.
    let current = ctx.accounts.token_config.policy_version;
    require!(
        current >= FIRST_POLICY_VERSION
            && Some(args.version) == current.checked_add(1),
        ForgeError::PolicyVersionNotNext
    );

    // FR-035: зміна політики — дія гаманців емітента за кворумом, і перевіряє
    // його програма, а не консоль.
    let approvals = quorum::approvals_from(ctx.remaining_accounts)?;
    quorum::check(&ctx.accounts.issuer_config, &approvals)?;

    let author = approvals[0];
    let now = Clock::get()?.unix_timestamp;
    let bump = ctx.bumps.policy_config;

    {
        let mut policy = ctx.accounts.policy_config.load_init()?;
        policy.write(args.version, author, &args.rules, now, bump)?;
    }

    // Остання дія: до цього рядка чинною лишається попередня версія, тож
    // відмова на будь-якій перевірці вище не лишає токен на політиці, яку
    // програма щойно відхилила.
    ctx.accounts.token_config.policy_version = args.version;
    Ok(())
}
