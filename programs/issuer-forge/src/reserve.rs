//! The check "issuance + circulation ≤ attested reserve" (FR-022, FR-023).
//!
//! **One check for every way tokens come into existence.** Both the initial
//! issuance in `create_token` (T018) and further issuance in `mint` (T038,
//! M3) go through it. Two checks would mean one of them falls behind some
//! day — and falling behind here is called issuing beyond the reserve.
//!
//! **Circulation is taken from `mint.supply` at execution time, not from the
//! arguments.** That is what closes the SC-005 scenario of two concurrent
//! issuances each of which fits the reserve on its own: the second
//! transaction sees a supply already grown by the first, and does not pass.
//! No separate lock for the race is needed — the execution order within the
//! block plays that role.
use anchor_lang::prelude::*;

use crate::error::ForgeError;
use crate::state::{ReserveAttestation, TokenConfig};

/// Whether this really is the **latest** attestation of this token.
///
/// Without this check an older attestation with a larger amount would be a
/// valid input — i.e. an issuance beyond the reserve, carried out through an
/// account nobody edited. The counter in `TokenConfig` says which one is the
/// latest; the amount itself stays where the journal verifier reads it too.
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

/// Everything needed to answer the question "may this amount be issued".
pub struct ReserveCheck {
    /// The attested amount from the **latest** attestation.
    pub attested: u64,
    pub attested_at: i64,
    /// How long an attestation stays current (`TokenConfig.attestation_max_age`).
    pub max_age: i64,
    /// Circulation at execution time — `mint.supply`.
    pub supply: u64,
    /// How much is being asked to issue.
    pub minting: u64,
    pub now: i64,
}

impl ReserveCheck {
    /// Two reasons for refusal, and they are **different** (FR-023a): "the
    /// attestation is expired" and "the reserve is insufficient" are different
    /// actions for the issuer, hence different codes.
    pub fn require_within_reserve(&self) -> Result<()> {
        // An attestation from the future is not "even more current" — it is a
        // broken clock at the attestor or an attempt to extend the period in
        // advance.
        require!(
            self.attested_at <= self.now,
            ForgeError::AttestationInTheFuture
        );
        require!(
            self.now.saturating_sub(self.attested_at) <= self.max_age,
            ForgeError::ReserveAttestationExpired
        );

        // Saturation instead of overflow: a sum that does not fit in a u64 is
        // unconditionally larger than any reserve, and a panic here would be a
        // refusal without a reason.
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

    /// SC-005: two issuances each of which fits the reserve on its own. The
    /// second sees a circulation already grown by the first — and does not
    /// pass.
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
        // FR-023a: for the issuer these are different actions — ask for a fresh
        // attestation, or top up the reserve.
        let stale = ReserveCheck {
            attested_at: NOW - 7 * DAY - 1,
            ..check()
        };
        assert_eq!(
            err(stale.require_within_reserve()),
            code(ForgeError::ReserveAttestationExpired)
        );

        // Expiry is checked **before** the amount: an issuer with both problems
        // needs a fresh attestation first, because without it the amount means
        // nothing.
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
        // A panic here would be a refusal without a reason.
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
        // An older attestation with a larger amount is an issuance beyond the
        // reserve through an account nobody edited.
        assert_eq!(
            err(require_latest(&config, &attestation(1, config.mint))),
            code(ForgeError::AttestationNotLatest)
        );
        // And someone else's attestation with the right number is not it either.
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
        // A reserve that ran dry does not invalidate the token: it stops
        // issuance, not circulation (FR-023).
        let nothing = ReserveCheck {
            attested: 0,
            supply: 0,
            minting: 0,
            ..check()
        };
        assert!(nothing.require_within_reserve().is_ok());
    }
}
