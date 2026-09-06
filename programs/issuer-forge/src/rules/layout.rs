//! Канонічна розкладка правил політики і її перевірка при записі.
//!
//! Дзеркало `packages/policy/src/layout.ts`. Там `decode` відхиляє все, що
//! `encode` не міг видати; тут те саме робить `validate` — і робить це **до**
//! того, як байти ляжуть в акаунт. Це другий замок канонічності: перший стоїть
//! на клієнті, а клієнт нашою програмою не є.
//!
//! Чому цього мало не бути: `rules_hash` іменує політику, і два різні масиви
//! байтів з тим самим змістом зробили б це ім'я іменем запису, а не політики —
//! рівно в момент, коли на нього посилається рядок журналу.
//!
//! Оцінювач правил (T015) читає ці ж слоти на кожному переказі й лягає поруч, у
//! `rules/`. Тут — тільки форма й межі, без жодного рішення про переказ.
use anchor_lang::prelude::*;
use solana_sha256_hasher::hash;

use crate::error::ForgeError;

/// Слотів у `PolicyConfig.rules`. Фіксовано під zero-copy читання в хуку.
pub const MAX_RULE_SLOTS: usize = 16;

/// Байтів на слот: `kind`, `op`, `params`.
pub const RULE_SLOT_BYTES: usize = 24;

/// Байтів параметрів у слоті — саме цей бюджет обмежує кожне правило.
pub const RULE_PARAMS_BYTES: usize = 22;

/// Повний розмір поля `rules`.
pub const RULES_BYTES: usize = MAX_RULE_SLOTS * RULE_SLOT_BYTES;

/// Коди видів правил. Нуль зарезервований за порожнім слотом: масив фіксованої
/// довжини завжди має хвіст із нулів, і вид правила з кодом 0 зробив би цей
/// хвіст шістнадцятьма мовчазними правилами.
pub mod rule_kind {
    pub const EMPTY: u8 = 0;
    pub const STATUS: u8 = 1;
    pub const JURISDICTIONS: u8 = 2;
    pub const TRANSFER_LIMIT: u8 = 3;
    pub const PERIOD_LIMIT: u8 = 4;
}

/// Бітові значення джерел статусу — дзеркало `STATUS_SOURCE` у `model.ts`.
pub mod status_source {
    pub const PROVIDER: u8 = 1 << 0;
    pub const REGISTER: u8 = 1 << 1;
    pub const ALL: u8 = PROVIDER | REGISTER;
}

/// Другий байт слота лишається нулем і **перевіряється**: інакше він стає тихим
/// каналом, у який щось потрапляє й змінює `rules_hash`, нічого не змінюючи в
/// змісті. Нове кодування параметрів — це новий `kind`, а не нове значення тут.
pub const RULE_OP_RESERVED: u8 = 0;

/// Юрисдикцій в одному правилі: код ISO alpha-2 — два байти, параметрів — 22.
pub const MAX_JURISDICTIONS: usize = RULE_PARAMS_BYTES / 2;

pub const MIN_PERIOD_SECONDS: u32 = 3_600;
pub const MAX_PERIOD_SECONDS: u32 = 31 * 24 * 3_600;
pub const MIN_ATTESTATION_AGE_SECONDS: u32 = 3_600;
pub const MAX_ATTESTATION_AGE_SECONDS: u32 = 365 * 24 * 3_600;

/// Один слот правила, як він лежить в акаунті.
#[zero_copy]
pub struct RuleSlot {
    pub kind: u8,
    pub op: u8,
    pub params: [u8; RULE_PARAMS_BYTES],
}

