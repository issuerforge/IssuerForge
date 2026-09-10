//! Випуск токена (FR-001, FR-005, FR-006, FR-022) і запис його метаданих.
//!
//! **Одна транзакція робить токен цілим.** Mint із п'ятьма розширеннями,
//! `TokenConfig`, політика версії 1, атестація резерву #0, рахунок засновника й
//! початкова емісія — усе тут. Проміжного стану, у якому токен уже існує, а
//! правило, резерв чи політика ще ні, не буває: інструкція або пройшла вся, або
//! не залишила по собі нічого.
//!
//! **Метадані пишуться другою транзакцією, і це не недогляд.** Розрахунок
//! бюджету (`SCRATCHPAD.md`, блок T018) дав ~1180 байтів із 1232 ще до рядків
//! назви й символу: 384 байти самої політики, 14 акаунтів, два підписи. Назва й
//! посилання не вміщаються — тому `create_token` ставить `MetadataPointer` на
//! сам mint (нуль байтів аргументів), а `set_token_metadata` дописує вміст.
//! Вікно між двома транзакціями безпечне: усі рахунки за замовчуванням
//! заморожені, а назва нічого не дозволяє й не забороняє.
use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, CreateAccount, Transfer};
use anchor_spl::associated_token::{self, AssociatedToken};
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::token_2022_extensions::spl_token_metadata_interface::state::TokenMetadata;
use anchor_spl::token_2022_extensions::{
    default_account_state_initialize, metadata_pointer_initialize, permanent_delegate_initialize,
    token_metadata_initialize, transfer_hook_initialize, DefaultAccountStateInitialize,
    MetadataPointerInitialize, PermanentDelegateInitialize, TokenMetadataInitialize,
    TransferHookInitialize,
};
use anchor_spl::token_interface::{
    initialize_mint2, mint_to, thaw_account, InitializeMint2, MintTo, ThawAccount, TokenInterface,
};
use spl_token_2022::extension::{ExtensionType, StateWithExtensions};
use spl_token_2022::state::{AccountState, Mint as MintState};

use crate::constants::{
    FIRST_ATTESTATION_INDEX_LE, FIRST_POLICY_VERSION, FIRST_POLICY_VERSION_LE, HOLDER_SEED,
    ISSUER_SEED, MINT_SEED, POLICY_SEED, RESERVE_SEED, TOKEN_SEED, VELOCITY_SEED,
};
use crate::error::ForgeError;
use crate::reserve::{require_latest, ReserveCheck};
use crate::state::{
    role, validate_currency, HolderStatus, HolderStatusInput, IssuerConfig, PolicyConfig,
    ReserveAttestation, TokenConfig, VelocityCounter, CURRENCY_BYTES, POLICY_CONFIG_LEN,
};

/// Розширення mint. **Перелік є контрактом із хуком, а не набором опцій.**
///
/// - `TransferHook` — те, заради чого проєкт існує: без нього правило
///   перевіряє застосунок, а не токен.
/// - `DefaultAccountState = Frozen` — рахунок, якого емітент не онбордив, не
///   отримує коштів. Це і робить `thaw_holder` осмисленим.
/// - `PermanentDelegate` — вилучення за приписом (FR-017), кворумом і з T027.
/// - `Pausable` — авторитетна пауза обігу (FR-016); `TokenConfig.paused_at`
///   лишається дзеркалом для екранів, а не джерелом правди.
/// - `MetadataPointer` — вказує на сам mint; вміст пише `set_token_metadata`.
///
/// Порядок у масиві впливає тільки на розмір акаунта, і то не впливає:
/// `try_calculate_account_len` рахує суму, а не послідовність.
const MINT_EXTENSIONS: [ExtensionType; 5] = [
    ExtensionType::TransferHook,
    ExtensionType::DefaultAccountState,
    ExtensionType::PermanentDelegate,
    ExtensionType::Pausable,
    ExtensionType::MetadataPointer,
];

/// Стелі рядків метаданих.
///
/// Межа тут не через смак: `token_metadata_initialize` **реалокує mint**, і
/// оренду за новий розмір платить той, хто кличе. Без стелі один виклик міг би
/// зажадати мегабайта оренди з гаманця офіцера.
const MAX_NAME_LEN: usize = 32;
const MAX_SYMBOL_LEN: usize = 12;
const MAX_URI_LEN: usize = 200;

