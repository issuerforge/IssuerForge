//! Перевірка «емісія + обіг ≤ атестованого резерву» (FR-022, FR-023).
//!
//! **Одна перевірка на всі шляхи появи токенів.** Її проходить початковий випуск
//! у `create_token` (T018) і продовження емісії в `mint` (T038, M3). Дві
//! перевірки означали б, що одна з них колись відстане — а відставання тут
//! називається емісією понад резерв.
//!
//! **Обіг береться з `mint.supply` у момент виконання, а не з аргументів.** Саме
//! це закриває сценарій SC-005 про дві одночасні емісії, кожна з яких окремо
//! вміщується в резерв: друга транзакція бачить supply, який уже виріс від
//! першої, і не проходить. Жодного окремого замка для гонки не потрібно — його
//! роль виконує сам порядок виконання в блоці.
use anchor_lang::prelude::*;

use crate::error::ForgeError;
use crate::state::{ReserveAttestation, TokenConfig};

/// Чи це справді **остання** атестація цього токена.
///
/// Без цієї перевірки старіша атестація з більшою сумою була б дійсним входом —
/// тобто емісією понад резерв, проведеною через акаунт, який ніхто не редагував.
/// Лічильник у `TokenConfig` каже, котра остання; сама сума лишається там, де її
/// читає й верифікатор журналу.
pub fn require_latest(config: &TokenConfig, attestation: &ReserveAttestation) -> Result<()> {
    require_keys_eq!(
        attestation.mint,
        config.mint,
        ForgeError::AttestationNotLatest
    );
    require!(
        attestation.index.checked_add(1) == Some(config.attestation_count),
        ForgeError::AttestationNotLatest
    );
    Ok(())
}

/// Все, що потрібно, щоб відповісти на питання «чи можна випустити цю суму».
pub struct ReserveCheck {
    /// Підтверджена сума з **останньої** атестації.
    pub attested: u64,
    pub attested_at: i64,
    /// Скільки атестація лишається чинною (`TokenConfig.attestation_max_age`).
    pub max_age: i64,
    /// Обіг у момент виконання — `mint.supply`.
    pub supply: u64,
    /// Скільки просять випустити.
    pub minting: u64,
    pub now: i64,
}