/// Перевірка канонічності всього масиву слотів.
///
/// Відхиляє все, чого не міг видати `encode` на боці TS: ненульову набивку
/// порожнього слота, дірку між правилами, ненульовий `op`, порядок не за
/// зростанням `kind` (він же ловить дублі), невідомий вид правила й параметри
/// поза межами моделі. Жодна з цих речей не змінює того, що політика означає —
/// і кожна змінює її хеш.
pub fn validate(slots: &[RuleSlot]) -> Result<()> {
    require!(
        slots.len() == MAX_RULE_SLOTS,
        ForgeError::PolicyRulesNotCanonical
    );

    let mut previous_kind = rule_kind::EMPTY;
    let mut ended = false;
    let mut has_status = false;

    for slot in slots {
        if slot.kind == rule_kind::EMPTY {
            // Порожній слот мусить бути порожній цілком.
            require!(
                slot.op == 0 && slot.params.iter().all(|byte| *byte == 0),
                ForgeError::PolicyRulesNotCanonical
            );
            ended = true;
            continue;
        }

        // Дірка між правилами дала б два кодування однієї політики.
        require!(!ended, ForgeError::PolicyRulesNotCanonical);
        require!(
            slot.op == RULE_OP_RESERVED,
            ForgeError::PolicyRulesNotCanonical
        );
        // Строго за зростанням: цим же порівнянням відпадають і дублі.
        require!(
            slot.kind > previous_kind,
            ForgeError::PolicyRulesNotCanonical
        );
        previous_kind = slot.kind;

        match slot.kind {
            rule_kind::STATUS => {
                validate_status(&slot.params)?;
                has_status = true;
            }
            rule_kind::JURISDICTIONS => validate_jurisdictions(&slot.params)?,
            rule_kind::TRANSFER_LIMIT => validate_transfer_limit(&slot.params)?,
            rule_kind::PERIOD_LIMIT => validate_period_limit(&slot.params)?,
            // Невідомий вид правила — відмова, а не пропуск: політика, якої
            // читач не розуміє повністю, не стає слабшою мовчки. Той самий
            // принцип, що й FR-013 про недоступне джерело статусу.
            _ => return err!(ForgeError::PolicyRuleKindUnknown),
        }
    }

    // Політика без відповіді на питання «хто може тримати» неможлива за
    // моделлю; FR-008b1 вимагає постійної перевірки, а не разового
    // розморожування.
    require!(has_status, ForgeError::PolicyStatusRuleMissing);
    Ok(())
}

fn u32_at(params: &[u8; RULE_PARAMS_BYTES], at: usize) -> u32 {
    u32::from_le_bytes([params[at], params[at + 1], params[at + 2], params[at + 3]])
}

fn u64_at(params: &[u8; RULE_PARAMS_BYTES], at: usize) -> u64 {
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&params[at..at + 8]);
    u64::from_le_bytes(bytes)
}

fn require_zero_tail(params: &[u8; RULE_PARAMS_BYTES], from: usize) -> Result<()> {
    require!(
        params[from..].iter().all(|byte| *byte == 0),
        ForgeError::PolicyRulesNotCanonical
    );
    Ok(())
}

fn validate_status(params: &[u8; RULE_PARAMS_BYTES]) -> Result<()> {
    let mask = params[0];
    // Порожня маска — це «дозволити нікому», а невідомий біт — джерело, якого
    // читач не знає: виконати його не можна, пропустити теж.
    require!(
        mask != 0 && mask & !status_source::ALL == 0,
        ForgeError::PolicyRuleParamsOutOfRange
    );

    // params[1] — мінімальний рівень; стеля рівня є стелею байта, тож будь-яке
    // значення дійсне, і вигадувати тут продуктову межу немає підстав.
    let max_age = u32_at(params, 2);
    // Нуль означає «строку немає»: модель не дозволяє значення менше за годину,
    // тож нуль не є дійсним строком і читається однозначно.
    require!(
        max_age == 0
            || (MIN_ATTESTATION_AGE_SECONDS..=MAX_ATTESTATION_AGE_SECONDS).contains(&max_age),
        ForgeError::PolicyRuleParamsOutOfRange
    );
    // FR-008a2: політика, що приймає атестації провайдера й не називає строку
    // їх придатності, — це верифікація, зроблена колись і чинна назавжди.
    require!(
        mask & status_source::PROVIDER == 0 || max_age != 0,
        ForgeError::PolicyRuleParamsOutOfRange
    );

    require_zero_tail(params, 6)
}

