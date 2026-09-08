use anchor_lang::prelude::*;

use crate::error::ForgeError;

/// Скільки байтів відведено на позначення валюти резерву.
///
/// Три — це ISO 4217 alpha-3; решта є, бо резерв законно тримають і в тому, що
/// трибуквеного коду не має. Дзеркалиться в `attestationEventSchema`
/// (`packages/shared/src/events`), де те саме поле оголошене як 3…8 символів.
pub const CURRENCY_BYTES: usize = 8;

/// Атестація резерву. PDA: `["reserve", mint, index]`, індекс — `u64` LE.
///
/// **Append-only, і це властивість адреси, а не перевірки** (FR-026): кожен
/// індекс — власний PDA, створений через `init`, тож переписати запис нічим.
/// Інструкції, яка б відкрила попередню атестацію на запис, у програмі немає, і
/// заміна атестатора (FR-024a) історії не чіпає — вона змінює те, хто підпише
/// **наступну**.
///
/// **`expires_at` тут немає, попри `docs/PLAN.md`.** Строк придатності задається
/// при випуску й змінюється кворумом (FR-023b), тобто живе в
/// `TokenConfig.attestation_max_age`. Знімок цього строку в кожному записі був би
/// другою відповіддю на питання «чи протермінована атестація», і при зміні
/// строку дві відповіді розійшлися б. Публічна сторінка рахує
/// `attested_at + max_age` — так само, як програма.
#[account]
#[derive(InitSpace)]
pub struct ReserveAttestation {
    pub mint: Pubkey,
    /// Позиція в послідовності. Індекс і є історія: він адресує «попередню
    /// атестацію», а не змушує шукати її перебором.
    pub index: u64,
    /// Підтверджена сума в найменшій одиниці **валюти резерву** — вона ж
    /// найменша одиниця токена, бо `currency` мусить збігтися з валютою токена
    /// (`TokenConfig.reserve_currency`). Без цієї рівності порівняння «емісія +
    /// обіг ≤ атестованого» вимагало б курсу, якого в програмі немає й не буде.
    pub amount: u64,
    pub currency: [u8; CURRENCY_BYTES],
    /// Хто підписав. Лишається в записі назавжди: після заміни атестатора
    /// (FR-024a) видно, хто підтверджував резерв тоді.
    pub attestor: Pubkey,
    pub attested_at: i64,
    pub bump: u8,
}

/// Валюта в канонічній формі: 3…8 великих латинських літер, далі нулі.
///
/// Порівнюється байт у байт із `TokenConfig.reserve_currency`, тож «ngn» і «NGN»
/// мусять бути одним значенням, а не двома.
pub fn validate_currency(currency: &[u8; CURRENCY_BYTES]) -> Result<()> {
    let length = currency
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(CURRENCY_BYTES);
    require!(length >= 3, ForgeError::ReserveCurrencyInvalid);
    require!(
        currency[..length].iter().all(u8::is_ascii_uppercase),
        ForgeError::ReserveCurrencyInvalid
    );
    // Хвіст мусить бути нульовий цілком: інакше «NGN\0X» і «NGN» читалися б як
    // різні значення, які людина назве однаково.
    require!(
        currency[length..].iter().all(|byte| *byte == 0),
        ForgeError::ReserveCurrencyInvalid
    );
    Ok(())
}

/// Валюта як байти, без нульових літералів у джерелі.
///
/// Літерал `*b"NGN\0\0\0\0\0"` виглядає коротшим, але кладе в текст програми справжні
/// NUL-байти: файл перестає бути текстовим для `grep`, `diff` і для очей.
pub const fn currency_bytes(code: &[u8]) -> [u8; CURRENCY_BYTES] {
    let mut bytes = [0u8; CURRENCY_BYTES];
    let mut index = 0;
    while index < code.len() && index < CURRENCY_BYTES {
        bytes[index] = code[index];
        index += 1;
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn currency(text: &str) -> [u8; CURRENCY_BYTES] {
        currency_bytes(text.as_bytes())
    }

    fn err(result: Result<()>) -> u32 {
        match result.expect_err("expected a failure") {
            anchor_lang::error::Error::AnchorError(e) => e.error_code_number,
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn accepts_an_iso_code_and_a_longer_ticker() {
        assert!(validate_currency(&currency("NGN")).is_ok());
        assert!(validate_currency(&currency("USDCOINX")).is_ok());
    }

    #[test]
    fn refuses_lower_case_and_anything_shorter_than_three() {
        for text in ["ngn", "NG", "N", ""] {
            assert_eq!(
                err(validate_currency(&currency(text))),
                u32::from(ForgeError::ReserveCurrencyInvalid)
            );
        }
    }

    #[test]
    fn refuses_a_tail_that_is_not_zero() {
        // Інакше два байтові значення читалися б людиною як одне слово.
        let mut holed = currency("NGN");
        holed[5] = b'X';
        assert_eq!(
            err(validate_currency(&holed)),
            u32::from(ForgeError::ReserveCurrencyInvalid)
        );
    }
}