/// Стеля ставки комісії: 100% у базисних пунктах (FR-038a).
const MAX_FEE_BPS: u16 = 10_000;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateTokenArgs {
    pub decimals: u8,
    /// SAS-credential провайдера, атестації якого приймає цей токен, і схема
    /// тих атестацій. Обидва — незмінні параметри (FR-005): їхні зсуви в
    /// `TokenConfig` зашиті в `address_config` переліку акаунтів хука.
    pub attestation_credential: Pubkey,
    pub attestation_schema: Pubkey,
    /// Скарбниця платформи (FR-038).
    pub treasury: Pubkey,
    pub fee_bps: u16,
    /// Строк придатності атестації резерву, секунди (FR-023b).
    pub attestation_max_age: i64,
    /// Валюта резерву, вона ж валюта токена.
    pub reserve_currency: [u8; CURRENCY_BYTES],
    /// Політика версії 1 у канонічній розкладці, рівно `RULES_BYTES` байтів.
    pub rules: Vec<u8>,
    /// Початкова емісія. Проходить ту саму перевірку резерву, що й `mint`
    /// (T038): інших шляхів появи токенів у програмі немає.
    pub initial_supply: u64,
    /// Перша атестація резерву: сума й момент, якого вона стосується. Валюта
    /// береться з `reserve_currency` — двох валют в одній транзакції не буває.
    pub reserve_amount: u64,
    pub reserve_attested_at: i64,
    /// Статус засновника у власному реєстрі емітента.
    ///
    /// Без нього рахунок, на який лягла емісія, не зміг би нічого відправити:
    /// хук читає статус відправника на кожному переказі й відсутність запису
    /// вважає відмовою (FR-013).
    pub founder_status: HolderStatusInput,
}

