use anchor_lang::prelude::*;

/// Усі помилки програми одним переліком — і це вимушено, а не за смаком.
///
/// Anchor нумерує коди послідовно від `ERROR_CODE_OFFSET` (6000) у порядку
/// оголошення. Два окремі `#[error_code]` без `offset` почались би з 6000 обидва
/// й зіткнулись, а `#[error_code(offset = …)]` розводить їх **тільки в рантаймі**:
/// генератор IDL хардкодить `ERROR_CODE_OFFSET + #id`
/// (`anchor-syn-0.32.1/src/idl/error.rs:29`) і про зсув не знає. IDL із чужою
/// нумерацією гірший за її відсутність: клієнт Anchor назвав би код 6000 —
/// реальну відмову переказу — першою помилкою валідації.
///
/// Звідси розкладка нижче, у якої дві секції й одне правило.
///
/// **Секція 1, індекси 0…11 — коди відмови в переказі.** Дзеркало
/// `packages/shared/src/refusal.ts`: назви й **порядок** збігаються один в один,
/// бо `hookIndex` там і є цей індекс, а `6000 + hookIndex` — те число, що
/// приїжджає в логах і далі в журнал, який емітент показує регулятору. Порядок
/// повторює порядок перевірок у хуку: відмова — це перша перевірка, що не
/// пройшла. Логіку, яка їх повертає, пише T015; тут вони оголошені, бо номер
/// має бути закріплений до першої транзакції, а не після.
///
/// **Секція 2, індекси 12 і далі — перевірки вхідних даних і повноважень.**
///
/// **Правило одне: варіанти тільки дописуються в кінець своєї секції.** Вставка
/// в середину зсуває всі наступні коди й тихо перейменовує причини відмов у вже
/// виданих записах журналу. Тест `refusal_codes_match_the_shared_table` існує
/// саме проти цього.
#[error_code]
pub enum ForgeError {
    // ─── Секція 1: відмови переказу (дзеркало refusal.ts) ────────────────────
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

    // ─── Секція 2: перевірки вхідних даних і повноважень ─────────────────────
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
}

/// Перший код секції перевірок. Секція відмов займає рівно `ERROR_CODE_OFFSET…+11`.
pub const VALIDATION_ERROR_BASE: u32 = anchor_lang::error::ERROR_CODE_OFFSET + 12;

#[cfg(test)]
mod tests {
    use super::*;

    /// Дзеркало числове, тож і звіряється числами. Таблиця нижче переписана з
    /// `packages/shared/src/refusal.ts` вручну — іншого способу немає, і саме
    /// тому вона тут є: розходження має падати тестом, а не виявлятись у
    /// журналі через місяць.
    #[test]
    fn refusal_codes_match_the_shared_table() {
        let expected: [(ForgeError, u32); 12] = [
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
        ];

        for (error, code) in expected {
            assert_eq!(u32::from(error), code, "{}", error.name());
        }
    }

    /// Секція перевірок починається одразу за відмовами й не залазить у них.
    #[test]
    fn validation_errors_start_after_the_refusal_range() {
        assert_eq!(VALIDATION_ERROR_BASE, 6012);
        assert_eq!(u32::from(ForgeError::TooFewMembers), VALIDATION_ERROR_BASE);
    }
}
