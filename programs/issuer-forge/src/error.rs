use anchor_lang::prelude::*;

/// All the program's errors in one enum — and that is forced, not a matter
/// of taste.
///
/// Anchor numbers codes sequentially from `ERROR_CODE_OFFSET` (6000) in
/// declaration order. Two separate `#[error_code]`s without `offset` would
/// both start at 6000 and collide, while `#[error_code(offset = …)]`
/// separates them **only at runtime**: the IDL generator hardcodes
/// `ERROR_CODE_OFFSET + #id` (`anchor-syn-0.32.1/src/idl/error.rs:29`) and
/// knows nothing of the offset. An IDL with the wrong numbering is worse than
/// none: the Anchor client would name code 6000 — a real transfer refusal —
/// as the first validation error.
///
/// Hence the layout below, which has two sections and one rule.
///
/// **Section 1, indices 0…11 — the transfer refusal codes.** A mirror of
/// `packages/shared/src/refusal.ts`: the names and the **order** match one to
/// one, because `hookIndex` there is this index, and `6000 + hookIndex` is
/// the number that arrives in the logs and then in the journal the issuer
/// shows the regulator. The order repeats the order of checks in the hook: a
/// refusal is the first check that failed. The logic that returns them is
/// written by T015; they are declared here because the number must be pinned
/// before the first transaction, not after.
///
/// **Section 2, indices 12 onwards — input and authority checks.**
///
/// **One rule: variants are only ever appended at the end of their
/// section.** An insertion in the middle shifts every following code and
/// silently renames refusal reasons in journal records already issued. The
/// test `refusal_codes_match_the_shared_table` exists precisely against
/// that.
#[error_code]
pub enum ForgeError {
    // ─── Section 1: transfer refusals (a mirror of refusal.ts) ───────────────
    #[msg("policy version does not match the one this mint is configured for")]
    PolicyVersionMismatch,
    #[msg("sender has no status account")]
    SenderStatusMissing,
    #[msg("recipient has no status account")]
    RecipientStatusMissing,
    #[msg("status comes from a source this rule does not accept")]
    StatusSourceNotAccepted,
    #[msg("a status source required by the policy is unavailable")]
    StatusSourceUnavailable,
    #[msg("sender is on the issuer's denied register")]
    SenderDenied,
    #[msg("recipient is on the issuer's denied register")]
    RecipientDenied,
    #[msg("recipient verification tier is below the minimum")]
    RecipientTierTooLow,
    #[msg("recipient jurisdiction is not allowed to hold this token")]
    RecipientJurisdictionNotAllowed,
    #[msg("amount exceeds the single-transfer limit")]
    TransferLimitExceeded,
    #[msg("sender has no velocity counter")]
    VelocityCounterMissing,
    #[msg("amount exceeds the limit for the period")]
    PeriodLimitExceeded,
    /// The policy contains a rule kind this version of the program does not
    /// know.
    ///
    /// **Last in the section, and that is the check order, not a concession
    /// to numbering.** A rule the reader does not understand makes "yes"
    /// itself impossible: if an understood rule has already refused, its
    /// reason is more precise and it is the one named; if all the understood
    /// ones passed, "yes" still cannot be said, because the unknown one might
    /// have said "no".
    ///
    /// Reachable only after rolling the program back to a version older than
    /// the policy: `set_policy` rejects writing an unknown kind
    /// (`PolicyRuleKindUnknown`).
    #[msg("policy carries a rule kind this version of the program does not know")]
    UnknownRuleKind,

    // ─── Section 2: input and authority checks ───────────────────────────────
    #[msg("issuer must have at least two members to reach a quorum")]
    TooFewMembers,
    #[msg("member list exceeds the fixed capacity")]
    TooManyMembers,
    #[msg("the same wallet appears twice in the member list")]
    DuplicateMember,
    #[msg("a member must hold at least one role")]
    MemberWithoutRole,
    #[msg("role mask contains a bit this program does not define")]
    UnknownRole,
    #[msg("the reserve attestor may hold no other role")]
    AttestorHoldsOtherRoles,
    #[msg("quorum must be at least two")]
    QuorumTooSmall,
    #[msg("quorum exceeds the number of members who may authorise actions")]
    QuorumExceedsSigners,
    #[msg("signer is not an administrator of this issuer")]
    NotAnAdmin,
    #[msg("delegation mask contains a power that can never be delegated")]
    UndelegatablePower,
    #[msg("operational key must be a real address")]
    MissingOperationalKey,
    #[msg("token config does not belong to this issuer")]
    TokenNotFromThisIssuer,
    #[msg("policy version must be exactly one past the version this mint is on")]
    PolicyVersionNotNext,
    #[msg("rule slots are not in the single canonical form this program accepts")]
    PolicyRulesNotCanonical,
    #[msg("policy carries a rule kind this program does not define")]
    PolicyRuleKindUnknown,
    #[msg("a rule parameter lies outside the range the model allows")]
    PolicyRuleParamsOutOfRange,
    #[msg("a policy must carry the status rule")]
    PolicyStatusRuleMissing,
    #[msg("signer is not a member who may authorise actions for this issuer")]
    NotAnAuthorisingSigner,
    #[msg("the same wallet approved twice")]
    DuplicateApproval,
    #[msg("action did not reach the issuer's quorum")]
    QuorumNotReached,
    #[msg("this power is not delegated to the operational key")]
    PowerNotDelegated,
    #[msg("signer is neither the operational key nor an officer of this issuer")]
    NotAnOperatorOrOfficer,
    #[msg("jurisdiction must be an upper-case ISO 3166-1 alpha-2 code")]
    HolderJurisdictionInvalid,
    #[msg("a status that is already expired when written would read as absent")]
    HolderStatusAlreadyExpired,
    #[msg("the first thaw must carry the holder status")]
    HolderStatusRequired,
    #[msg("this holder already has a status; change it with set_holder_status")]
    HolderStatusAlreadySet,
    #[msg("token account does not belong to this mint or to this wallet")]
    HolderAccountMismatch,
    #[msg("signer is not the current reserve attestor of this token")]
    NotTheAttestor,
    #[msg("currency must be 3 to 8 upper-case letters, zero padded")]
    ReserveCurrencyInvalid,
    #[msg("attestation currency is not the currency of this token")]
    ReserveCurrencyMismatch,
    #[msg("an attestation cannot be dated in the future")]
    AttestationInTheFuture,
    #[msg("the reserve attestation is older than this token allows")]
    ReserveAttestationExpired,
    #[msg("issuing this amount would put supply over the attested reserve")]
    ReserveInsufficient,
    #[msg("reserve check must read the latest attestation")]
    AttestationNotLatest,
    #[msg("named attestor is not a member of this issuer holding the attestor role")]
    NotAnAttestorMember,
    #[msg("attestation lifetime must be positive, or no attestation is ever current")]
    AttestationMaxAgeInvalid,
    #[msg("token name, symbol or uri is longer than this program writes")]
    TokenMetadataTooLong,
    #[msg("fee rate cannot exceed one hundred per cent")]
    FeeRateOutOfRange,
}

