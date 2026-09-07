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
    /// Політика містить вид правила, якого ця версія програми не знає.
    ///
    /// **Останній у секції, і це порядок перевірки, а не поступка нумерації.**
    /// Правило, якого читач не розуміє, робить неможливим саме «так»: якщо
    /// зрозуміле правило вже відмовило, його причина точніша й називається
    /// вона; якщо ж усі зрозумілі пройшли, сказати «так» не можна, бо невідоме
    /// могло сказати «ні».
    ///
    /// Досяжний тільки після відкату програми на версію, старшу за політику:
    /// запис невідомого виду відхиляє `set_policy` (`PolicyRuleKindUnknown`).
    #[msg("policy carries a rule kind this version of the program does not know")]
    UnknownRuleKind,

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
}

/// Перший код секції перевірок. Секція відмов займає рівно `ERROR_CODE_OFFSET…+12`.
pub const VALIDATION_ERROR_BASE: u32 = anchor_lang::error::ERROR_CODE_OFFSET + 13;

#[cfg(test)]
mod tests {
    use super::*;

    /// Дзеркало числове, тож і звіряється числами. Таблиця нижче переписана з
    /// `packages/shared/src/refusal.ts` вручну — іншого способу немає, і саме
    /// тому вона тут є: розходження має падати тестом, а не виявлятись у
    /// журналі через місяць.
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

    /// Секція перевірок починається одразу за відмовами й не залазить у них.
    #[test]
    fn validation_errors_start_after_the_refusal_range() {
        assert_eq!(VALIDATION_ERROR_BASE, 6013);
        assert_eq!(u32::from(ForgeError::TooFewMembers), VALIDATION_ERROR_BASE);
    }

    /// Секція 2 тільки дописується в кінець. Вставка в середину зсунула б усі
    /// наступні коди й тихо перейменувала причини відмов у транзакціях, які вже
    /// лежать у ланцюгу.
    #[test]
    fn validation_codes_only_ever_grow_at_the_end() {
        // Останній код, який був до T014.
        assert_eq!(
            u32::from(ForgeError::MissingOperationalKey),
            VALIDATION_ERROR_BASE + 10
        );
        // Перший і останній із доданих T014.
        assert_eq!(
            u32::from(ForgeError::TokenNotFromThisIssuer),
            VALIDATION_ERROR_BASE + 11
        );
        assert_eq!(
            u32::from(ForgeError::QuorumNotReached),
            VALIDATION_ERROR_BASE + 19
        );
        // Перший і останній із доданих T016.
        assert_eq!(
            u32::from(ForgeError::PowerNotDelegated),
            VALIDATION_ERROR_BASE + 20
        );
        assert_eq!(
            u32::from(ForgeError::HolderAccountMismatch),
            VALIDATION_ERROR_BASE + 26
        );
    }
}
