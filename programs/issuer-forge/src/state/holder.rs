use anchor_lang::prelude::*;

use crate::error::ForgeError;
use crate::rules::evaluate::{StatusRecord, VelocityCounterView};

/// An address's status in the issuer's own registry. PDA:
/// `["holder", mint, wallet]`.
///
/// This is **one of the two** status sources (FR-008a); the other is the
/// provider's attestation, which the hook reads directly from the shared
/// attestation service (spike T057).
///
/// **Two fields from `docs/PLAN.md` are absent here, deliberately:**
/// - `source` (issuer/provider) was needed while the provider status was
///   planned to be mirrored here. T057 settled the question differently —
///   the attestation is read directly — so the field would mean "the source
///   of this record in the issuer's registry is not the issuer", which never
///   happens.
/// - `thawed` would be a second source of truth about a state held
///   authoritatively by the token account itself (`DefaultAccountState`,
///   `freeze_account`). An officer can freeze an account (T026) without
///   touching this account, and the flag here would instantly become a lie.
///   The thaw queue (FR-008b2) lives off-chain.
///
/// Because of that `flags` shrank to one value and stayed a `bool`: a
/// one-bit bitmask is a mask read by checking against the comment.
#[account]
#[derive(InitSpace)]
pub struct HolderStatus {
    /// Both fields deliberately duplicate the seeds: the console and the
    /// indexer look for holders through `getProgramAccounts` with a filter by
    /// mint, and such a filter cannot be made on seeds.
    pub mint: Pubkey,
    pub wallet: Pubkey,
    /// The verification tier as the issuer assigned it.
    pub tier: u8,
    /// An upper-case ISO 3166-1 alpha-2 code.
    pub jurisdiction: [u8; 2],
    /// The issuer's denial. Applies **regardless** of whether the policy
    /// accepts this source (FR-008a1): the issuer's own registry narrows the
    /// circle allowed by the provider and never widens it.
    pub denied: bool,
    /// The record's expiry, unix seconds. **Zero means "no expiry"**, not
    /// "expired": a record without an expiry is a valid registry state, and
    /// it is what distinguishes the registry from an attestation, which always
    /// has one.
    pub expires_at: i64,
    /// When the record was last written.
    ///
    /// Not decoration: **zero here means "no record yet"**. A freshly created
    /// account is all zeros, and no real record has a zero block time, so
    /// `thaw_holder` tells the first thaw from a repeat one by this field —
    /// and does not overwrite a status it was not entrusted to write.
    pub updated_at: i64,
    pub bump: u8,
}

/// The per-period limit counter. PDA: `["velocity", mint, wallet]`.
///
/// **A correction to the first edition of this file (T016).** At first
/// there was no `mint` and `wallet` here: only the hook reads the counter, by
/// the derived address, and nobody needs to scan it by filter. The argument
/// turned out incomplete — the hook takes this account **untyped** (its
/// absence must yield our refusal code, not an Anchor error), so it can be
/// tied to the holder either by these two fields or by
/// `create_program_address`, and the latter costs 1500 CU on every transfer
/// (SC-003). Sixty-four bytes of rent are cheaper than that.
#[account]
#[derive(InitSpace)]
pub struct VelocityCounter {
    pub mint: Pubkey,
    pub wallet: Pubkey,
    /// The start of the current window. Zero means there has been no window yet.
    pub window_start: i64,
    pub spent_in_window: u64,
    pub bump: u8,
}

impl HolderStatus {
    /// The record in the shape the rule evaluator reads.
    ///
    /// The conversion lives here, in one place: otherwise the hook (T017)
    /// would derive "zero means no expiry" a second time, and two readings of
    /// the same field would diverge some day.
    pub fn record(&self) -> StatusRecord {
        StatusRecord {
            denied: self.denied,
            tier: self.tier,
            jurisdiction: self.jurisdiction,
            expires_at: (self.expires_at != 0).then_some(self.expires_at),
        }
    }

    /// Whether this account has been written at least once.
    pub fn is_written(&self) -> bool {
        self.updated_at != 0
    }
}

impl VelocityCounter {
    pub fn view(&self) -> VelocityCounterView {
        VelocityCounterView {
            window_start: self.window_start,
            spent_in_window: self.spent_in_window,
        }
    }
}

/// The status values an instruction brings.
///
/// A separate type from the account: the account also has `mint`, `wallet`,
/// `bump` and `updated_at`, and the client sets none of them.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct HolderStatusInput {
    pub tier: u8,
    pub jurisdiction: [u8; 2],
    pub denied: bool,
    /// Zero — no expiry.
    pub expires_at: i64,
}

