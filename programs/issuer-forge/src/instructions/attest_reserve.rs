use anchor_lang::prelude::*;

use crate::constants::{RESERVE_SEED, TOKEN_SEED};
use crate::error::ForgeError;
use crate::state::{validate_currency, ReserveAttestation, TokenConfig, CURRENCY_BYTES};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct AttestReserveArgs {
    /// Підтверджена сума в найменшій одиниці валюти резерву.
    pub amount: u64,
    pub currency: [u8; CURRENCY_BYTES],
    /// Момент, якого стосується підтвердження. Не «зараз»: атестатор
    /// підтверджує стан рахунку на певний час, і саме від нього рахується строк
    /// придатності (FR-023).
    pub attested_at: i64,
}

/// Публікація атестації резерву (FR-021, FR-024, FR-024b, FR-026).
///
/// **Підписує рівно один ключ — чинний атестатор цього токена.** Не кворум:
/// атестація нічого не дозволяє, вона лише **звужує** те, що дозволено. Не
/// операційний ключ платформи: FR-024 вимагає, щоб ключ атестатора не міг більше
/// нічого, а операційний ключ уміє розморожувати рахунки.
///
/// Атестатор зберігається в `TokenConfig`, а не в `IssuerConfig`: емітент із
/// двома токенами законно має для них різних атестаторів (FR-024b).
#[derive(Accounts)]
pub struct AttestReserve<'info> {
    #[account(
        mut,
        seeds = [TOKEN_SEED, token_config.mint.as_ref()],
        bump = token_config.bump,
        constraint = token_config.attestor == attestor.key() @ ForgeError::NotTheAttestor,
    )]
    pub token_config: Account<'info, TokenConfig>,

    /// Наступний запис у послідовності. Індекс береться з лічильника, а не від
    /// клієнта: `init` за такою адресою неможливий двічі, тож пропустити номер
    /// або переписати попередній запис нічим.
    #[account(
        init,
        payer = payer,
        space = 8 + ReserveAttestation::INIT_SPACE,
        seeds = [
            RESERVE_SEED,
            token_config.mint.as_ref(),
            &token_config.attestation_count.to_le_bytes(),
        ],
        bump,
    )]
    pub attestation: Account<'info, ReserveAttestation>,

    /// Чинний атестатор резерву цього токена.
    pub attestor: Signer<'info>,

    /// Оренду платить хто завгодно: платіж не є повноваженням.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub(crate) fn handler(ctx: Context<AttestReserve>, args: AttestReserveArgs) -> Result<()> {
    validate_currency(&args.currency)?;
    // Валюта резерву мусить бути валютою токена: інакше «емісія + обіг ≤
    // атестованого» вимагало б курсу, а курсу в програмі немає й не буде.
    require!(
        args.currency == ctx.accounts.token_config.reserve_currency,
        ForgeError::ReserveCurrencyMismatch
    );

    let now = Clock::get()?.unix_timestamp;
    // Атестація з майбутнього подовжила б собі строк придатності наперед.
    require!(
        args.attested_at <= now,
        ForgeError::AttestationInTheFuture
    );

    let index = ctx.accounts.token_config.attestation_count;
    let attestation = &mut ctx.accounts.attestation;
    attestation.mint = ctx.accounts.token_config.mint;
    attestation.index = index;
    attestation.amount = args.amount;
    attestation.currency = args.currency;
    attestation.attestor = ctx.accounts.attestor.key();
    attestation.attested_at = args.attested_at;
    attestation.bump = ctx.bumps.attestation;

    // Лічильник рухається останнім: до цього рядка чинною лишається попередня
    // атестація, тож відмова вище не лишає токен без чинного резерву.
    ctx.accounts.token_config.attestation_count = index
        .checked_add(1)
        .ok_or(ForgeError::ReserveInsufficient)?;
    Ok(())
}