/// Випуск токена.
///
/// **Підписів рівно два — засновник і атестатор**, і кожен потрібен із власної
/// причини. Засновник мусить бути адміністратором складу: токен не створюється
/// від імені людей, серед яких тебе немає, і операційний ключ платформи сюди не
/// дістає ніколи (FR-035a). Атестатор потрібен тому, що перша атестація не може
/// передувати токену — її адреса виводиться з mint, — а токен без атестації
/// означав би емісію, за якою ніхто не поручився.
///
/// **Кворуму тут немає, і це вимушено, а не за смаком.** FR-035 називає емісію
/// серед дій, які потребують кворуму, і `mint` (T038) його матиме. Але кворум
/// 2-з-N у цій транзакції коштує ще один підпис і ще один ключ — 96 байтів на
/// 1180 наявних із 1232, — тобто транзакції з кворумом просто не існує без
/// таблиці адрес. Що при цьому не втрачено: емітент на момент випуску не має
/// жодного холдера, тож кворум захищав би тільки самих підписантів від себе;
/// продовження емісії, вилучення, пауза й зміна політики кворум мають.
#[derive(Accounts)]
#[instruction(args: CreateTokenArgs)]
pub struct CreateToken<'info> {
    /// Засновник, він же платник оренди.
    ///
    /// Об'єднані навмисно: окремий платник — це шістнадцятий акаунт і третій
    /// підпис, а їх немає куди покласти. Гаманець засновника без SOL платформа
    /// поповнює перед випуском; у `set_token_metadata` нижче платник знову
    /// окремий, бо там місце є.
    #[account(mut)]
    pub founder: Signer<'info>,

    /// Атестатор резерву цього токена. Мусить стояти у складі емітента з роллю
    /// атестатора, а вона за `initialize_issuer` несумісна з будь-якою іншою.
    pub attestor: Signer<'info>,

    /// `mut`, бо інструкція збільшує лічильник токенів — з нього виведена
    /// адреса mint.
    #[account(
        mut,
        seeds = [ISSUER_SEED, issuer_config.issuer_id.as_ref()],
        bump = issuer_config.bump,
    )]
    pub issuer_config: Account<'info, IssuerConfig>,

    /// CHECK: адресу задають seeds, вміст пише токен-програма. Типізувати
    /// нічим: акаунт ще не існує, а `InterfaceAccount<Mint>` вимагав би
    /// ініціалізованого mint — тобто того, що ця інструкція якраз і робить.
    #[account(
        mut,
        seeds = [MINT_SEED, issuer_config.issuer_id.as_ref(), &issuer_config.token_count.to_le_bytes()],
        bump,
    )]
    pub mint: UncheckedAccount<'info>,

    #[account(
        init,
        payer = founder,
        space = 8 + TokenConfig::INIT_SPACE,
        seeds = [TOKEN_SEED, mint.key().as_ref()],
        bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    /// Політика версії 1. Пишеться тією самою `PolicyConfig::write`, що й усі
    /// наступні версії: два писці означали б дві перевірки канонічності, з яких
    /// одна колись відстане.
    #[account(
        init,
        payer = founder,
        space = POLICY_CONFIG_LEN,
        seeds = [POLICY_SEED, mint.key().as_ref(), FIRST_POLICY_VERSION_LE.as_ref()],
        bump,
    )]
    pub policy_config: AccountLoader<'info, PolicyConfig>,

    /// Атестація #0. Індекс у seeds і `init` роблять історію незмінною без
    /// жодної перевірки з нашого боку (FR-026).
    #[account(
        init,
        payer = founder,
        space = 8 + ReserveAttestation::INIT_SPACE,
        seeds = [RESERVE_SEED, mint.key().as_ref(), FIRST_ATTESTATION_INDEX_LE.as_ref()],
        bump,
    )]
    pub attestation: Account<'info, ReserveAttestation>,

    /// CHECK: адресу виводить і звіряє сама ATA-програма при створенні —
    /// повторювати `create_program_address` тут означало б платити за ту саму
    /// перевірку двічі. Створити його наперед не можна: mint ще не існує.
    #[account(mut)]
    pub founder_token_account: UncheckedAccount<'info>,

    #[account(
        init,
        payer = founder,
        space = 8 + HolderStatus::INIT_SPACE,
        seeds = [HOLDER_SEED, mint.key().as_ref(), founder.key().as_ref()],
        bump,
    )]
    pub holder_status: Account<'info, HolderStatus>,

    #[account(
        init,
        payer = founder,
        space = 8 + VelocityCounter::INIT_SPACE,
        seeds = [VELOCITY_SEED, mint.key().as_ref(), founder.key().as_ref()],
        bump,
    )]
    pub velocity_counter: Account<'info, VelocityCounter>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn create_handler(ctx: Context<CreateToken>, args: CreateTokenArgs) -> Result<()> {
    // Засновник — адміністратор складу. Ця перевірка і є FR-035a на цьому
    // шляху: операційний ключ платформи в складі не стоїть, тож токенів він не
    // створює навіть скомпрометованим.
    require!(
        ctx.accounts
            .issuer_config
            .member_has(&ctx.accounts.founder.key(), role::ADMIN),
        ForgeError::NotAnAdmin
    );
    // Атестатор — теж учасник складу, а не будь-який ключ, який засновник
    // назвав атестатором. Інакше емітент поручався б за власний резерв сам,
    // просто підписавши другим гаманцем (FR-024).
    require!(
        ctx.accounts
            .issuer_config
            .member_has(&ctx.accounts.attestor.key(), role::ATTESTOR),
        ForgeError::NotAnAttestorMember
    );

    validate_currency(&args.reserve_currency)?;
    // Нульовий строк зробив би протермінованою кожну атестацію, включно з тією,
    // що створюється рядком нижче: токен випустився б непридатним до емісії.
    require!(
        args.attestation_max_age > 0,
        ForgeError::AttestationMaxAgeInvalid
    );
    require!(args.fee_bps <= MAX_FEE_BPS, ForgeError::FeeRateOutOfRange);

    let now = Clock::get()?.unix_timestamp;
    let mint_key = ctx.accounts.mint.key();
    let config_key = ctx.accounts.token_config.key();
    let token_program = ctx.accounts.token_program.to_account_info();

    let index_bytes = ctx.accounts.issuer_config.token_count.to_le_bytes();
    let mint_signer: &[&[u8]] = &[
        MINT_SEED,
        ctx.accounts.issuer_config.issuer_id.as_ref(),
        &index_bytes,
        &[ctx.bumps.mint],
    ];
    let config_signer: &[&[u8]] = &[TOKEN_SEED, mint_key.as_ref(), &[ctx.bumps.token_config]];

    // ── mint і його розширення ──────────────────────────────────────────────
    // Порядок жорсткий і заданий токен-програмою: акаунт, потім розширення,
    // потім `initialize_mint2`. Розширення, ініціалізоване після mint, не
    // ініціалізується взагалі.
    let space = ExtensionType::try_calculate_account_len::<MintState>(&MINT_EXTENSIONS)?;
    system_program::create_account(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            CreateAccount {
                from: ctx.accounts.founder.to_account_info(),
                to: ctx.accounts.mint.to_account_info(),
            },
            &[mint_signer],
        ),
        Rent::get()?.minimum_balance(space),
        space as u64,
        &token_program.key(),
    )?;

    let extension_accounts = MetadataPointerInitialize {
        token_program_id: token_program.clone(),
        mint: ctx.accounts.mint.to_account_info(),
    };
    // Вказівник дивиться на сам mint: метадані живуть у тому ж акаунті, який їх
    // описує, тож окремого акаунта, який можна підмінити, не існує.
    metadata_pointer_initialize(
        CpiContext::new(token_program.clone(), extension_accounts),
        Some(config_key),
        Some(mint_key),
    )?;

    transfer_hook_initialize(
        CpiContext::new(
            token_program.clone(),
            TransferHookInitialize {
                token_program_id: token_program.clone(),
                mint: ctx.accounts.mint.to_account_info(),
            },
        ),
        Some(config_key),
        Some(crate::ID),
    )?;

    default_account_state_initialize(
        CpiContext::new(
            token_program.clone(),
            DefaultAccountStateInitialize {
                token_program_id: token_program.clone(),
                mint: ctx.accounts.mint.to_account_info(),
            },
        ),
        &AccountState::Frozen,
    )?;

    permanent_delegate_initialize(
        CpiContext::new(
            token_program.clone(),
            PermanentDelegateInitialize {
                token_program_id: token_program.clone(),
                mint: ctx.accounts.mint.to_account_info(),
            },
        ),
        &config_key,
    )?;

    // Для `Pausable` в anchor-spl 0.32.1 обгортки немає — інструкція будується
    // напряму. Підпису вона не потребує: `initialize` лише записує, хто зможе
    // ставити паузу далі.
    let pausable = spl_token_2022::extension::pausable::instruction::initialize(
        &token_program.key(),
        &mint_key,
        &config_key,
    )?;
    anchor_lang::solana_program::program::invoke(
        &pausable,
        &[ctx.accounts.mint.to_account_info(), token_program.clone()],
    )?;

    // Обидва повноваження — PDA `TokenConfig`. Жодна людина не тримає ключа,
    // яким можна надрукувати чи заморозити: усе, що з ними робиться, проходить
    // через інструкції цієї програми з їхніми перевірками.
    initialize_mint2(
        CpiContext::new(
            token_program.clone(),
            InitializeMint2 {
                mint: ctx.accounts.mint.to_account_info(),
            },
        ),
        args.decimals,
        &config_key,
        Some(&config_key),
    )?;

    // ── конфігурація токена ─────────────────────────────────────────────────
    let config = &mut ctx.accounts.token_config;
    config.issuer = ctx.accounts.issuer_config.key();
    config.mint = mint_key;
    config.attestation_credential = args.attestation_credential;
    config.attestation_schema = args.attestation_schema;
    config.attestor = ctx.accounts.attestor.key();
    config.treasury = args.treasury;
    config.policy_version = FIRST_POLICY_VERSION;
    config.fee_bps = args.fee_bps;
    config.attestation_max_age = args.attestation_max_age;
    config.paused_at = 0;
    config.bump = ctx.bumps.token_config;
    config.attestation_count = 1;
    config.reserve_currency = args.reserve_currency;

    {
        let mut policy = ctx.accounts.policy_config.load_init()?;
        policy.write(
            FIRST_POLICY_VERSION,
            mint_key,
            ctx.accounts.founder.key(),
            &args.rules,
            now,
            ctx.bumps.policy_config,
        )?;
    }

    // ── перша атестація й гейт емісії ───────────────────────────────────────
    require!(
        args.reserve_attested_at <= now,
        ForgeError::AttestationInTheFuture
    );
    let attestation = &mut ctx.accounts.attestation;
    attestation.mint = mint_key;
    attestation.index = 0;
    attestation.amount = args.reserve_amount;
    attestation.currency = args.reserve_currency;
    attestation.attestor = ctx.accounts.attestor.key();
    attestation.attested_at = args.reserve_attested_at;
    attestation.bump = ctx.bumps.attestation;

    // Обидві перевірки — ті самі функції, що й у `mint` (T038). Тут вони
    // виглядають надлишковими (атестація щойно створена, обіг завідомо нуль), і
    // саме тому стоять: шлях появи токенів мусить бути один, інакше «той самий»
    // гейт колись розійдеться на два.
    require_latest(&ctx.accounts.token_config, &ctx.accounts.attestation)?;
    let supply = {
        let data = ctx.accounts.mint.try_borrow_data()?;
        StateWithExtensions::<MintState>::unpack(&data)?.base.supply
    };
    ReserveCheck {
        attested: args.reserve_amount,
        attested_at: args.reserve_attested_at,
        max_age: args.attestation_max_age,
        supply,
        minting: args.initial_supply,
        now,
    }
    .require_within_reserve()?;

    // ── рахунок засновника й початкова емісія ───────────────────────────────
    // **Емісія йде на власний рахунок емітента, і це не спрощення.** `mint_to`
    // хука не кличе: токени, надруковані просто на адресу, названу засновником,
    // потрапили б туди без жодної перевірки правил. Тому початковий випуск
    // лягає на гаманець, який щойно підписав транзакцію, а будь-який рух далі —
    // це переказ, і його перевіряє хук.
    associated_token::create(CpiContext::new(
        ctx.accounts.associated_token_program.to_account_info(),
        associated_token::Create {
            payer: ctx.accounts.founder.to_account_info(),
            associated_token: ctx.accounts.founder_token_account.to_account_info(),
            authority: ctx.accounts.founder.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            token_program: token_program.clone(),
        },
    ))?;

    // Ті самі два акаунти, що заводить `thaw_holder`, і записуються вони через
    // ті самі єдині точки запису. Розморожування дублюється тут не за
    // зручністю: `DefaultAccountState = Frozen` уже діє, а `mint_to` на
    // заморожений рахунок токен-програма відхиляє.
    let status = &mut ctx.accounts.holder_status;
    status.mint = mint_key;
    status.wallet = ctx.accounts.founder.key();
    status.bump = ctx.bumps.holder_status;
    status.apply(&args.founder_status, now)?;

    let counter = &mut ctx.accounts.velocity_counter;
    counter.mint = mint_key;
    counter.wallet = ctx.accounts.founder.key();
    counter.bump = ctx.bumps.velocity_counter;

    thaw_account(CpiContext::new_with_signer(
        token_program.clone(),
        ThawAccount {
            account: ctx.accounts.founder_token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            authority: ctx.accounts.token_config.to_account_info(),
        },
        &[config_signer],
    ))?;

    mint_to(
        CpiContext::new_with_signer(
            token_program,
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.founder_token_account.to_account_info(),
                authority: ctx.accounts.token_config.to_account_info(),
            },
            &[config_signer],
        ),
        args.initial_supply,
    )?;

    // Остання дія: номер зайнятий тільки тоді, коли токен за ним справді
    // створений.
    ctx.accounts.issuer_config.token_count = ctx
        .accounts
        .issuer_config
        .token_count
        .checked_add(1)
        .ok_or(ForgeError::TooManyMembers)?;

    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SetTokenMetadataArgs {
    pub name: String,
    pub symbol: String,
    pub uri: String,
}