impl HolderStatusInput {
    pub fn validate(&self, now: i64) -> Result<()> {
        // The jurisdiction is compared against the policy's list byte for
        // byte, so a code not in upper case does not "almost fit" — it never
        // fits, and learning that from a refused transfer a week later would
        // be expensive.
        require!(
            self.jurisdiction[0].is_ascii_uppercase() && self.jurisdiction[1].is_ascii_uppercase(),
            ForgeError::HolderJurisdictionInvalid
        );
        // A record expired at the moment of creation reads as absent — i.e.
        // the action does nothing but looks done. Revoking a status is
        // expressed with `denied`, not with an expiry in the past.
        require!(
            self.expires_at == 0 || self.expires_at > now,
            ForgeError::HolderStatusAlreadyExpired
        );
        Ok(())
    }
}

impl HolderStatus {
    /// Writes the status values. The only place in the program that writes these fields.
    pub fn apply(&mut self, input: &HolderStatusInput, now: i64) -> Result<()> {
        input.validate(now)?;
        self.tier = input.tier;
        self.jurisdiction = input.jurisdiction;
        self.denied = input.denied;
        self.expires_at = input.expires_at;
        self.updated_at = now;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;

    fn blank() -> HolderStatus {
        HolderStatus {
            mint: Pubkey::default(),
            wallet: Pubkey::default(),
            tier: 0,
            jurisdiction: [0, 0],
            denied: false,
            expires_at: 0,
            updated_at: 0,
            bump: 254,
        }
    }

    fn input() -> HolderStatusInput {
        HolderStatusInput {
            tier: 3,
            jurisdiction: *b"NG",
            denied: false,
            expires_at: 0,
        }
    }

    fn err(result: Result<()>) -> u32 {
        match result.expect_err("expected a failure") {
            anchor_lang::error::Error::AnchorError(e) => e.error_code_number,
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn a_fresh_account_reads_as_never_written() {
        // The difference between the first thaw and a repeat one rests on this.
        assert!(!blank().is_written());
        let mut holder = blank();
        holder.apply(&input(), NOW).expect("applies");
        assert!(holder.is_written());
        assert_eq!(holder.updated_at, NOW);
    }

    #[test]
    fn zero_expiry_means_no_expiry_and_not_an_expired_record() {
        let mut holder = blank();
        holder.apply(&input(), NOW).expect("applies");
        assert_eq!(holder.record().expires_at, None);

        holder
            .apply(
                &HolderStatusInput {
                    expires_at: NOW + 3600,
                    ..input()
                },
                NOW,
            )
            .expect("applies");
        assert_eq!(holder.record().expires_at, Some(NOW + 3600));
    }

    #[test]
    fn refuses_a_jurisdiction_that_is_not_an_upper_case_iso_code() {
        let mut holder = blank();
        assert_eq!(
            err(holder.apply(
                &HolderStatusInput {
                    jurisdiction: *b"ng",
                    ..input()
                },
                NOW
            )),
            u32::from(ForgeError::HolderJurisdictionInvalid)
        );
        // A failed check does not leave a half-written status.
        assert!(!holder.is_written());
    }

    #[test]
    fn refuses_a_record_that_is_expired_the_moment_it_is_written() {
        let mut holder = blank();
        for expires_at in [NOW, NOW - 1] {
            assert_eq!(
                err(holder.apply(
                    &HolderStatusInput {
                        expires_at,
                        ..input()
                    },
                    NOW
                )),
                u32::from(ForgeError::HolderStatusAlreadyExpired)
            );
        }
        assert!(holder
            .apply(
                &HolderStatusInput {
                    expires_at: NOW + 1,
                    ..input()
                },
                NOW
            )
            .is_ok());
    }

    #[test]
    fn carries_the_denial_into_the_record_the_evaluator_reads() {
        let mut holder = blank();
        holder
            .apply(
                &HolderStatusInput {
                    denied: true,
                    ..input()
                },
                NOW,
            )
            .expect("applies");
        let record = holder.record();
        assert!(record.denied);
        assert_eq!(record.tier, 3);
        assert_eq!(record.jurisdiction, *b"NG");
    }

    #[test]
    fn the_counter_view_carries_the_window_untouched() {
        let counter = VelocityCounter {
            mint: Pubkey::default(),
            wallet: Pubkey::default(),
            window_start: NOW - 10,
            spent_in_window: 42,
            bump: 254,
        };
        assert_eq!(counter.view(), counter.view());
        assert_eq!(counter.view().window_start, NOW - 10);
        assert_eq!(counter.view().spent_in_window, 42);
    }
}
