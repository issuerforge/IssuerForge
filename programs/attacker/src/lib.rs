//! Чужа програма, яка переказує наш токен через CPI.
//!
//! **Це не приклад інтеграції, а інструмент виміру.** Головна обіцянка проєкту
//! звучить так: правило виконує сам токен, а не застосунок (`docs/SPEC.md`,
//! FR-002). Довести її можна єдиним способом — переказати повз наш застосунок і
//! отримати відмову. Три вектори з чотирьох (сторонній клієнт, делегат,
//! дроблення) роблять це з боку клієнта; четвертий вимагає **іншої програми на
//! ланцюгу**, бо саме програма-посередник — це те, чим обходять перевірки, що
//! живуть у застосунку.
//!
//! Програма не має ані стану, ані повноважень, ані власних перевірок: вона
//! робить рівно один CPI й нічого більше. Усе, що станеться далі, — це рішення
//! токен-програми та нашого хука, і саме воно вимірюється (SC-002).
//!
//! **Деплоїться разом із демо й ніде більше.** У продукті її немає: у
//! `docs/PLAN.md` вона не значиться, а `tools/demo` — єдиний, хто її кличе.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

declare_id!("9ZCmUGqkrtBrm83uiiMwBgRrV2cBPE9HGMgA25iRJGkQ");

/// `TokenInstruction::TransferChecked` — індекс 12 у токен-програмі.
///
/// Інструкція складається руками, а не через `anchor_spl::token_interface::
/// transfer_checked`: той будує **фіксований** перелік акаунтів і
/// `remaining_accounts` у CPI не передає. Без них токен-програма не має чого
/// підкласти хуку, і відмова приходить «бракує акаунта» — тобто вимір SC-002
/// доводив би поламану проводку, а не роботу правила. Це виявив перший прогін
/// демо (T024).
const TRANSFER_CHECKED: u8 = 12;

#[program]
pub mod attacker {
    use super::*;

    /// Переказ через посередника: підписує власник, викликає ця програма.
    ///
    /// Додаткові акаунти хука приходять у `remaining_accounts` і йдуть у CPI
    /// без змін — і в переліку метаданих, і в переліку `AccountInfo`.
    pub fn relay_transfer<'info>(
        ctx: Context<'_, '_, '_, 'info, RelayTransfer<'info>>,
        amount: u64,
        decimals: u8,
    ) -> Result<()> {
        let mut data = Vec::with_capacity(10);
        data.push(TRANSFER_CHECKED);
        data.extend_from_slice(&amount.to_le_bytes());
        data.push(decimals);

        let mut metas = vec![
            AccountMeta::new(ctx.accounts.source.key(), false),
            AccountMeta::new_readonly(ctx.accounts.mint.key(), false),
            AccountMeta::new(ctx.accounts.destination.key(), false),
            AccountMeta::new_readonly(ctx.accounts.authority.key(), true),
        ];
        let mut infos = vec![
            ctx.accounts.source.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.destination.to_account_info(),
            ctx.accounts.authority.to_account_info(),
        ];

        for account in ctx.remaining_accounts {
            metas.push(AccountMeta {
                pubkey: *account.key,
                is_signer: account.is_signer,
                is_writable: account.is_writable,
            });
            infos.push(account.clone());
        }

        invoke(
            &Instruction {
                program_id: ctx.accounts.token_program.key(),
                accounts: metas,
                data,
            },
            &infos,
        )?;

        Ok(())
    }
}

/// Жодного обмеження на акаунти тут немає навмисно.
///
/// Ця програма не має захищати нічого: її задача — бути найзручнішим із
/// можливих обходів. Перевірки, які тут спокусливо дописати, є в токен-програмі
/// й у хуку, і саме вони мусять спрацювати.
#[derive(Accounts)]
pub struct RelayTransfer<'info> {
    #[account(mut)]
    pub source: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    pub authority: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}