/// Запис метаданих у сам mint (FR-001).
///
/// Друга транзакція випуску. Розділення чисто бюджетне — див. заголовок файла, —
/// але воно дало й приємний наслідок: платник тут знову окремий від того, хто
/// санкціонує, як у `initialize_issuer`.
///
/// Повторний виклик відхиляє токен-програма: TLV-запис метаданих уже
/// існуватиме. Зміна назви — це `token_metadata_update_field` і окрема дія
/// емітента, якої в M1 немає.
#[derive(Accounts)]
pub struct SetTokenMetadata<'info> {
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

    /// CHECK: mint звірений із `TokenConfig`; вміст читає й пише токен-програма.
    #[account(
        mut,
        constraint = mint.key() == token_config.mint @ ForgeError::HolderAccountMismatch,
    )]
    pub mint: UncheckedAccount<'info>,

    /// Хто доплачує оренду за виріслий mint. Повноважень не дає.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Адміністратор складу емітента.
    pub authority: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn set_metadata_handler(
    ctx: Context<SetTokenMetadata>,
    args: SetTokenMetadataArgs,
) -> Result<()> {
    require!(
        ctx.accounts
            .issuer_config
            .member_has(&ctx.accounts.authority.key(), role::ADMIN),
        ForgeError::NotAnAdmin
    );
    require!(
        args.name.len() <= MAX_NAME_LEN
            && args.symbol.len() <= MAX_SYMBOL_LEN
            && args.uri.len() <= MAX_URI_LEN,
        ForgeError::TokenMetadataTooLong
    );

    let mint_key = ctx.accounts.mint.key();
    let token_program = ctx.accounts.token_program.to_account_info();

    // Токен-програма реалокує mint сама, але оренди не додає — вона очікує, що
    // лампорти вже на місці. Дорахувати їх мусимо ми, і саме тому рядки мають
    // стелю: інакше розмір реалоку задавав би той, хто кличе.
    let metadata = TokenMetadata {
        name: args.name.clone(),
        symbol: args.symbol.clone(),
        uri: args.uri.clone(),
        mint: mint_key,
        ..Default::default()
    };
    let grown = ctx
        .accounts
        .mint
        .data_len()
        .saturating_add(metadata.tlv_size_of()?);
    let required = Rent::get()?.minimum_balance(grown);
    let shortfall = required.saturating_sub(ctx.accounts.mint.lamports());
    if shortfall > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.mint.to_account_info(),
                },
            ),
            shortfall,
        )?;
    }

    // Право змінювати метадані далі лишається за PDA, а не за людиною: інакше
    // «незмінні параметри», які майстер показує при випуску (FR-005), змінював
    // би один ключ поза будь-якою перевіркою.
    let config_signer: &[&[u8]] = &[TOKEN_SEED, mint_key.as_ref(), &[ctx.accounts.token_config.bump]];
    token_metadata_initialize(
        CpiContext::new_with_signer(
            token_program.clone(),
            TokenMetadataInitialize {
                program_id: token_program.clone(),
                metadata: ctx.accounts.mint.to_account_info(),
                update_authority: ctx.accounts.token_config.to_account_info(),
                mint_authority: ctx.accounts.token_config.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
            },
            &[config_signer],
        ),
        args.name,
        args.symbol,
        args.uri,
    )?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::program_pack::Pack;

    /// Розширення mint є контрактом із хуком: без `TransferHook` правило не
    /// виконується, без `DefaultAccountState` не має сенсу `thaw_holder`, без
    /// `MetadataPointer` друга транзакція не має куди писати. Перелік
    /// перевіряється числом, щоб «прибрати одне заодно» падало тестом.
    #[test]
    fn the_mint_carries_every_extension_the_product_depends_on() {
        assert!(MINT_EXTENSIONS.contains(&ExtensionType::TransferHook));
        assert!(MINT_EXTENSIONS.contains(&ExtensionType::DefaultAccountState));
        assert!(MINT_EXTENSIONS.contains(&ExtensionType::PermanentDelegate));
        assert!(MINT_EXTENSIONS.contains(&ExtensionType::Pausable));
        assert!(MINT_EXTENSIONS.contains(&ExtensionType::MetadataPointer));
        assert_eq!(MINT_EXTENSIONS.len(), 5);
    }

    /// Рахунок, створений для такого mint, мусить нести супутні розширення
    /// (`TransferHookAccount`, `PausableAccount`) — інакше переказ відхилить
    /// токен-програма ще до хука. Створює його ATA-програма, і вона виводить
    /// перелік із самого mint; тест доводить, що виводити є що.
    #[test]
    fn the_extensions_require_their_account_side_counterparts() {
        let required = ExtensionType::get_required_init_account_extensions(&MINT_EXTENSIONS);
        assert!(required.contains(&ExtensionType::TransferHookAccount));
        assert!(required.contains(&ExtensionType::PausableAccount));
    }

    /// Розмір mint рахується з переліку, а не константою: додане розширення не
    /// має тихо не вміститись.
    #[test]
    fn the_mint_account_is_larger_than_a_plain_one() {
        let space = ExtensionType::try_calculate_account_len::<MintState>(&MINT_EXTENSIONS)
            .expect("length is computable");
        assert!(space > MintState::LEN);
    }

    /// Стелі рядків існують не заради охайності, а тому, що за реалок mint
    /// платить той, хто кличе інструкцію.
    #[test]
    fn metadata_limits_bound_the_rent_a_single_call_can_demand() {
        let metadata = TokenMetadata {
            name: "x".repeat(MAX_NAME_LEN),
            symbol: "x".repeat(MAX_SYMBOL_LEN),
            uri: "x".repeat(MAX_URI_LEN),
            ..Default::default()
        };
        let size = metadata.tlv_size_of().expect("size is computable");
        // Півкілобайта — верхня межа того, на скільки виросте mint. Число
        // навмисно грубе: воно стереже порядок величини, а не байти.
        assert!(size < 512, "metadata grows the mint by {size} bytes");
    }
}
