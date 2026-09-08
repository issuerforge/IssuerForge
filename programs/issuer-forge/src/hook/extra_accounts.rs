//! `ExtraAccountMetaList` — перелік акаунтів, які токен-програма мусить
//! підкласти хуку на кожному переказі.
//!
//! Це і є те, що робить FR-012 можливим: перелік лежить ончейн, і токен-програма
//! резолвить його **сама**, хто б не ініціював переказ — гаманець, чужа програма
//! через CPI чи делегат. Клієнт нічого не «додає»: він може лише не додати, і
//! тоді переказ не відбудеться.
//!
//! **Розкладка seeds — результат спайка T057**, і кожен її рядок є обмеженням, а
//! не вибором:
//! - `credential` і `schema` беруться **зрізами даних `TokenConfig`**: два
//!   32-байтові літерали дають 68 байтів і в 32-байтовий `address_config` не
//!   вміщаються ніколи;
//! - версія політики теж береться зрізом даних, а не числом від клієнта —
//!   інакше переказ можна було б провести проти старої версії;
//! - гаманець сторони береться зрізом поля `owner` її токен-акаунта;
//! - програма SAS стоїть окремим акаунтом, бо зовнішній PDA задається
//!   дискримінатором «128 + індекс акаунта програми».
use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, CreateAccount};
use anchor_spl::token_interface::Mint;
use spl_tlv_account_resolution::account::ExtraAccountMeta;
use spl_tlv_account_resolution::seeds::Seed;
use spl_tlv_account_resolution::state::ExtraAccountMetaList;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

use crate::constants::{HOLDER_SEED, POLICY_SEED, TOKEN_SEED, VELOCITY_SEED};
use crate::hook::attestation::SAS_PROGRAM_ID;
use crate::state::{
    TokenConfig, TOKEN_CONFIG_CREDENTIAL_OFFSET, TOKEN_CONFIG_POLICY_VERSION_OFFSET,
    TOKEN_CONFIG_SCHEMA_OFFSET,
};

/// Індекси акаунтів, які токен-програма передає хуку завжди.
///
/// Порядок задає інтерфейс `spl-transfer-hook-interface`, не ми; числа стоять
/// тут іменами, бо вони ж є `account_index` у кожному seed нижче, і безіменна
/// двійка серед них читалась би як що завгодно.
const SOURCE_TOKEN: u8 = 0;
const MINT: u8 = 1;
const DESTINATION_TOKEN: u8 = 2;

/// Індекси наших акаунтів у тому ж списку. Порядок мусить збігатися з полями
/// `Execute` — інакше хук читатиме не те, що резолвила токен-програма.
const TOKEN_CONFIG: u8 = 5;
const SAS_PROGRAM: u8 = 10;

/// Зсув поля `owner` у токен-акаунті SPL: `mint` займає перші 32 байти.
const TOKEN_ACCOUNT_OWNER_OFFSET: u8 = 32;

/// Скільки акаунтів ми додаємо понад ті, що передає токен-програма.
pub const EXTRA_ACCOUNT_COUNT: usize = 8;

fn wallet_seed(token_account_index: u8) -> Seed {
    Seed::AccountData {
        account_index: token_account_index,
        data_index: TOKEN_ACCOUNT_OWNER_OFFSET,
        length: 32,
    }
}

fn token_config_slice(offset: u8, length: u8) -> Seed {
    Seed::AccountData {
        account_index: TOKEN_CONFIG,
        data_index: offset,
        length,
    }
}

fn holder_meta(token_account_index: u8, seed: &[u8], writable: bool) -> Result<ExtraAccountMeta> {
    Ok(ExtraAccountMeta::new_with_seeds(
        &[
            Seed::Literal { bytes: seed.to_vec() },
            Seed::AccountKey { index: MINT },
            wallet_seed(token_account_index),
        ],
        false,
        writable,
    )?)
}

