// Програма issuer-forge: політика як дані, кворум на дії з коштами, гейт емісії
// за резервом, escrow погашень і transfer hook, який усе це виконує.
// Інструкції наповнюються у Фазі 4 — склад і порядок у docs/TASKS.md.
//
// Програма одна на всіх емітентів (docs/PLAN.md → «Архітектура»): під емітента
// деплою немає, є набір PDA. Саме це робить FR-003 можливим.
use anchor_lang::prelude::*;

pub mod authority;
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

    /// Розморожує рахунок холдера й заводить обидва акаунти, без яких переказ
    /// відмовляє: `HolderStatus` і `VelocityCounter` (FR-008b).
    ///
    /// Хук не створює акаунтів, тож їх створюють тут — наперед. Саме
    /// розморожування дозволом на переказ не є (FR-008b1): правила політики
    /// перевіряються на кожному переказі окремо.
    pub fn thaw_holder(ctx: Context<ThawHolder>, args: ThawHolderArgs) -> Result<()> {
        instructions::thaw_holder::thaw_handler(ctx, args)
    }

    /// Оновлює статус адреси у власному реєстрі емітента (FR-008a, FR-008b1).
    ///
    /// Ця інструкція й робить FR-008b1 виконуваним: рахунок лишається
    /// розмороженим, а переказ із нього перестає проходити тієї ж миті, коли
    /// статус більше не задовольняє політику.
    pub fn set_holder_status(
        ctx: Context<SetHolderStatus>,
        args: SetHolderStatusArgs,
    ) -> Result<()> {
        instructions::thaw_holder::set_status_handler(ctx, args)
    }
}