fn validate_jurisdictions(params: &[u8; RULE_PARAMS_BYTES]) -> Result<()> {
    let mut count = 0usize;
    let mut previous = [0u8; 2];
    let mut ended = false;

    for index in 0..MAX_JURISDICTIONS {
        let code = [params[index * 2], params[index * 2 + 1]];
        if code == [0, 0] {
            ended = true;
            continue;
        }
        require!(!ended, ForgeError::PolicyRulesNotCanonical);
        require!(
            code[0].is_ascii_uppercase() && code[1].is_ascii_uppercase(),
            ForgeError::PolicyRuleParamsOutOfRange
        );
        // Строго за зростанням — та сама детермінованість, що й у порядку
        // слотів: множина країн не має порядку, а хеш політики мусить бути
        // однаковий для однакового змісту. Дублі відпадають цим же порівнянням.
        require!(
            count == 0 || code > previous,
            ForgeError::PolicyRulesNotCanonical
        );
        previous = code;
        count += 1;
    }

    // Порожній перелік не є способом сказати «усі»: правила немає — перевірки
    // немає, і другого способу сказати те саме бути не повинно.
    require!(count > 0, ForgeError::PolicyRuleParamsOutOfRange);
    Ok(())
}

fn validate_transfer_limit(params: &[u8; RULE_PARAMS_BYTES]) -> Result<()> {
    // Нульовий ліміт відмовляє в кожному переказі — це не ліміт, а зупинка
    // обігу, для якої існує пауза.
    require!(
        u64_at(params, 0) > 0,
        ForgeError::PolicyRuleParamsOutOfRange
    );
    require_zero_tail(params, 8)
}

fn validate_period_limit(params: &[u8; RULE_PARAMS_BYTES]) -> Result<()> {
    require!(
        u64_at(params, 0) > 0,
        ForgeError::PolicyRuleParamsOutOfRange
    );
    let window = u32_at(params, 8);
    require!(
        (MIN_PERIOD_SECONDS..=MAX_PERIOD_SECONDS).contains(&window),
        ForgeError::PolicyRuleParamsOutOfRange
    );
    require_zero_tail(params, 12)
}