impl ReserveCheck {
    /// Дві причини відмови, і вони **різні** (FR-023a): «атестація
    /// протермінована» і «резерву недостатньо» — це різні дії для емітента, тож
    /// і різні коди.
    pub fn require_within_reserve(&self) -> Result<()> {
        // Атестація з майбутнього не «ще чинніша» — це зламаний годинник у
        // атестатора або спроба продовжити строк наперед.
        require!(
            self.attested_at <= self.now,
            ForgeError::AttestationInTheFuture
        );
        require!(
            self.now.saturating_sub(self.attested_at) <= self.max_age,
            ForgeError::ReserveAttestationExpired
        );

        // Насичення замість переповнення: сума, що не влазить у u64, безумовно
        // більша за будь-який резерв, і паніка тут була б відмовою без причини.
        let after = self.supply.saturating_add(self.minting);
        require!(after <= self.attested, ForgeError::ReserveInsufficient);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::state::currency_bytes;

    const NOW: i64 = 1_800_000_000;
    const DAY: i64 = 86_400;
    const NGN_CURRENCY: [u8; crate::state::CURRENCY_BYTES] = currency_bytes(b"NGN");

    fn check() -> ReserveCheck {
        ReserveCheck {
            attested: 1_000,
            attested_at: NOW - DAY,
            max_age: 7 * DAY,
            supply: 0,
            minting: 1_000,
            now: NOW,
        }
    }

    fn err(result: Result<()>) -> u32 {
        match result.expect_err("expected a failure") {
            anchor_lang::error::Error::AnchorError(e) => e.error_code_number,
            other => panic!("unexpected error: {other:?}"),
        }
    }

    fn code(error: ForgeError) -> u32 {
        u32::from(error)
    }

    #[test]
    fn allows_an_issue_that_exactly_fills_the_reserve() {
        assert!(check().require_within_reserve().is_ok());
    }

    #[test]
    fn refuses_one_unit_over() {
        let over = ReserveCheck {
            minting: 1_001,
            ..check()
        };
        assert_eq!(
            err(over.require_within_reserve()),
            code(ForgeError::ReserveInsufficient)
        );
    }

    /// SC-005: дві емісії, кожна з яких окремо вміщується в резерв. Друга бачить
    /// обіг, який уже виріс від першої, — і не проходить.
    #[test]
    fn refuses_the_second_of_two_issues_that_each_fit_alone() {
        let first = ReserveCheck {
            minting: 600,
            ..check()
        };
        assert!(first.require_within_reserve().is_ok());

        let second = ReserveCheck {
            supply: 600,
            minting: 600,
            ..check()
        };
        assert_eq!(
            err(second.require_within_reserve()),
            code(ForgeError::ReserveInsufficient)
        );
    }

    #[test]
    fn separates_an_expired_attestation_from_an_insufficient_reserve() {
        // FR-023a: для емітента це різні дії — попросити свіжу атестацію або
        // довнести резерв.
        let stale = ReserveCheck {
            attested_at: NOW - 7 * DAY - 1,
            ..check()
        };
        assert_eq!(
            err(stale.require_within_reserve()),
            code(ForgeError::ReserveAttestationExpired)
        );

        // Протермінована перевіряється **раніше** за суму: емітенту з обома
        // проблемами треба спершу свіжа атестація, бо без неї сума нічого не
        // означає.
        let both = ReserveCheck {
            attested_at: NOW - 7 * DAY - 1,
            minting: 10_000,
            ..check()
        };
        assert_eq!(
            err(both.require_within_reserve()),
            code(ForgeError::ReserveAttestationExpired)
        );
    }

    #[test]
    fn is_still_current_at_the_last_second_of_its_life() {
        let edge = ReserveCheck {
            attested_at: NOW - 7 * DAY,
            ..check()
        };
        assert!(edge.require_within_reserve().is_ok());
    }

    #[test]
    fn refuses_an_attestation_dated_in_the_future() {
        let ahead = ReserveCheck {
            attested_at: NOW + 1,
            ..check()
        };
        assert_eq!(
            err(ahead.require_within_reserve()),
            code(ForgeError::AttestationInTheFuture)
        );
    }

    #[test]
    fn refuses_instead_of_overflowing() {
        // Паніка тут була б відмовою без причини.
        let huge = ReserveCheck {
            supply: u64::MAX,
            minting: 1,
            ..check()
        };
        assert_eq!(
            err(huge.require_within_reserve()),
            code(ForgeError::ReserveInsufficient)
        );
    }

    fn config(count: u64) -> TokenConfig {
        TokenConfig {
            issuer: Pubkey::new_from_array([1u8; 32]),
            mint: Pubkey::new_from_array([2u8; 32]),
            attestation_credential: Pubkey::default(),
            attestation_schema: Pubkey::default(),
            attestor: Pubkey::default(),
            treasury: Pubkey::default(),
            policy_version: 1,
            fee_bps: 0,
            attestation_max_age: 7 * DAY,
            paused_at: 0,
            bump: 254,
            attestation_count: count,
            reserve_currency: NGN_CURRENCY,
        }
    }

    fn attestation(index: u64, mint: Pubkey) -> ReserveAttestation {
        ReserveAttestation {
            mint,
            index,
            amount: 1_000,
            currency: NGN_CURRENCY,
            attestor: Pubkey::default(),
            attested_at: NOW,
            bump: 254,
        }
    }

    #[test]
    fn accepts_only_the_last_attestation_published() {
        let config = config(3);
        assert!(require_latest(&config, &attestation(2, config.mint)).is_ok());
        // Старіша атестація з більшою сумою — це емісія понад резерв через
        // акаунт, якого ніхто не редагував.
        assert_eq!(
            err(require_latest(&config, &attestation(1, config.mint))),
            code(ForgeError::AttestationNotLatest)
        );
        // І чужа атестація з правильним номером — теж не вона.
        assert_eq!(
            err(require_latest(
                &config,
                &attestation(2, Pubkey::new_from_array([9u8; 32]))
            )),
            code(ForgeError::AttestationNotLatest)
        );
    }

    #[test]
    fn allows_issuing_nothing_against_an_empty_reserve() {
        // Резерв, який спорожнів, не робить токен недійсним: він зупиняє емісію,
        // а не обіг (FR-023).
        let nothing = ReserveCheck {
            attested: 0,
            supply: 0,
            minting: 0,
            ..check()
        };
        assert!(nothing.require_within_reserve().is_ok());
    }
}
