//! `Execute` — точка, у якій правило стає невідворотним (FR-002, FR-011, FR-012).
//!
//! Токен-програма кличе цю інструкцію всередині кожного `transfer_checked` по
//! mint із розширенням `TransferHook`. Обійти її не можна ні з гаманця, ні
//! через CPI з чужої програми, ні делегованими повноваженнями: перевірка живе не
//! в застосунку, а в самому токені.
//!
//! **Що робить хук і чого не робить.** Він читає — акаунти статусу, лічильник,
//! політику, — складає `TransferContext` і віддає рішення оцінювачу
//! (`rules::evaluate`). Жодного правила тут не написано вдруге: розійтися з
//! TS-половиною було б нічому. Пише хук рівно один акаунт — лічильник вікна
//! відправника, і тільки після дозволу.
//!
//! **Відсутність акаунта — відмова, а не пропуск** (FR-013). Тому акаунти
//! статусу приймаються нетипізованими: `Account<'info, T>` дав би помилку Anchor
//! «акаунт не ініціалізований», а холдер має побачити `SENDER_STATUS_MISSING` —
//! назву причини, а не збій.
use anchor_lang::prelude::*;
use anchor_lang::{AccountDeserialize, AccountSerialize};
use anchor_spl::token_2022::spl_token_2022::extension::transfer_hook::TransferHookAccount;
use anchor_spl::token_2022::spl_token_2022::extension::{BaseStateWithExtensions, StateWithExtensions};
use anchor_spl::token_2022::spl_token_2022::state::Account as SplTokenAccount;
use anchor_spl::token_interface::{Mint, TokenAccount};
use spl_transfer_hook_interface::error::TransferHookError;

use crate::constants::TOKEN_SEED;
use crate::hook::attestation;
use crate::rules::evaluate::{
    evaluate, period_window_seconds, PartyContext, SourceState, StatusRecord, TransferContext,
    VelocityCounterView,
};
use crate::state::{HolderStatus, PolicyConfig, TokenConfig, VelocityCounter};

/// Порядок полів **є протоколом**: він мусить збігатися з переліком у
/// `extra_accounts.rs` рядок у рядок, бо токен-програма підкладає акаунти саме
/// за тим переліком. Перестановка тут не зламає збірки — вона змусить хук
/// читати чужий акаунт як свій.
#[derive(Accounts)]
pub struct Execute<'info> {
    #[account(token::mint = mint)]
    pub source_token: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(token::mint = mint)]
    pub destination_token: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: власник джерела переказу; його передає токен-програма.
    pub owner: UncheckedAccount<'info>,

    /// CHECK: перелік extra-акаунтів; його адресу перевіряє токен-програма.
    pub extra_account_meta_list: UncheckedAccount<'info>,

    #[account(
        seeds = [TOKEN_SEED, mint.key().as_ref()],
        bump = token_config.bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    /// Чинна версія політики. Її адресу резолвить токен-програма з поля
    /// `policy_version` у `TokenConfig`, тож підсунути іншу версію неможливо;
    /// перевірка нижче лишається другим замком, а не єдиним.
    pub policy_config: AccountLoader<'info, PolicyConfig>,

    /// CHECK: розбирається вручну — відсутність акаунта мусить давати наш код
    /// відмови, а не помилку Anchor.
    pub sender_status: UncheckedAccount<'info>,

    /// CHECK: те саме; єдиний акаунт, який хук пише.
    #[account(mut)]
    pub sender_velocity: UncheckedAccount<'info>,

    /// CHECK: те саме, для отримувача.
    pub recipient_status: UncheckedAccount<'info>,

    /// CHECK: програма SAS. Потрібна як акаунт, бо на неї посилаються зовнішні
    /// PDA атестацій у переліку.
    pub sas_program: UncheckedAccount<'info>,

    /// CHECK: атестація відправника; розбирається `hook::attestation`.
    pub sender_attestation: UncheckedAccount<'info>,

    /// CHECK: атестація отримувача.
    pub recipient_attestation: UncheckedAccount<'info>,
}

/// Токен-акаунт у стані переказу.
///
/// Без цієї перевірки хук можна було б покликати напряму, поза переказом. Сам по
/// собі такий виклик коштів не рухає, але він рухає **лічильник вікна** — тобто
/// дає стороннім спосіб витратити чужий ліміт за період. Прапорець ставить сама
/// токен-програма на час CPI.
fn require_transferring(info: &AccountInfo) -> Result<()> {
    let data = info.try_borrow_data()?;
    let state = StateWithExtensions::<SplTokenAccount>::unpack(&data)
        .map_err(|_| error!(crate::error::ForgeError::HolderAccountMismatch))?;
    let extension = state
        .get_extension::<TransferHookAccount>()
        .map_err(|_| ProgramError::from(TransferHookError::ProgramCalledOutsideOfTransfer))?;
    if !bool::from(extension.transferring) {
        return Err(ProgramError::from(TransferHookError::ProgramCalledOutsideOfTransfer).into());
    }
    Ok(())
}

