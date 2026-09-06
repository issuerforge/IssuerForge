// Програма issuer-forge: політика як дані, кворум на дії з коштами, гейт емісії
// за резервом, escrow погашень і transfer hook, який усе це виконує.
// Інструкції наповнюються у Фазі 4 — склад і порядок у docs/TASKS.md.
//
// Програма одна на всіх емітентів (docs/PLAN.md → «Архітектура»): під емітента
// деплою немає, є набір PDA. Саме це робить FR-003 можливим.
use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod instructions;
pub mod quorum;
pub mod rules;
pub mod state;

use instructions::*;

declare_id!("ForgePo1icy11111111111111111111111111111111");

#[program]
pub mod issuer_forge {
    use super::*;

    /// Створює емітента: склад уповноважених, поріг кворуму й межі, у яких
    /// операційний ключ платформи може діяти (FR-019a, FR-033, FR-035).
    ///
    /// Єдина дія емітента, що не проходить кворум, — бо до неї кворуму ще
    /// немає. Усе, що вона задає, змінюється далі **тільки** кворумом.
    pub fn initialize_issuer(
        ctx: Context<InitializeIssuer>,
        args: InitializeIssuerArgs,
    ) -> Result<()> {
        instructions::initialize_issuer::handler(ctx, args)
    }

    /// Записує наступну версію політики й переводить токен на неї (FR-009,
    /// FR-010).
    ///
    /// Зміна набуває сили без повторного випуску токена й без дій з боку
    /// холдерів: політика — дані, і хук читає нову версію вже на наступному
    /// переказі. Попередні версії лишаються на своїх адресах назавжди.
    ///
    /// Санкціонує зміну кворум гаманців емітента (FR-035), а не операційний
    /// ключ платформи: підписи передаються в `remaining_accounts`.
    pub fn set_policy(ctx: Context<SetPolicy>, args: SetPolicyArgs) -> Result<()> {
        instructions::set_policy::handler(ctx, args)
    }
}
