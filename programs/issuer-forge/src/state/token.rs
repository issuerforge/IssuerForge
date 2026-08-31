use anchor_lang::prelude::*;

/// Конфігурація випущеного токена. PDA: `["token", mint]`.
///
/// **Порядок полів тут — частина протоколу, а не стиль.** Хук отримує акаунт
/// атестації провайдера через `ExtraAccountMetaList`, а її адреса виводиться з
/// seeds `["attestation", credential, schema, nonce]` (спайк T057). Два
/// 32-байтові літерали в 32-байтовий `address_config` не вміщаються ніколи, тож
/// `credential` і `schema` беруться **зрізами даних цього акаунта** — а зсув у
/// seed `AccountData` має розмір рівно одного байта.
///
/// Звідси два обмеження, які тепер є вимогами до розкладки:
/// - обидва поля мусять лежати в перших 256 байтах акаунта;
/// - їхні зсуви зашиті в `address_config` уже створених `ExtraAccountMetaList`,
///   тож вставка нового поля **перед ними** мовчки перенаправить хук на чужі
///   32 байти. Тест `token_config_offsets_are_pinned` існує саме проти цього.
#[account]
#[derive(InitSpace)]
pub struct TokenConfig {
    pub issuer: Pubkey,
    pub mint: Pubkey,
    /// SAS-credential провайдера верифікації, атестації якого приймає цей токен.
    pub attestation_credential: Pubkey,
    /// SAS-schema тих атестацій.
    pub attestation_schema: Pubkey,
    /// Чинний атестатор резерву **цього токена** (FR-024b).
    ///
    /// Живе тут, а не в `IssuerConfig`, попри `docs/PLAN.md`: FR-024b перевіряє
    /// підпис проти атестатора конкретного токена, і емітент із двома токенами
    /// законно має для них різних атестаторів.
    pub attestor: Pubkey,
    /// Скарбниця платформи: сюди йде комісія з емісії й погашення (FR-038).
    pub treasury: Pubkey,
    /// Версія політики, на яку налаштований mint. Розбіжність — перша перевірка
    /// хука й перший код відмови.
    pub policy_version: u32,
    /// Оголошена ставка комісії (FR-038a).
    pub fee_bps: u16,
    /// Строк придатності атестації, секунди (FR-023b).
    pub attestation_max_age: i64,
    /// Дзеркало стану паузи для журналу й екранів; `0` — не на паузі.
    /// Авторитетним лишається розширення `Pausable` на самому mint (FR-016).
    pub paused_at: i64,
    pub bump: u8,
}

/// Зсув `attestation_credential` від початку акаунта, з дискримінатором Anchor.
///
/// `u8` навмисно: тип збігається з полем `data_index` у seed `AccountData`, тож
/// поле, яке не влізе в перші 256 байтів, не скомпілюється, а не зламається на
/// девнеті.
pub const TOKEN_CONFIG_CREDENTIAL_OFFSET: u8 = 8 + 32 + 32;

/// Зсув `attestation_schema`.
pub const TOKEN_CONFIG_SCHEMA_OFFSET: u8 = TOKEN_CONFIG_CREDENTIAL_OFFSET + 32;

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::AccountSerialize;

    fn sample() -> TokenConfig {
        TokenConfig {
            issuer: Pubkey::new_from_array([1u8; 32]),
            mint: Pubkey::new_from_array([2u8; 32]),
            attestation_credential: Pubkey::new_from_array([3u8; 32]),
            attestation_schema: Pubkey::new_from_array([4u8; 32]),
            attestor: Pubkey::new_from_array([5u8; 32]),
            treasury: Pubkey::new_from_array([6u8; 32]),
            policy_version: 7,
            fee_bps: 12,
            attestation_max_age: 86_400,
            paused_at: 0,
            bump: 254,
        }
    }

    fn serialised() -> Vec<u8> {
        let mut buffer = Vec::new();
        sample().try_serialize(&mut buffer).expect("serialises");
        buffer
    }

    /// Зсуви зашиті в `address_config` кожного вже створеного
    /// `ExtraAccountMetaList`. Зміна розкладки не ламає збірку й не падає в
    /// тестах хука — вона просто починає читати чужі 32 байти як credential.
    #[test]
    fn token_config_offsets_are_pinned() {
        let data = serialised();
        let credential = TOKEN_CONFIG_CREDENTIAL_OFFSET as usize;
        let schema = TOKEN_CONFIG_SCHEMA_OFFSET as usize;

        assert_eq!(&data[credential..credential + 32], &[3u8; 32]);
        assert_eq!(&data[schema..schema + 32], &[4u8; 32]);
    }

    /// Зсув у seed `AccountData` — один байт. Поле за межею 256 байтів
    /// виражається в seeds не більше, ніж літералом, тобто ніяк.
    #[test]
    fn seed_addressable_fields_stay_in_the_first_256_bytes() {
        assert!(TOKEN_CONFIG_SCHEMA_OFFSET as usize + 32 <= 256);
    }

    #[test]
    fn declared_space_covers_the_serialised_account() {
        assert_eq!(serialised().len(), 8 + TokenConfig::INIT_SPACE);
    }
}
