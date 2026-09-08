//! Читання атестації провайдера з акаунта SAS.
//!
//! Друге джерело статусу (FR-008a). Перше — власний реєстр емітента, і воно
//! просте: це наш акаунт, наша розкладка. Тут інакше: акаунт належить чужій
//! програмі, а зміст його поля `data` задає **схема**, а не протокол.
//!
//! **Схему задає платформа, і вона фіксована** — дванадцять байтів на початку
//! `data`. Альтернатива (зсуви полів у `TokenConfig`) дала б гнучкість ціною
//! конфігурації, яку кожен емітент може задати неправильно, а виявилось би це
//! випадковим рівнем верифікації в реальному переказі. Провайдер, що видає
//! атестації за іншою схемою, просто не дає дозволу — і це видно як відмова, а
//! не як помилковий дозвіл.
//!
//! **Розкладка самого акаунта `Attestation` — припущення, яке перевіряється в
//! рантаймі.** Зсуви нижче зняті з `program/src/state/attestation.rs` SAS і не
//! звірені з живою мережею (спайк T057 туди не ходив). Тому парсер не довіряє
//! їм: він звіряє `nonce`, `credential` і `schema` з тим, що вже знає, і при
//! будь-якій розбіжності повертає `Unavailable` — тобто **відмову**, а не
//! дозвіл. Помилка в припущенні коштує непрацездатного джерела, а не пропущеного
//! переказу. Звірка з devnet — T024.
use anchor_lang::prelude::*;

use crate::rules::evaluate::{ProviderStatus, SourceState, StatusRecord};

/// Програма Solana Attestation Service.
pub const SAS_PROGRAM_ID: Pubkey = pubkey!("22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG");

/// Дискримінатор акаунта SAS — один байт перед тілом.
const DISCRIMINATOR_LEN: usize = 1;

const NONCE_OFFSET: usize = DISCRIMINATOR_LEN;
const CREDENTIAL_OFFSET: usize = NONCE_OFFSET + 32;
const SCHEMA_OFFSET: usize = CREDENTIAL_OFFSET + 32;
/// `data: Vec<u8>` — довжина `u32`, далі байти.
const DATA_LEN_OFFSET: usize = SCHEMA_OFFSET + 32;
const DATA_OFFSET: usize = DATA_LEN_OFFSET + 4;

/// Схема платформи: перші дванадцять байтів `data`.
///
/// `denied` є навмисно, хоч атестацію зазвичай відкликають видаленням акаунта
/// (тоді джерело читається як `Absent`). Байт дозволяє провайдеру сказати «ні»
/// **явно**, не чекаючи, поки хтось закриє акаунт, — і за FR-008a1 таке «ні»
/// перекриває дозвіл із реєстру емітента.
const SCHEMA_TIER: usize = 0;
const SCHEMA_JURISDICTION: usize = 1;
const SCHEMA_DENIED: usize = 3;
const SCHEMA_ISSUED_AT: usize = 4;
/// Скільки байтів схема вимагає від `data`. Решта ігнорується.
pub const SCHEMA_BYTES: usize = SCHEMA_ISSUED_AT + 8;

fn pubkey_at(data: &[u8], at: usize) -> Option<Pubkey> {
    let bytes: [u8; 32] = data.get(at..at + 32)?.try_into().ok()?;
    Some(Pubkey::new_from_array(bytes))
}

fn i64_at(data: &[u8], at: usize) -> Option<i64> {
    let bytes: [u8; 8] = data.get(at..at + 8)?.try_into().ok()?;
    Some(i64::from_le_bytes(bytes))
}

fn u32_at(data: &[u8], at: usize) -> Option<u32> {
    let bytes: [u8; 4] = data.get(at..at + 4)?.try_into().ok()?;
    Some(u32::from_le_bytes(bytes))
}

