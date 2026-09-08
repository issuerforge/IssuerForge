use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::state::AccountState;
use anchor_spl::token_interface::{
    thaw_account, Mint, ThawAccount, TokenAccount, TokenInterface,
};

use crate::authority::require_routine;
use crate::constants::{HOLDER_SEED, ISSUER_SEED, TOKEN_SEED, VELOCITY_SEED};
use crate::error::ForgeError;
use crate::state::{delegation, HolderStatus, HolderStatusInput, IssuerConfig, TokenConfig, VelocityCounter};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ThawHolderArgs {
    /// Власник рахунку. Мусить збігтися з `owner` токен-акаунта — інакше
    /// статус ліг би за адресою, якої переказ ніколи не прочитає.
    pub wallet: Pubkey,
    /// Початковий статус — тільки для **першого** розморожування.
    ///
    /// `None` означає «запис уже є, я його не чіпаю»: так виглядає повторне
    /// розморожування після заморозки офіцером (T026). Розбіжність між
    /// наміром і станом акаунта відхиляється, а не тлумачиться, тож жоден
    /// виклик не змінює статусу мовчки.
    pub status: Option<HolderStatusInput>,
}

/// Розморожування рахунку холдера (FR-008b).
///
/// **Хук не створює акаунтів** — ані payer, ані підпису system program у нього
/// немає, — тож `HolderStatus` і `VelocityCounter` створюються тут, наперед.
/// Рахунок, для якого їх немає, отримує відмову в переказі, а не пропуск
/// перевірки (FR-013).
///
/// Розморожування **не є дозволом на переказ** (FR-008b1): воно лише знімає
/// `DefaultAccountState = Frozen`, після чого кожен переказ окремо проходить
/// правила політики. Рахунок, розморожений учора, отримає відмову сьогодні,
/// якщо статус більше не задовольняє чинну версію.
#[derive(Accounts)]
#[instruction(args: ThawHolderArgs)]
pub struct ThawHolder<'info> {
    #[account(
        seeds = [ISSUER_SEED, issuer_config.issuer_id.as_ref()],
        bump = issuer_config.bump,
    )]
    pub issuer_config: Account<'info, IssuerConfig>,

    #[account(
        seeds = [TOKEN_SEED, token_config.mint.as_ref()],
        bump = token_config.bump,
        constraint = token_config.issuer == issuer_config.key() @ ForgeError::TokenNotFromThisIssuer,
    )]
    pub token_config: Account<'info, TokenConfig>,

    #[account(
        mut,
        constraint = mint.key() == token_config.mint @ ForgeError::HolderAccountMismatch,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    /// Токен-акаунт холдера. Обидві перевірки обов'язкові: адреса акаунта не
    /// доводить ані його mint, ані власника, а статус виводиться саме з
    /// `wallet`.
    #[account(
        mut,
        constraint = token_account.mint == token_config.mint @ ForgeError::HolderAccountMismatch,
        constraint = token_account.owner == args.wallet @ ForgeError::HolderAccountMismatch,
    )]
    pub token_account: InterfaceAccount<'info, TokenAccount>,

    /// `init_if_needed`, бо рахунок законно розморожують удруге — після
    /// заморозки офіцером. Повторне створення нічого не переписує: що саме
    /// пишеться, вирішує `updated_at`, а не наявність акаунта.
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + HolderStatus::INIT_SPACE,
        seeds = [HOLDER_SEED, token_config.mint.as_ref(), args.wallet.as_ref()],
        bump,
    )]
    pub holder_status: Account<'info, HolderStatus>,

    /// Так само `init_if_needed` — і **жодне значення вікна тут не пишеться**,
    /// тільки власна ідентичність акаунта. Скидання вікна операційним ключем
    /// зняло б ліміт за період рутинною дією, тобто дало б повноваження, якого
    /// в масці делегації немає й не може бути (FR-035a).
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + VelocityCounter::INIT_SPACE,
        seeds = [VELOCITY_SEED, token_config.mint.as_ref(), args.wallet.as_ref()],
        bump,
    )]
    pub velocity_counter: Account<'info, VelocityCounter>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// Операційний ключ платформи або уповноважений учасник складу.
    pub authority: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn thaw_handler(ctx: Context<ThawHolder>, args: ThawHolderArgs) -> Result<()> {
    require_routine(
        &ctx.accounts.issuer_config,
        &ctx.accounts.authority.key(),
        delegation::THAW_HOLDER,
    )?;

    let now = Clock::get()?.unix_timestamp;
    let holder = &mut ctx.accounts.holder_status;

    match (holder.is_written(), args.status) {
        // Перше розморожування: статус приходить разом із ним.
        (false, Some(status)) => {
            holder.mint = ctx.accounts.token_config.mint;
            holder.wallet = args.wallet;
            holder.bump = ctx.bumps.holder_status;
            holder.apply(&status, now)?;
        }
        // Повторне: статус уже є, і змінює його тільки `set_holder_status` — під
        // власним повноваженням делегації. Інакше ключ із самим лише
        // `THAW_HOLDER` переписував би реєстр статусів через повторний виклик.
        (true, None) => {}
        (false, None) => return err!(ForgeError::HolderStatusRequired),
        (true, Some(_)) => return err!(ForgeError::HolderStatusAlreadySet),
    }

    // Лічильник: тільки його власна ідентичність. Значення вікна лишаються
    // такими, як їх лишив останній переказ, — і саме тому вони тут не
    // згадуються.
    let counter = &mut ctx.accounts.velocity_counter;
    counter.mint = ctx.accounts.token_config.mint;
    counter.wallet = args.wallet;
    counter.bump = ctx.bumps.velocity_counter;

    // Заморожений рахунок — стан за замовчуванням (`DefaultAccountState`), але
    // повторне розморожування вже розмороженого відхилила б токен-програма, а
    // акаунти статусу при цьому вже створені. Пропуск тут робить інструкцію
    // ідемпотентною для того, заради чого її кличуть удруге.
    if ctx.accounts.token_account.state == AccountState::Frozen {
        let mint_key = ctx.accounts.token_config.mint;
        let signer: &[&[u8]] = &[TOKEN_SEED, mint_key.as_ref(), &[ctx.accounts.token_config.bump]];
        thaw_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            ThawAccount {
                account: ctx.accounts.token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                authority: ctx.accounts.token_config.to_account_info(),
            },
            &[signer],
        ))?;
    }

    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SetHolderStatusArgs {
    pub wallet: Pubkey,
    pub status: HolderStatusInput,
}

