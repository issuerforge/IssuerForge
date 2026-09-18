use anchor_lang::prelude::*;

use crate::error::ForgeError;

/// How many bytes are reserved for the reserve currency code.
///
/// Three is ISO 4217 alpha-3; the rest exist because a reserve is
/// legitimately held in things that have no three-letter code too. Mirrored
/// in `attestationEventSchema` (`packages/shared/src/events`), where the same
/// field is declared as 3…8 characters.
pub const CURRENCY_BYTES: usize = 8;

/// A reserve attestation. PDA: `["reserve", mint, index]`, the index a `u64`
/// LE.
///
/// **Append-only, and that is a property of the address, not of a check**
/// (FR-026): every index is its own PDA created through `init`, so there is
/// nothing to overwrite a record with. The program has no instruction that
/// would open a previous attestation for writing, and replacing the attestor
/// (FR-024a) does not touch history — it changes who signs the **next**
/// one.
///
/// **There is no `expires_at` here, despite `docs/PLAN.md`.** The validity
/// period is set at issuance and changed by quorum (FR-023b), i.e. it lives
/// in `TokenConfig.attestation_max_age`. A snapshot of that period in every
/// record would be a second answer to "is the attestation expired", and on a
/// change of the period the two answers would diverge. The public page
/// computes `attested_at + max_age` — the same way the program does.
#[account]
#[derive(InitSpace)]
pub struct ReserveAttestation {
    pub mint: Pubkey,
    /// The position in the sequence. The index is the history: it addresses
    /// "the previous attestation" rather than forcing a search for it.
    pub index: u64,
    /// The attested amount in the smallest unit of the **reserve currency** —
    /// which is also the token's smallest unit, because `currency` must match
    /// the token's currency (`TokenConfig.reserve_currency`). Without that
    /// equality the comparison "issuance + circulation ≤ attested" would
    /// require an exchange rate, which the program does not have and never
    /// will.
    pub amount: u64,
    pub currency: [u8; CURRENCY_BYTES],
    /// Who signed. Stays in the record forever: after the attestor is replaced
    /// (FR-024a) it is visible who attested the reserve back then.
    pub attestor: Pubkey,
    pub attested_at: i64,
    pub bump: u8,
}

/// The currency in canonical form: 3…8 upper-case Latin letters, then zeros.
///
/// Compared byte for byte with `TokenConfig.reserve_currency`, so "ngn" and
/// "NGN" must be one value, not two.
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
    // The tail must be entirely zero: otherwise "NGN\0X" and "NGN" would read
    // as different values a person would call the same.
    require!(
        currency[length..].iter().all(|byte| *byte == 0),
        ForgeError::ReserveCurrencyInvalid
    );
    Ok(())
}

/// The currency as bytes, with no NUL literals in the source.
///
/// The literal `*b"NGN\0\0\0\0\0"` looks shorter, but puts real NUL bytes into
/// the program text: the file stops being text for `grep`, `diff` and the
/// eye.
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
        // Otherwise two byte values would be read by a person as one word.
        let mut holed = currency("NGN");
        holed[5] = b'X';
        assert_eq!(
            err(validate_currency(&holed)),
            u32::from(ForgeError::ReserveCurrencyInvalid)
        );
    }
}