/// Атестація як джерело статусу для однієї сторони переказу.
///
/// Три стани, і різниця між двома останніми — це різниця між двома кодами
/// відмови:
/// - `Absent` — акаунта немає. Провайдер цю адресу не атестував; це нормальний
///   стан, і рішення далі ухвалює правило статусу.
/// - `Unavailable` — акаунт є, але прочитати його як атестацію **цієї** адреси
///   не вдалося: чужий власник, коротке тіло, не ті ключі всередині.
///   Недоступність джерела не послаблює політику (FR-013).
///
/// Адреса акаунта тут **не виводиться заново**, і це не економія на перевірці.
/// `nonce`, `credential` і `schema` — це рівно ті seeds, з яких SAS вивела PDA,
/// і вона ж їх туди записала. Акаунт, що належить SAS і має всередині ці три
/// значення, лежить за тією адресою за побудовою. Порівняння трьох ключів
/// доводить те саме, що `create_program_address`, і не коштує 1500 CU на
/// кожному переказі (SC-003).
pub fn read(
    account: &AccountInfo,
    credential: &Pubkey,
    schema: &Pubkey,
    wallet: &Pubkey,
) -> SourceState<ProviderStatus> {
    // Порожній акаунт за виведеною адресою означає «атестації немає». Це не
    // недоступність джерела: джерело відповіло, і відповідь — «такої адреси я не
    // атестувала».
    if account.data_is_empty() {
        return SourceState::Absent;
    }
    if account.owner != &SAS_PROGRAM_ID {
        return SourceState::Unavailable;
    }

    let data = account.data.borrow();
    let parsed = parse(&data, credential, schema, wallet);
    parsed.map_or(SourceState::Unavailable, SourceState::Record)
}