/// Перелік у тому самому порядку, у якому його читає `Execute`.
pub fn extra_account_metas() -> Result<Vec<ExtraAccountMeta>> {
    Ok(vec![
        // 5: TokenConfig — з нього беруться credential, schema й версія політики.
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: TOKEN_SEED.to_vec(),
                },
                Seed::AccountKey { index: MINT },
            ],
            false,
            false,
        )?,
        // 6: чинна версія політики. Номер береться з даних TokenConfig, тож
        // підсунути стару версію неможливо — її адреса просто не зійдеться.
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: POLICY_SEED.to_vec(),
                },
                Seed::AccountKey { index: MINT },
                token_config_slice(TOKEN_CONFIG_POLICY_VERSION_OFFSET, 4),
            ],
            false,
            false,
        )?,
        // 7, 8: статус відправника й лічильник його вікна. Лічильник — єдиний
        // акаунт, який хук пише.
        holder_meta(SOURCE_TOKEN, HOLDER_SEED, false)?,
        holder_meta(SOURCE_TOKEN, VELOCITY_SEED, true)?,
        // 9: статус отримувача. Лічильник отримувача не потрібен: ліміт за
        // період обмежує того, хто відправляє.
        holder_meta(DESTINATION_TOKEN, HOLDER_SEED, false)?,
        // 10: сама програма SAS — вона мусить бути акаунтом у списку, щоб на неї
        // могли послатися зовнішні PDA нижче.
        ExtraAccountMeta::new_with_pubkey(&SAS_PROGRAM_ID, false, false)?,
        // 11, 12: атестації сторін. Обидві присутні **завжди**, незалежно від
        // того, чи приймає політика джерело `provider`: заборона діє з
        // будь-якого джерела (FR-008a1), тож не подивитись у нього не можна.
        ExtraAccountMeta::new_external_pda_with_seeds(
            SAS_PROGRAM,
            &attestation_seeds(SOURCE_TOKEN),
            false,
            false,
        )?,
        ExtraAccountMeta::new_external_pda_with_seeds(
            SAS_PROGRAM,
            &attestation_seeds(DESTINATION_TOKEN),
            false,
            false,
        )?,
    ])
}

fn attestation_seeds(token_account_index: u8) -> [Seed; 4] {
    [
        Seed::Literal {
            bytes: b"attestation".to_vec(),
        },
        token_config_slice(TOKEN_CONFIG_CREDENTIAL_OFFSET, 32),
        token_config_slice(TOKEN_CONFIG_SCHEMA_OFFSET, 32),
        wallet_seed(token_account_index),
    ]
}

/// Створення переліку для щойно випущеного токена.
///
/// Окремою інструкцією, а не всередині `create_token`: перелік належить
/// **інтерфейсу хука**, а не випуску, і оновлювати його доведеться незалежно від
/// mint (наприклад, коли з'явиться новий вид джерела статусу). Клієнт кладе
/// обидві інструкції в одну транзакцію (T020).
#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: адресу задають seeds, вміст пише ця інструкція. Типізувати нічим —
    /// це TLV-буфер `spl-tlv-account-resolution`, а не акаунт Anchor.
    #[account(
        mut,
        seeds = [b"extra-account-metas", token_config.mint.as_ref()],
        bump,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    #[account(
        seeds = [TOKEN_SEED, token_config.mint.as_ref()],
        bump = token_config.bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    #[account(constraint = mint.key() == token_config.mint)]
    pub mint: InterfaceAccount<'info, Mint>,

    pub system_program: Program<'info, System>,
}

pub(crate) fn handler(ctx: Context<InitializeExtraAccountMetaList>) -> Result<()> {
    let metas = extra_account_metas()?;
    let size = ExtraAccountMetaList::size_of(metas.len())?;
    let lamports = Rent::get()?.minimum_balance(size);

    let mint = ctx.accounts.token_config.mint;
    let bump = ctx.bumps.extra_account_meta_list;
    let signer: &[&[u8]] = &[b"extra-account-metas", mint.as_ref(), &[bump]];

    system_program::create_account(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            CreateAccount {
                from: ctx.accounts.payer.to_account_info(),
                to: ctx.accounts.extra_account_meta_list.to_account_info(),
            },
            &[signer],
        ),
        lamports,
        size as u64,
        &crate::ID,
    )?;

    let mut data = ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?;
    ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &metas)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Кожен `address_config` — рівно 32 байти, і жодна конфігурація в них не
    /// «майже» вміщається: та, що не вмістилась, не створюється взагалі.
    #[test]
    fn every_configuration_fits_the_address_config() {
        let metas = extra_account_metas().expect("builds");
        assert_eq!(metas.len(), EXTRA_ACCOUNT_COUNT);
    }

    /// Атестація — найтісніша конфігурація: 13 + 4 + 4 + 4 = 25 із 32 (T057).
    /// Наївний варіант із двома літералами дає 68 і не вміщається ніколи.
    #[test]
    fn the_attestation_seeds_stay_inside_the_budget() {
        let seeds = attestation_seeds(SOURCE_TOKEN);
        let packed: usize = seeds.iter().map(|seed| usize::from(seed.tlv_size())).sum();
        assert_eq!(packed, 25);
        assert!(packed <= 32);
    }

    /// Лічильник відправника — єдиний акаунт, який хук пише. Зайвий writable у
    /// списку означав би, що переказ блокує акаунт, якого не змінює.
    #[test]
    fn only_the_senders_counter_is_writable() {
        let metas = extra_account_metas().expect("builds");
        let writable: Vec<usize> = metas
            .iter()
            .enumerate()
            .filter(|(_, meta)| bool::from(meta.is_writable))
            .map(|(index, _)| index)
            .collect();
        assert_eq!(writable, vec![3]);
    }

    #[test]
    fn nothing_in_the_list_signs() {
        let metas = extra_account_metas().expect("builds");
        assert!(metas.iter().all(|meta| !bool::from(meta.is_signer)));
    }
}