/// Прочитати `HolderStatus` із нетипізованого акаунта.
///
/// Три стани — три різні речі, і кожна має власний код відмови на виході:
/// порожній акаунт означає «запису немає», чужий власник або нечитабельне тіло —
/// «джерело недоступне», а запис не про цього холдера — теж недоступне, бо ми не
/// знаємо, що сказало б справжнє.
fn read_holder(info: &AccountInfo, mint: &Pubkey, wallet: &Pubkey) -> SourceState<StatusRecord> {
    if info.data_is_empty() {
        return SourceState::Absent;
    }
    if info.owner != &crate::ID {
        return SourceState::Unavailable;
    }
    let data = info.data.borrow();
    let mut slice: &[u8] = &data;
    match HolderStatus::try_deserialize(&mut slice) {
        Ok(status) if status.mint == *mint && status.wallet == *wallet => {
            SourceState::Record(status.record())
        }
        _ => SourceState::Unavailable,
    }
}

/// Лічильник вікна. `None` — акаунта немає, і це відмова, якщо політика має
/// ліміт за період (`VELOCITY_COUNTER_MISSING`).
fn read_counter(info: &AccountInfo, mint: &Pubkey, wallet: &Pubkey) -> Option<VelocityCounter> {
    if info.data_is_empty() || info.owner != &crate::ID {
        return None;
    }
    let data = info.data.borrow();
    let mut slice: &[u8] = &data;
    match VelocityCounter::try_deserialize(&mut slice) {
        Ok(counter) if counter.mint == *mint && counter.wallet == *wallet => Some(counter),
        _ => None,
    }
}

fn write_counter(info: &AccountInfo, counter: &VelocityCounter) -> Result<()> {
    let mut data = info.try_borrow_mut_data()?;
    let mut slice: &mut [u8] = &mut data;
    counter.try_serialize(&mut slice)?;
    Ok(())
}

pub(crate) fn handler(ctx: Context<Execute>, amount: u64) -> Result<()> {
    // Обидві сторони мусять бути в стані переказу: інакше це не переказ.
    require_transferring(&ctx.accounts.source_token.to_account_info())?;
    require_transferring(&ctx.accounts.destination_token.to_account_info())?;

    let mint = ctx.accounts.mint.key();
    let sender = ctx.accounts.source_token.owner;
    let recipient = ctx.accounts.destination_token.owner;
    let token_config = &ctx.accounts.token_config;

    let counter = read_counter(
        &ctx.accounts.sender_velocity.to_account_info(),
        &mint,
        &sender,
    );

    let context = TransferContext {
        sender: PartyContext {
            provider: attestation::read(
                &ctx.accounts.sender_attestation.to_account_info(),
                &token_config.attestation_credential,
                &token_config.attestation_schema,
                &sender,
            ),
            register: read_holder(
                &ctx.accounts.sender_status.to_account_info(),
                &mint,
                &sender,
            ),
        },
        recipient: PartyContext {
            provider: attestation::read(
                &ctx.accounts.recipient_attestation.to_account_info(),
                &token_config.attestation_credential,
                &token_config.attestation_schema,
                &recipient,
            ),
            register: read_holder(
                &ctx.accounts.recipient_status.to_account_info(),
                &mint,
                &recipient,
            ),
        },
        amount,
        velocity: counter.as_ref().map(VelocityCounter::view),
        mint_policy_version: token_config.policy_version,
        policy_version: 0,
        now: Clock::get()?.unix_timestamp,
    };

    let policy = ctx.accounts.policy_config.load()?;
    // Політика чужого mint із тим самим номером версії — єдине, чого резолюція
    // за seeds не виключає сама (адреса виводиться з mint, але акаунт міг би
    // прийти від клієнта, який резолюцію обійшов).
    require_keys_eq!(
        policy.mint,
        mint,
        crate::error::ForgeError::PolicyVersionMismatch
    );
    let context = TransferContext {
        policy_version: policy.version,
        ..context
    };

    evaluate(&policy.rules, &context)?;

    // Лічильник рухається **тільки після дозволу**: відхилений переказ не
    // витрачає ліміту, інакше відмова коштувала б холдеру вікна.
    if let (Some(mut counter), Some(window)) = (counter, period_window_seconds(&policy.rules)) {
        let closed = context.now >= counter.window_start.saturating_add(i64::from(window));
        if closed {
            counter.window_start = context.now;
            counter.spent_in_window = amount;
        } else {
            counter.spent_in_window = counter.spent_in_window.saturating_add(amount);
        }
        drop(policy);
        write_counter(&ctx.accounts.sender_velocity.to_account_info(), &counter)?;
    }

    Ok(())
}