fn parse(
    data: &[u8],
    credential: &Pubkey,
    schema: &Pubkey,
    wallet: &Pubkey,
) -> Option<ProviderStatus> {
    // Три ключі мусять збігтися всі: кожен із них — seed адреси, і розбіжність
    // означає або чужий акаунт, або те, що припущення про розкладку хибне.
    if pubkey_at(data, NONCE_OFFSET)? != *wallet
        || pubkey_at(data, CREDENTIAL_OFFSET)? != *credential
        || pubkey_at(data, SCHEMA_OFFSET)? != *schema
    {
        return None;
    }

    let body_len = u32_at(data, DATA_LEN_OFFSET)? as usize;
    let body = data.get(DATA_OFFSET..DATA_OFFSET + body_len)?;
    // Атестація, коротша за схему, — це не «менше даних», а інша схема.
    if body.len() < SCHEMA_BYTES {
        return None;
    }

    // `expiry` лежить **після** `data`, тобто на змінному зсуві: розбір, а не
    // константа. Між ними ще `signer` (спайк T057).
    let expiry = i64_at(data, DATA_OFFSET + body_len + 32)?;

    let jurisdiction: [u8; 2] = body
        .get(SCHEMA_JURISDICTION..SCHEMA_JURISDICTION + 2)?
        .try_into()
        .ok()?;

    Some(ProviderStatus {
        record: StatusRecord {
            denied: body[SCHEMA_DENIED] != 0,
            tier: body[SCHEMA_TIER],
            jurisdiction,
            // Нуль читається як «без строку» — та сама домовленість, що й у
            // реєстрі емітента, і вона одна на обидва джерела.
            expires_at: (expiry != 0).then_some(expiry),
        },
        issued_at: i64_at(body, SCHEMA_ISSUED_AT)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(seed: u8) -> Pubkey {
        Pubkey::new_from_array([seed; 32])
    }

    /// Будує акаунт **за нашим припущенням про розкладку**.
    ///
    /// Тест на такій фікстурі доводить, що парсер самоузгоджений, і **не**
    /// доводить, що припущення правильне: воно перевіряється тільки проти живої
    /// SAS на devnet (T024). Саме тому парсер при розбіжності відмовляє, а не
    /// дозволяє.
    fn account_bytes(
        nonce: Pubkey,
        credential: Pubkey,
        schema: Pubkey,
        body: &[u8],
        expiry: i64,
    ) -> Vec<u8> {
        let mut data = vec![0u8; DATA_OFFSET];
        data[NONCE_OFFSET..NONCE_OFFSET + 32].copy_from_slice(nonce.as_ref());
        data[CREDENTIAL_OFFSET..CREDENTIAL_OFFSET + 32].copy_from_slice(credential.as_ref());
        data[SCHEMA_OFFSET..SCHEMA_OFFSET + 32].copy_from_slice(schema.as_ref());
        data[DATA_LEN_OFFSET..DATA_LEN_OFFSET + 4].copy_from_slice(&(body.len() as u32).to_le_bytes());
        data.extend_from_slice(body);
        data.extend_from_slice(key(200).as_ref()); // signer
        data.extend_from_slice(&expiry.to_le_bytes());
        data.extend_from_slice(key(201).as_ref()); // token_account
        data
    }

    fn body(tier: u8, jurisdiction: &[u8; 2], denied: bool, issued_at: i64) -> Vec<u8> {
        let mut body = vec![0u8; SCHEMA_BYTES];
        body[SCHEMA_TIER] = tier;
        body[SCHEMA_JURISDICTION..SCHEMA_JURISDICTION + 2].copy_from_slice(jurisdiction);
        body[SCHEMA_DENIED] = u8::from(denied);
        body[SCHEMA_ISSUED_AT..SCHEMA_ISSUED_AT + 8].copy_from_slice(&issued_at.to_le_bytes());
        body
    }

    fn good() -> Vec<u8> {
        account_bytes(
            key(1),
            key(2),
            key(3),
            &body(4, b"NG", false, 1_700_000_000),
            1_900_000_000,
        )
    }

    #[test]
    fn reads_the_schema_the_platform_declares() {
        let status = parse(&good(), &key(2), &key(3), &key(1)).expect("parses");
        assert_eq!(status.record.tier, 4);
        assert_eq!(status.record.jurisdiction, *b"NG");
        assert!(!status.record.denied);
        assert_eq!(status.record.expires_at, Some(1_900_000_000));
        assert_eq!(status.issued_at, 1_700_000_000);
    }

    #[test]
    fn reads_a_zero_expiry_as_no_expiry() {
        // Та сама домовленість, що й у реєстрі емітента, і вона одна на обидва
        // джерела.
        let data = account_bytes(key(1), key(2), key(3), &body(1, b"GH", false, 0), 0);
        let status = parse(&data, &key(2), &key(3), &key(1)).expect("parses");
        assert_eq!(status.record.expires_at, None);
    }

    #[test]
    fn refuses_an_attestation_issued_for_another_wallet() {
        assert!(parse(&good(), &key(2), &key(3), &key(9)).is_none());
    }

    #[test]
    fn refuses_another_credential_or_another_schema() {
        // Чужий провайдер і чужа схема — це не «трохи інший статус», це не
        // статус для цього токена взагалі.
        assert!(parse(&good(), &key(9), &key(3), &key(1)).is_none());
        assert!(parse(&good(), &key(2), &key(9), &key(1)).is_none());
    }

    #[test]
    fn refuses_a_body_shorter_than_the_schema() {
        // Атестація, коротша за схему, — це інша схема, а не менше даних.
        let short = account_bytes(key(1), key(2), key(3), &[0u8; 4], 0);
        assert!(parse(&short, &key(2), &key(3), &key(1)).is_none());
    }

    #[test]
    fn refuses_a_truncated_account_instead_of_reading_past_it() {
        let mut cut = good();
        cut.truncate(DATA_OFFSET + SCHEMA_BYTES);
        assert!(parse(&cut, &key(2), &key(3), &key(1)).is_none());
        assert!(parse(&[], &key(2), &key(3), &key(1)).is_none());
    }

    #[test]
    fn carries_a_denial_the_provider_states_explicitly() {
        let data = account_bytes(key(1), key(2), key(3), &body(9, b"NG", true, 1), 0);
        let status = parse(&data, &key(2), &key(3), &key(1)).expect("parses");
        assert!(status.record.denied);
    }

    #[test]
    fn ignores_bytes_the_schema_does_not_claim() {
        // Провайдер може класти в `data` більше, ніж вимагає схема; на нашому
        // прочитанні це не позначається.
        let mut long = body(2, b"KE", false, 5);
        long.extend_from_slice(&[0xAA; 40]);
        let data = account_bytes(key(1), key(2), key(3), &long, 0);
        let status = parse(&data, &key(2), &key(3), &key(1)).expect("parses");
        assert_eq!(status.record.tier, 2);
        assert_eq!(status.issued_at, 5);
    }
}