/// `rules_hash` — sha256 над усіма шістнадцятьма слотами, як вони лежать в
/// акаунті.
///
/// sha256, а не щось інше, бо його рахує сама програма нативним syscall'ом: один
/// виклик на зміну політики й жодного на переказі. Хеш рахується над **усім**
/// полем, а не над заповненою частиною: незалежний верифікатор (SC-006) бере
/// зріз даних акаунта й хешує його, не знаючи, скільки слотів зайнято.
pub fn rules_hash(slots: &[RuleSlot]) -> [u8; 32] {
    hash(bytemuck::cast_slice(slots)).to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_slots() -> [RuleSlot; MAX_RULE_SLOTS] {
        [RuleSlot {
            kind: 0,
            op: 0,
            params: [0u8; RULE_PARAMS_BYTES],
        }; MAX_RULE_SLOTS]
    }

    fn status_params(mask: u8, tier: u8, max_age: u32) -> [u8; RULE_PARAMS_BYTES] {
        let mut params = [0u8; RULE_PARAMS_BYTES];
        params[0] = mask;
        params[1] = tier;
        params[2..6].copy_from_slice(&max_age.to_le_bytes());
        params
    }

    fn amount_params(amount: u64, window: Option<u32>) -> [u8; RULE_PARAMS_BYTES] {
        let mut params = [0u8; RULE_PARAMS_BYTES];
        params[0..8].copy_from_slice(&amount.to_le_bytes());
        if let Some(window) = window {
            params[8..12].copy_from_slice(&window.to_le_bytes());
        }
        params
    }

    fn jurisdiction_params(codes: &[&str]) -> [u8; RULE_PARAMS_BYTES] {
        let mut params = [0u8; RULE_PARAMS_BYTES];
        for (index, code) in codes.iter().enumerate() {
            // Порожній рядок лишає пару нулів — так у тесті записується дірка
            // всередині переліку.
            if code.len() == 2 {
                params[index * 2..index * 2 + 2].copy_from_slice(code.as_bytes());
            }
        }
        params
    }

    /// Найслабша політика, яку модель дозволяє записати: обидва джерела, рівень
    /// не перевіряється, атестації дано найдовший допустимий строк.
    fn open_policy() -> [RuleSlot; MAX_RULE_SLOTS] {
        let mut slots = empty_slots();
        slots[0] = RuleSlot {
            kind: rule_kind::STATUS,
            op: 0,
            params: status_params(status_source::ALL, 0, MAX_ATTESTATION_AGE_SECONDS),
        };
        slots
    }

    fn full_policy() -> [RuleSlot; MAX_RULE_SLOTS] {
        let mut slots = open_policy();
        slots[1] = RuleSlot {
            kind: rule_kind::JURISDICTIONS,
            op: 0,
            params: jurisdiction_params(&["GH", "KE", "NG"]),
        };
        slots[2] = RuleSlot {
            kind: rule_kind::TRANSFER_LIMIT,
            op: 0,
            params: amount_params(50_000_000, None),
        };
        slots[3] = RuleSlot {
            kind: rule_kind::PERIOD_LIMIT,
            op: 0,
            params: amount_params(200_000_000, Some(86_400)),
        };
        slots
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
    fn accepts_the_weakest_policy_the_model_allows() {
        assert!(validate(&open_policy()).is_ok());
    }

    #[test]
    fn accepts_every_rule_kind_at_once() {
        assert!(validate(&full_policy()).is_ok());
    }

    #[test]
    fn refuses_a_policy_without_the_status_rule() {
        let mut slots = empty_slots();
        slots[0] = RuleSlot {
            kind: rule_kind::TRANSFER_LIMIT,
            op: 0,
            params: amount_params(1, None),
        };
        assert_eq!(
            err(validate(&slots)),
            code(ForgeError::PolicyStatusRuleMissing)
        );
        // Порожня політика падає тим же кодом: слоти є, статусу немає.
        assert_eq!(
            err(validate(&empty_slots())),
            code(ForgeError::PolicyStatusRuleMissing)
        );
    }

    #[test]
    fn refuses_a_rule_kind_it_does_not_define() {
        // Це другий замок канонічності з T012: перший стоїть на клієнті, а
        // клієнт нашою програмою не є.
        let mut slots = open_policy();
        slots[1] = RuleSlot {
            kind: 9,
            op: 0,
            params: [0u8; RULE_PARAMS_BYTES],
        };
        assert_eq!(
            err(validate(&slots)),
            code(ForgeError::PolicyRuleKindUnknown)
        );
    }

    #[test]
    fn refuses_bytes_that_change_the_hash_without_changing_the_meaning() {
        // Ненульова набивка порожнього слота.
        let mut padded = open_policy();
        padded[5].params[7] = 1;
        assert_eq!(
            err(validate(&padded)),
            code(ForgeError::PolicyRulesNotCanonical)
        );

        // Ненульовий зарезервований байт.
        let mut op = open_policy();
        op[0].op = 1;
        assert_eq!(
            err(validate(&op)),
            code(ForgeError::PolicyRulesNotCanonical)
        );

        // Набивка всередині параметрів правила.
        let mut tail = open_policy();
        tail[0].params[21] = 1;
        assert_eq!(
            err(validate(&tail)),
            code(ForgeError::PolicyRulesNotCanonical)
        );
    }

    #[test]
    fn refuses_a_gap_and_a_broken_order() {
        let mut gap = empty_slots();
        gap[1] = open_policy()[0];
        assert_eq!(
            err(validate(&gap)),
            code(ForgeError::PolicyRulesNotCanonical)
        );

        let mut descending = full_policy();
        descending.swap(0, 2);
        assert_eq!(
            err(validate(&descending)),
            code(ForgeError::PolicyRulesNotCanonical)
        );

        let mut twice = open_policy();
        twice[1] = twice[0];
        assert_eq!(
            err(validate(&twice)),
            code(ForgeError::PolicyRulesNotCanonical)
        );
    }

    #[test]
    fn refuses_a_status_rule_that_names_no_known_source() {
        let mut none = open_policy();
        none[0].params = status_params(0, 0, MAX_ATTESTATION_AGE_SECONDS);
        assert_eq!(
            err(validate(&none)),
            code(ForgeError::PolicyRuleParamsOutOfRange)
        );

        let mut unknown = open_policy();
        unknown[0].params = status_params(1 << 4, 0, MAX_ATTESTATION_AGE_SECONDS);
        assert_eq!(
            err(validate(&unknown)),
            code(ForgeError::PolicyRuleParamsOutOfRange)
        );
    }

    #[test]
    fn refuses_provider_attestations_with_no_shelf_life() {
        // FR-008a2 існує саме проти верифікації, зробленої колись і чинної
        // назавжди.
        let mut slots = open_policy();
        slots[0].params = status_params(status_source::PROVIDER, 0, 0);
        assert_eq!(
            err(validate(&slots)),
            code(ForgeError::PolicyRuleParamsOutOfRange)
        );

        // Без провайдера серед джерел строк не потрібен.
        let mut register_only = open_policy();
        register_only[0].params = status_params(status_source::REGISTER, 0, 0);
        assert!(validate(&register_only).is_ok());
    }

    #[test]
    fn holds_the_attestation_age_inside_the_model_bounds() {
        for age in [MIN_ATTESTATION_AGE_SECONDS - 1, MAX_ATTESTATION_AGE_SECONDS + 1] {
            let mut slots = open_policy();
            slots[0].params = status_params(status_source::ALL, 0, age);
            assert_eq!(
                err(validate(&slots)),
                code(ForgeError::PolicyRuleParamsOutOfRange)
            );
        }
    }

    #[test]
    fn refuses_a_limit_of_zero() {
        // Нульовий ліміт — це зупинка обігу, для якої існує пауза.
        let mut transfer = full_policy();
        transfer[2].params = amount_params(0, None);
        assert_eq!(
            err(validate(&transfer)),
            code(ForgeError::PolicyRuleParamsOutOfRange)
        );

        let mut period = full_policy();
        period[3].params = amount_params(0, Some(86_400));
        assert_eq!(
            err(validate(&period)),
            code(ForgeError::PolicyRuleParamsOutOfRange)
        );
    }

    #[test]
    fn holds_the_period_window_inside_the_model_bounds() {
        for window in [MIN_PERIOD_SECONDS - 1, MAX_PERIOD_SECONDS + 1] {
            let mut slots = full_policy();
            slots[3].params = amount_params(1, Some(window));
            assert_eq!(
                err(validate(&slots)),
                code(ForgeError::PolicyRuleParamsOutOfRange)
            );
        }
    }

    #[test]
    fn refuses_jurisdictions_that_are_not_upper_case_iso_codes() {
        let mut slots = full_policy();
        slots[1].params = jurisdiction_params(&["ng"]);
        assert_eq!(
            err(validate(&slots)),
            code(ForgeError::PolicyRuleParamsOutOfRange)
        );
    }

    #[test]
    fn refuses_an_empty_or_unsorted_jurisdiction_list() {
        let mut empty = full_policy();
        empty[1].params = [0u8; RULE_PARAMS_BYTES];
        assert_eq!(
            err(validate(&empty)),
            code(ForgeError::PolicyRuleParamsOutOfRange)
        );

        let mut unsorted = full_policy();
        unsorted[1].params = jurisdiction_params(&["NG", "GH"]);
        assert_eq!(
            err(validate(&unsorted)),
            code(ForgeError::PolicyRulesNotCanonical)
        );

        let mut twice = full_policy();
        twice[1].params = jurisdiction_params(&["NG", "NG"]);
        assert_eq!(
            err(validate(&twice)),
            code(ForgeError::PolicyRulesNotCanonical)
        );

        let mut holed = full_policy();
        holed[1].params = jurisdiction_params(&["GH", "", "NG"]);
        assert_eq!(
            err(validate(&holed)),
            code(ForgeError::PolicyRulesNotCanonical)
        );
    }

    #[test]
    fn hashes_the_whole_field_and_not_the_filled_part() {
        // Дві політики, що різняться лише одним заповненим слотом, мусять мати
        // різні хеші; хеш береться з усіх 384 байтів, тож довжина входу стала.
        assert_ne!(rules_hash(&open_policy()), rules_hash(&full_policy()));
        assert_eq!(bytemuck::cast_slice::<RuleSlot, u8>(&open_policy()).len(), RULES_BYTES);
    }

    /// Хеш рахують дві реалізації: ця й `rulesHash` у `packages/policy`. Вектор
    /// нижче знятий з TS і зашитий сюди числом — розходження має падати тестом,
    /// а не виявлятись розбіжністю імені політики в журналі.
    #[test]
    fn matches_the_hash_the_typescript_side_computes() {
        assert_eq!(hex(&rules_hash(&open_policy())), OPEN_POLICY_HASH);
        assert_eq!(hex(&rules_hash(&full_policy())), FULL_POLICY_HASH);
    }

    const OPEN_POLICY_HASH: &str =
        "4653d1a2d2149fc8db6ed694883a36a969d9a0c592c073e6331dfd0f9759e989";
    const FULL_POLICY_HASH: &str =
        "1cb129c66a231211e6ecb590fde425d761518cf4ee90a3353c23dbd679ea7a20";

    fn hex(bytes: &[u8; 32]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }
}