/// Оновлення власного реєстру статусів емітента (FR-008a, FR-008b1).
///
/// Друга половина пари: `thaw_holder` заводить запис, ця інструкція його
/// змінює — знижує рівень, міняє юрисдикцію, ставить строк або вмикає
/// `denied`. Саме вона робить FR-008b1 виконуваним: рахунок лишається
/// розмороженим, а переказ із нього перестає проходити тієї ж миті, бо статус
/// читається на **кожному** переказі, а не при розморожуванні.
///
/// Токен-акаунта тут немає навмисно: зміна статусу нічого не морозить. Заморозка
/// — окрема комплаєнс-дія з підставою й кейсом (T026, FR-014).
#[derive(Accounts)]
#[instruction(args: SetHolderStatusArgs)]
pub struct SetHolderStatus<'info> {
    #[account(
        seeds = [ISSUER_SEED, issuer_config.issuer_id.as_ref()],
        bump = issuer_config.bump,
    )]
    pub issuer_config: Account<'info, IssuerConfig>,

    #[account(
        seeds = [TOKEN_SEED, token_config.mint.as_ref()],
        bump = token_config.bump,
        constraint = token_config.issuer == issuer_config.key() @ ForgeError::TokenNotFromThisIssuer,
    )]
    pub token_config: Account<'info, TokenConfig>,

    /// Без `init`: запису, якого немає, ця інструкція не заводить. Створення
    /// прив'язане до розморожування, бо статус без розмороженого рахунку нічого
    /// не означає, а `HolderStatus` без `VelocityCounter` дав би відмову в
    /// переказі там, де емітент вважає холдера впорядкованим.
    #[account(
        mut,
        seeds = [HOLDER_SEED, token_config.mint.as_ref(), args.wallet.as_ref()],
        bump = holder_status.bump,
    )]
    pub holder_status: Account<'info, HolderStatus>,

    pub authority: Signer<'info>,
}

pub(crate) fn set_status_handler(
    ctx: Context<SetHolderStatus>,
    args: SetHolderStatusArgs,
) -> Result<()> {
    require_routine(
        &ctx.accounts.issuer_config,
        &ctx.accounts.authority.key(),
        delegation::SET_HOLDER_STATUS,
    )?;

    let now = Clock::get()?.unix_timestamp;
    ctx.accounts.holder_status.apply(&args.status, now)
}
