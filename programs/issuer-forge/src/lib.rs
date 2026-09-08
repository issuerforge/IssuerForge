// Програма issuer-forge: політика як дані, кворум на дії з коштами, гейт емісії
// за резервом, escrow погашень і transfer hook, який усе це виконує.
// Інструкції наповнюються у Фазі 4 — склад і порядок у docs/TASKS.md.
//
// Програма одна на всіх емітентів (docs/PLAN.md → «Архітектура»): під емітента
// деплою немає, є набір PDA. Саме це робить FR-003 можливим.
use anchor_lang::prelude::*;
use spl_discriminator::SplDiscriminate;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

pub mod authority;
pub mod constants;
pub mod error;
pub mod hook;
pub mod instructions;
pub mod quorum;
pub mod reserve;
pub mod rules;
pub mod state;

use hook::*;
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

    /// Публікує атестацію резерву (FR-021, FR-024, FR-026).
    ///
    /// Підписує рівно чинний атестатор цього токена: атестація нічого не
    /// дозволяє, вона лише звужує те, що дозволено, і саме тому не потребує
    /// кворуму. Запис append-only — переписати його нічим.
    pub fn attest_reserve(ctx: Context<AttestReserve>, args: AttestReserveArgs) -> Result<()> {
        instructions::attest_reserve::handler(ctx, args)
    }

    /// Створює `ExtraAccountMetaList` — перелік акаунтів, які токен-програма
    /// підкладатиме хуку на кожному переказі (FR-012).
    ///
    /// Окремою інструкцією від випуску: перелік належить інтерфейсу хука, а не
    /// mint. Клієнт кладе обидві в одну транзакцію.
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        hook::extra_accounts::handler(ctx)
    }

    /// Transfer hook: перевірка правил на кожному переказі (FR-002, FR-011,
    /// FR-012).
    ///
    /// Дискримінатор заданий явно: цю інструкцію кличе токен-програма за
    /// інтерфейсом `spl-transfer-hook-interface`, а не клієнт за іменем, тож
    /// вісім байтів мусять бути ті, що в інтерфейсі, а не ті, що Anchor вивів би
    /// з назви.
    #[instruction(discriminator = ExecuteInstruction::SPL_DISCRIMINATOR_SLICE)]
    pub fn execute(ctx: Context<Execute>, amount: u64) -> Result<()> {
        hook::execute::handler(ctx, amount)
    }
}