/// The first code of the checks section. The refusal section takes exactly `ERROR_CODE_OFFSET…+12`.
pub const VALIDATION_ERROR_BASE: u32 = anchor_lang::error::ERROR_CODE_OFFSET + 13;

#[cfg(test)]
mod tests {
    use super::*;

    /// The mirror is numeric, so it is checked numerically. The table below is
    /// copied from `packages/shared/src/refusal.ts` by hand — there is no
    /// other way, and that is exactly why it is here: a divergence must fail
    /// a test, not surface in the journal a month later.
    #[test]
    fn refusal_codes_match_the_shared_table() {
        let expected: [(ForgeError, u32); 13] = [
            (ForgeError::PolicyVersionMismatch, 6000),
            (ForgeError::SenderStatusMissing, 6001),
            (ForgeError::RecipientStatusMissing, 6002),
            (ForgeError::StatusSourceNotAccepted, 6003),
            (ForgeError::StatusSourceUnavailable, 6004),
            (ForgeError::SenderDenied, 6005),
            (ForgeError::RecipientDenied, 6006),
            (ForgeError::RecipientTierTooLow, 6007),
            (ForgeError::RecipientJurisdictionNotAllowed, 6008),
            (ForgeError::TransferLimitExceeded, 6009),
            (ForgeError::VelocityCounterMissing, 6010),
            (ForgeError::PeriodLimitExceeded, 6011),
            (ForgeError::UnknownRuleKind, 6012),
        ];

        for (error, code) in expected {
            assert_eq!(u32::from(error), code, "{}", error.name());
        }
    }

    /// The checks section starts right after the refusals and does not intrude on them.
    #[test]
    fn validation_errors_start_after_the_refusal_range() {
        assert_eq!(VALIDATION_ERROR_BASE, 6013);
        assert_eq!(u32::from(ForgeError::TooFewMembers), VALIDATION_ERROR_BASE);
    }

    /// Section 2 is only ever appended at the end. An insertion in the middle
    /// would shift every following code and silently rename refusal reasons
    /// in transactions already on chain.
    #[test]
    fn validation_codes_only_ever_grow_at_the_end() {
        // The last code that existed before T014.
        assert_eq!(
            u32::from(ForgeError::MissingOperationalKey),
            VALIDATION_ERROR_BASE + 10
        );
        // The first and the last of those added by T014.
        assert_eq!(
            u32::from(ForgeError::TokenNotFromThisIssuer),
            VALIDATION_ERROR_BASE + 11
        );
        assert_eq!(
            u32::from(ForgeError::QuorumNotReached),
            VALIDATION_ERROR_BASE + 19
        );
        // The first and the last of those added by T016.
        assert_eq!(
            u32::from(ForgeError::PowerNotDelegated),
            VALIDATION_ERROR_BASE + 20
        );
        assert_eq!(
            u32::from(ForgeError::HolderAccountMismatch),
            VALIDATION_ERROR_BASE + 26
        );
        // The first and the last of those added by T055.
        assert_eq!(
            u32::from(ForgeError::NotTheAttestor),
            VALIDATION_ERROR_BASE + 27
        );
        assert_eq!(
            u32::from(ForgeError::AttestationNotLatest),
            VALIDATION_ERROR_BASE + 33
        );
        // The first and the last of those added by T018.
        assert_eq!(
            u32::from(ForgeError::NotAnAttestorMember),
            VALIDATION_ERROR_BASE + 34
        );
        assert_eq!(
            u32::from(ForgeError::FeeRateOutOfRange),
            VALIDATION_ERROR_BASE + 37
        );
    }
}
