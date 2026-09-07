//! Оцінювач правил: політика + контекст переказу → перша перевірка, що не
//! пройшла (FR-007, FR-008, FR-008a1, FR-008a2).
//!
//! Друга половина пари, першу написано в `packages/policy/src/evaluate.ts`.
//! Дві реалізації однієї моделі звіряються диференційними тестами на спільних
//! фікстурах (SC-008, T019); без них дубль мовчки розійдеться.
//!
//! **Вхід дзеркалить те, що бачить хук**, а не зведений статус сторін: кожне
//! джерело кожної сторони приходить окремо, у трьох станах. Злиття двох джерел
//! і протермінування відбуваються **тут**, тобто потрапляють під звірку — це
//! рішення T013, і воно тут дотримане дослівно.
//!
//! **Порядок перевірок оголошений один раз** — у `REFUSAL_CODES`
//! (`packages/shared/src/refusal.ts`), дзеркало якого є секцією 1 `ForgeError`.
//! `CHECKS` нижче йде тим самим порядком, і тест `checks_follow_the_declared_order`
//! доводить це числами: коди в масиві мусять зростати від 6000 щільно.
//!
//! **Алокацій немає**: зріз слотів читається на місці, погляди на сторони —
//! два `Option` на стек. Хук викликається на кожному переказі, і CU-бюджет тут
//! є вимогою (SC-003), а не побажанням.
use anchor_lang::prelude::*;

use crate::error::ForgeError;
use crate::rules::layout::{rule_kind, status_source, RuleSlot, RULE_PARAMS_BYTES};

// ─── Контекст переказу ───────────────────────────────────────────────────────

/// Запис про адресу з одного джерела.
///
/// `expires_at` — власний строк запису (`HolderStatus.expires_at`,
/// `Attestation.expiry`). `None` — «без строку», а не «протерміновано»: запис
/// без строку є дійсним станом обох джерел.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StatusRecord {
    pub denied: bool,
    pub tier: u8,
    /// Код ISO 3166-1 alpha-2 у верхньому регістрі.
    pub jurisdiction: [u8; 2],
    pub expires_at: Option<i64>,
}

/// Атестація провайдера.
///
/// `issued_at` є тільки тут: строк `max_attestation_age` із правила (FR-008a2) —
/// це **вік** атестації, а віку без моменту видачі не буває. У `HolderStatus`
/// такого поля немає, тож спільна форма змусила б хук вигадувати значення.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProviderStatus {
    pub record: StatusRecord,
    pub issued_at: i64,
}

/// Стан одного джерела для однієї сторони. Станів три, і третій — найважливіший.
///
/// `Unavailable` — акаунт не переданий у переказ або переданий не той. Це **не**
/// «запису немає»: ми не знаємо, є він чи ні, а недоступність джерела не має
/// послаблювати політику (FR-013).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceState<T> {
    Unavailable,
    Absent,
    Record(T),
}

/// Обидва джерела для однієї сторони переказу.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PartyContext {
    pub provider: SourceState<ProviderStatus>,
    pub register: SourceState<StatusRecord>,
}

/// `VelocityCounter` відправника, як його читає хук.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VelocityCounterView {
    pub window_start: i64,
    pub spent_in_window: u64,
}

/// Усе, що хук має в руках у момент переказу.
///
/// `mint_policy_version` — версія, на яку налаштований mint; `policy_version` —
/// версія переданого `PolicyConfig`. Дві різні речі, і саме їх порівнює перша
/// перевірка: політика, підсунута замість чинної, інакше виконалася б замість неї.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TransferContext {
    pub sender: PartyContext,
    pub recipient: PartyContext,
    pub amount: u64,
    pub velocity: Option<VelocityCounterView>,
    pub mint_policy_version: u32,
    pub policy_version: u32,
    /// Час блоку, unix-секунди.
    pub now: i64,
}

// ─── Політика, прочитана зі слотів ───────────────────────────────────────────

/// Правила, зведені до того, що з них читають перевірки.
///
/// Читання не переперевіряє канонічність: її перевірив `set_policy` при записі
/// (T014). Тут потрібна лише стійкість до того, чого запис пропустити не міг, —
/// а на невідомий вид правила є власний код відмови.
#[derive(Clone, Copy, Default)]
struct PolicyView {
    /// Джерела, які можуть **дозволити**. Нуль означає «правила статусу немає»,
    /// і тоді дозволити не може жодне джерело: статус обов'язковий, тож його
    /// відсутність — це не «перевірки немає», а політика, якої не буває.
    source_mask: u8,
    min_tier: u8,
    max_attestation_age: Option<u32>,
    status_seen: bool,
    jurisdictions: Option<[u8; RULE_PARAMS_BYTES]>,
    transfer_limit: Option<u64>,
    period_limit: Option<(u64, u32)>,
    unknown_kind: bool,
}

fn u32_at(params: &[u8; RULE_PARAMS_BYTES], at: usize) -> u32 {
    u32::from_le_bytes([params[at], params[at + 1], params[at + 2], params[at + 3]])
}

fn u64_at(params: &[u8; RULE_PARAMS_BYTES], at: usize) -> u64 {
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&params[at..at + 8]);
    u64::from_le_bytes(bytes)
}

impl PolicyView {
    fn read(slots: &[RuleSlot]) -> Self {
        let mut view = Self::default();

        // Обходяться **всі** слоти, а не до першого порожнього. Дірка в масиві
        // не записується (T014), але зупинятись на ній означало б мовчки
        // пропустити правила за нею — тобто послабити політику через ваду її
        // байтів.
        for slot in slots {
            match slot.kind {
                rule_kind::EMPTY => {}
                rule_kind::STATUS => {
                    // Перший виграє: дубль виду правила не записується, а
                    // недетермінованість тут коштувала б розбіжності з TS.
                    if view.status_seen {
                        continue;
                    }
                    view.status_seen = true;
                    view.source_mask = slot.params[0];
                    view.min_tier = slot.params[1];
                    let age = u32_at(&slot.params, 2);
                    view.max_attestation_age = (age != 0).then_some(age);
                }
                rule_kind::JURISDICTIONS => {
                    view.jurisdictions.get_or_insert(slot.params);
                }
                rule_kind::TRANSFER_LIMIT => {
                    view.transfer_limit.get_or_insert(u64_at(&slot.params, 0));
                }
                rule_kind::PERIOD_LIMIT => {
                    view.period_limit
                        .get_or_insert((u64_at(&slot.params, 0), u32_at(&slot.params, 8)));
                }
                _ => view.unknown_kind = true,
            }
        }

        view
    }
}

/// Чи є код країни в переліку правила. Перелік закінчується парою нулів.
fn jurisdiction_listed(params: &[u8; RULE_PARAMS_BYTES], code: [u8; 2]) -> bool {
    params
        .chunks_exact(2)
        .take_while(|pair| pair != &[0, 0])
        .any(|pair| pair == code)
}

// ─── Злиття двох джерел ──────────────────────────────────────────────────────

/// Чинний запис, зведений до того, що з нього читають перевірки.
#[derive(Clone, Copy)]
struct StatusFact {
    source: u8,
    denied: bool,
    tier: u8,
    jurisdiction: [u8; 2],
}

/// Сторона переказу очима правил.
///
/// `unavailable` рахується по **обох** джерелах, а не лише по прийнятих: якщо
/// заборона діє з будь-якого джерела, то й недоступність будь-якого джерела може
/// ховати заборону. Пропустити переказ, не подивившись у джерело, яке могло
/// сказати «ні», — це рівно те послаблення політики, яке забороняє FR-013.
#[derive(Clone, Copy, Default)]
struct PartyView {
    provider: Option<StatusFact>,
    register: Option<StatusFact>,
    unavailable: bool,
}

impl PartyView {
    fn fresh(&self) -> impl Iterator<Item = StatusFact> + '_ {
        self.provider.into_iter().chain(self.register)
    }

    fn accepted(&self, mask: u8) -> impl Iterator<Item = StatusFact> + '_ {
        self.fresh().filter(move |fact| fact.source & mask != 0)
    }

    /// Про сторону не відомо нічого: обидва джерела доступні й обидва мовчать.
    fn nothing_known(&self) -> bool {
        !self.unavailable && self.fresh().next().is_none()
    }

    /// Статус є, але жодне з джерел, що його дали, правило не приймає.
    fn only_unaccepted(&self, mask: u8) -> bool {
        self.fresh().next().is_some() && self.accepted(mask).next().is_none()
    }

    fn denied(&self) -> bool {
        self.fresh().any(|fact| fact.denied)
    }

    /// Рівень — **найнижчий** серед прийнятих джерел: при розбіжності діє
    /// суворіше (FR-008a1), і друге джерело може тільки звузити коло, дозволене
    /// першим.
    ///
    /// Нуль на порожньому переліку недосяжний — до цієї перевірки доходять лише
    /// сторони з прийнятим записом, — але він і безпечний: сторона без статусу
    /// не пройде `min_tier`, більший за нуль.
    fn merged_tier(&self, mask: u8) -> u8 {
        self.accepted(mask).map(|fact| fact.tier).min().unwrap_or(0)
    }
}

fn is_current(expires_at: Option<i64>, now: i64) -> bool {
    // Порівняння суворе: у секунду `expires_at` запис уже протермінований. Ту
    // саму межу тримає TS-половина.
    match expires_at {
        None => true,
        Some(at) => now < at,
    }
}

/// Атестація провайдера чинна, поки не настав її строк **і** поки її вік не
/// перевищив дозволений політикою (FR-008a2).
///
/// Протермінована прирівнюється до відсутньої, а не до заборони: далі рішення
/// ухвалює те саме правило статусу, тож на виході буде `*_STATUS_MISSING` або
/// дозвіл із другого джерела. Наслідок, який легко втратити: вибуваючи з чинних
/// записів, вона забирає з собою і свій `denied`.
fn provider_current(status: &ProviderStatus, max_age: Option<u32>, now: i64) -> bool {
    if !is_current(status.record.expires_at, now) {
        return false;
    }
    match max_age {
        None => true,
        Some(age) => now.saturating_sub(status.issued_at) <= i64::from(age),
    }
}

fn fact(source: u8, record: &StatusRecord) -> StatusFact {
    StatusFact {
        source,
        denied: record.denied,
        tier: record.tier,
        jurisdiction: record.jurisdiction,
    }
}

fn view_party(party: &PartyContext, policy: &PolicyView, now: i64) -> PartyView {
    let mut view = PartyView::default();

    match party.provider {
        SourceState::Unavailable => view.unavailable = true,
        SourceState::Absent => {}
        SourceState::Record(status) => {
            if provider_current(&status, policy.max_attestation_age, now) {
                view.provider = Some(fact(status_source::PROVIDER, &status.record));
            }
        }
    }

    match party.register {
        SourceState::Unavailable => view.unavailable = true,
        SourceState::Absent => {}
        SourceState::Record(record) => {
            if is_current(record.expires_at, now) {
                view.register = Some(fact(status_source::REGISTER, &record));
            }
        }
    }

    view
}

// ─── Перевірки ───────────────────────────────────────────────────────────────

/// Усе, на що дивляться перевірки. Збирається один раз на переказ.
struct Subject {
    policy: PolicyView,
    ctx: TransferContext,
    sender: PartyView,
    recipient: PartyView,
}

type Check = fn(&Subject) -> bool;

/// Код відмови й перевірка, що його вмикає, у порядку перевірки.
///
/// Порядок повторює секцію 1 `ForgeError`, тобто `REFUSAL_CODES`. Тримає його не
/// дисципліна, а тест: коди в цьому масиві мусять іти від 6000 щільно й за
/// зростанням, тож переставлені перевірки падають збіркою тестів.
const CHECKS: [(ForgeError, Check); 13] = [
    (ForgeError::PolicyVersionMismatch, |s| {
        s.ctx.policy_version != s.ctx.mint_policy_version
    }),
    (ForgeError::SenderStatusMissing, |s| {
        s.sender.nothing_known()
    }),
    (ForgeError::RecipientStatusMissing, |s| {
        s.recipient.nothing_known()
    }),
    (ForgeError::StatusSourceNotAccepted, |s| {
        s.sender.only_unaccepted(s.policy.source_mask)
            || s.recipient.only_unaccepted(s.policy.source_mask)
    }),
    (ForgeError::StatusSourceUnavailable, |s| {
        s.sender.unavailable || s.recipient.unavailable
    }),
    (ForgeError::SenderDenied, |s| s.sender.denied()),
    (ForgeError::RecipientDenied, |s| s.recipient.denied()),
    (ForgeError::RecipientTierTooLow, |s| {
        s.recipient.merged_tier(s.policy.source_mask) < s.policy.min_tier
    }),
    (ForgeError::RecipientJurisdictionNotAllowed, |s| {
        match s.policy.jurisdictions {
            None => false,
            // Суворіше перемагає: збіг одного джерела не перекриває
            // розбіжність другого.
            Some(allowed) => s
                .recipient
                .accepted(s.policy.source_mask)
                .any(|fact| !jurisdiction_listed(&allowed, fact.jurisdiction)),
        }
    }),
    (ForgeError::TransferLimitExceeded, |s| {
        matches!(s.policy.transfer_limit, Some(limit) if s.ctx.amount > limit)
    }),
    (ForgeError::VelocityCounterMissing, |s| {
        s.policy.period_limit.is_some() && s.ctx.velocity.is_none()
    }),
    (ForgeError::PeriodLimitExceeded, period_exceeded),
    (ForgeError::UnknownRuleKind, |s| s.policy.unknown_kind),
];

/// Витрачене у вікні плюс сума переказу перевищує ліміт за період.
///
/// Вікно, яке вже закінчилось, дає нуль витраченого: `VelocityCounter`
/// скидається на межі вікна, і хук робить це в тій самій інструкції. Читати
/// витрачене без порівняння з початком вікна означало б рахувати позаминулий
/// тиждень у поточному ліміті.
fn period_exceeded(s: &Subject) -> bool {
    let Some((limit, window)) = s.policy.period_limit else {
        return false;
    };
    // Відсутній лічильник — це вже відмова кодом вище.
    let Some(velocity) = s.ctx.velocity else {
        return false;
    };
    let window_open = s.ctx.now < velocity.window_start.saturating_add(i64::from(window));
    let spent = if window_open { velocity.spent_in_window } else { 0 };
    // Насичення замість переповнення: сума, що не влазить у u64, безумовно
    // перевищує будь-який ліміт, і паніка в хуку була б відмовою без коду.
    spent.saturating_add(s.ctx.amount) > limit
}

/// Політика + контекст → перша перевірка, що не пройшла.
///
/// Відмова — це **перша** перевірка, що не пройшла, а не набір усіх, що не
/// пройшли: дві реалізації, які відхилили той самий переказ із різних причин,
/// розійшлися, навіть якщо обидві сказали «ні» (SC-008).
pub fn evaluate(slots: &[RuleSlot], ctx: &TransferContext) -> Result<()> {
    let policy = PolicyView::read(slots);
    let subject = Subject {
        sender: view_party(&ctx.sender, &policy, ctx.now),
        recipient: view_party(&ctx.recipient, &policy, ctx.now),
        policy,
        ctx: *ctx,
    };

    for (code, failed) in CHECKS {
        if failed(&subject) {
            return Err(error!(code));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::layout::{MAX_ATTESTATION_AGE_SECONDS, MAX_RULE_SLOTS};

    const NOW: i64 = 1_800_000_000;

    fn empty_slots() -> [RuleSlot; MAX_RULE_SLOTS] {
        [RuleSlot {
            kind: 0,
            op: 0,
            params: [0u8; RULE_PARAMS_BYTES],
        }; MAX_RULE_SLOTS]
    }

    fn slot(kind: u8, params: [u8; RULE_PARAMS_BYTES]) -> RuleSlot {
        RuleSlot {
            kind,
            op: 0,
            params,
        }
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
            params[index * 2..index * 2 + 2].copy_from_slice(code.as_bytes());
        }
        params
    }

    /// Обидва джерела, рівень не перевіряється, найдовший допустимий строк.
    fn open_policy() -> [RuleSlot; MAX_RULE_SLOTS] {
        let mut slots = empty_slots();
        slots[0] = slot(
            rule_kind::STATUS,
            status_params(status_source::ALL, 0, MAX_ATTESTATION_AGE_SECONDS),
        );
        slots
    }

    fn register_only_policy() -> [RuleSlot; MAX_RULE_SLOTS] {
        let mut slots = empty_slots();
        slots[0] = slot(
            rule_kind::STATUS,
            status_params(status_source::REGISTER, 0, 0),
        );
        slots
    }

    fn record() -> StatusRecord {
        StatusRecord {
            denied: false,
            tier: 3,
            jurisdiction: *b"NG",
            expires_at: None,
        }
    }

    fn attestation() -> ProviderStatus {
        ProviderStatus {
            record: record(),
            issued_at: NOW - 3600,
        }
    }

    const ABSENT_PARTY: PartyContext = PartyContext {
        provider: SourceState::Absent,
        register: SourceState::Absent,
    };

    /// За замовчуванням сторона має чинний запис у реєстрі й нічого в провайдера.
    fn party() -> PartyContext {
        PartyContext {
            provider: SourceState::Absent,
            register: SourceState::Record(record()),
        }
    }

    fn context() -> TransferContext {
        TransferContext {
            sender: party(),
            recipient: party(),
            amount: 1000,
            velocity: None,
            mint_policy_version: 1,
            policy_version: 1,
            now: NOW,
        }
    }

    fn verdict(slots: &[RuleSlot], ctx: &TransferContext) -> Option<u32> {
        match evaluate(slots, ctx) {
            Ok(()) => None,
            Err(anchor_lang::error::Error::AnchorError(e)) => Some(e.error_code_number),
            Err(other) => panic!("unexpected error: {other:?}"),
        }
    }

    fn code(error: ForgeError) -> Option<u32> {
        Some(u32::from(error))
    }

    /// Порядок не написаний в оцінювачі — він узятий із секції 1 `ForgeError`.
    /// Цей тест тримає обидві властивості: щільність і зростання.
    #[test]
    fn checks_follow_the_declared_order() {
        for (index, (error, _)) in CHECKS.iter().enumerate() {
            assert_eq!(
                u32::from(*error),
                anchor_lang::error::ERROR_CODE_OFFSET + index as u32,
                "check {index} is out of the declared order"
            );
        }
    }

    #[test]
    fn allows_a_transfer_that_meets_an_open_policy() {
        assert_eq!(verdict(&open_policy(), &context()), None);
    }

    #[test]
    fn names_the_first_failed_check_and_not_the_worst_one() {
        let mut slots = open_policy();
        slots[1] = slot(rule_kind::TRANSFER_LIMIT, amount_params(100, None));
        let mut ctx = context();
        ctx.policy_version = 2;
        ctx.amount = 10_000;
        ctx.sender = PartyContext {
            provider: SourceState::Absent,
            register: SourceState::Record(StatusRecord {
                denied: true,
                ..record()
            }),
        };
        assert_eq!(
            verdict(&slots, &ctx),
            code(ForgeError::PolicyVersionMismatch)
        );
    }

    #[test]
    fn reaches_every_code_it_declares() {
        // Перевірка, яку жоден переказ не вмикає, — це або мертвий код, або
        // зайвий код відмови в спільній таблиці.
        let mut version = context();
        version.policy_version = 2;
        assert_eq!(
            verdict(&open_policy(), &version),
            code(ForgeError::PolicyVersionMismatch)
        );

        let mut sender_missing = context();
        sender_missing.sender = ABSENT_PARTY;
        assert_eq!(
            verdict(&open_policy(), &sender_missing),
            code(ForgeError::SenderStatusMissing)
        );

        let mut recipient_missing = context();
        recipient_missing.recipient = ABSENT_PARTY;
        assert_eq!(
            verdict(&open_policy(), &recipient_missing),
            code(ForgeError::RecipientStatusMissing)
        );

        let mut not_accepted = context();
        not_accepted.sender = PartyContext {
            provider: SourceState::Record(attestation()),
            register: SourceState::Absent,
        };
        not_accepted.recipient = PartyContext {
            provider: SourceState::Absent,
            register: SourceState::Record(record()),
        };
        assert_eq!(
            verdict(&register_only_policy(), &not_accepted),
            code(ForgeError::StatusSourceNotAccepted)
        );

        let mut unavailable = context();
        unavailable.sender = PartyContext {
            provider: SourceState::Unavailable,
            register: SourceState::Record(record()),
        };
        assert_eq!(
            verdict(&open_policy(), &unavailable),
            code(ForgeError::StatusSourceUnavailable)
        );

        let mut sender_denied = context();
        sender_denied.sender = PartyContext {
            provider: SourceState::Absent,
            register: SourceState::Record(StatusRecord {
                denied: true,
                ..record()
            }),
        };
        assert_eq!(
            verdict(&open_policy(), &sender_denied),
            code(ForgeError::SenderDenied)
        );

        let mut recipient_denied = context();
        recipient_denied.recipient = PartyContext {
            provider: SourceState::Absent,
            register: SourceState::Record(StatusRecord {
                denied: true,
                ..record()
            }),
        };
        assert_eq!(
            verdict(&open_policy(), &recipient_denied),
            code(ForgeError::RecipientDenied)
        );

        let mut strict = open_policy();
        strict[0] = slot(
            rule_kind::STATUS,
            status_params(status_source::ALL, 5, MAX_ATTESTATION_AGE_SECONDS),
        );
        assert_eq!(
            verdict(&strict, &context()),
            code(ForgeError::RecipientTierTooLow)
        );

        let mut geo = open_policy();
        geo[1] = slot(rule_kind::JURISDICTIONS, jurisdiction_params(&["GH"]));
        assert_eq!(
            verdict(&geo, &context()),
            code(ForgeError::RecipientJurisdictionNotAllowed)
        );

        let mut capped = open_policy();
        capped[1] = slot(rule_kind::TRANSFER_LIMIT, amount_params(100, None));
        let mut over = context();
        over.amount = 101;
        assert_eq!(
            verdict(&capped, &over),
            code(ForgeError::TransferLimitExceeded)
        );

        let mut period = open_policy();
        period[1] = slot(
            rule_kind::PERIOD_LIMIT,
            amount_params(100, Some(86_400)),
        );
        assert_eq!(
            verdict(&period, &context()),
            code(ForgeError::VelocityCounterMissing)
        );

        let mut spent = context();
        spent.amount = 1;
        spent.velocity = Some(VelocityCounterView {
            window_start: NOW - 10,
            spent_in_window: 100,
        });
        assert_eq!(
            verdict(&period, &spent),
            code(ForgeError::PeriodLimitExceeded)
        );

        let mut unknown = open_policy();
        unknown[1] = slot(9, [0u8; RULE_PARAMS_BYTES]);
        assert_eq!(verdict(&unknown, &context()), code(ForgeError::UnknownRuleKind));
    }

    /// Невідомий вид правила відмовляє **останнім**: точніша причина, якщо вона
    /// є, називається першою.
    #[test]
    fn an_unknown_rule_kind_yields_to_a_reason_that_is_more_precise() {
        let mut slots = open_policy();
        slots[1] = slot(9, [0u8; RULE_PARAMS_BYTES]);
        let mut ctx = context();
        ctx.recipient = ABSENT_PARTY;
        assert_eq!(
            verdict(&slots, &ctx),
            code(ForgeError::RecipientStatusMissing)
        );
    }

    /// Політика без правила статусу не буває — і якщо все ж трапилась, дозволити
    /// не може жодне джерело.
    #[test]
    fn a_policy_without_a_status_rule_allows_nobody() {
        assert_eq!(
            verdict(&empty_slots(), &context()),
            code(ForgeError::StatusSourceNotAccepted)
        );
    }

    #[test]
    fn honours_a_denial_from_a_source_the_rule_does_not_accept() {
        // FR-008a1: `sources` називає тих, хто може дозволити; заборона діє з
        // будь-якого джерела незалежно від переліку.
        let mut ctx = context();
        ctx.sender = PartyContext {
            provider: SourceState::Record(ProviderStatus {
                record: StatusRecord {
                    denied: true,
                    ..record()
                },
                ..attestation()
            }),
            register: SourceState::Record(record()),
        };
        assert_eq!(
            verdict(&register_only_policy(), &ctx),
            code(ForgeError::SenderDenied)
        );
    }

    #[test]
    fn refuses_an_unavailable_source_even_when_the_other_one_allows() {
        // FR-013: недоступність джерела не послаблює політику.
        let mut ctx = context();
        ctx.recipient = PartyContext {
            provider: SourceState::Unavailable,
            register: SourceState::Record(record()),
        };
        assert_eq!(
            verdict(&open_policy(), &ctx),
            code(ForgeError::StatusSourceUnavailable)
        );
    }

    #[test]
    fn takes_the_lowest_tier_among_the_accepted_sources() {
        let mut strict = open_policy();
        strict[0] = slot(
            rule_kind::STATUS,
            status_params(status_source::ALL, 3, MAX_ATTESTATION_AGE_SECONDS),
        );
        let mut ctx = context();
        ctx.recipient = PartyContext {
            provider: SourceState::Record(ProviderStatus {
                record: StatusRecord { tier: 5, ..record() },
                ..attestation()
            }),
            register: SourceState::Record(StatusRecord { tier: 2, ..record() }),
        };
        assert_eq!(verdict(&strict, &ctx), code(ForgeError::RecipientTierTooLow));
    }

    #[test]
    fn refuses_when_any_accepted_source_names_a_jurisdiction_outside_the_rule() {
        let mut geo = open_policy();
        geo[1] = slot(rule_kind::JURISDICTIONS, jurisdiction_params(&["NG"]));
        let mut ctx = context();
        ctx.recipient = PartyContext {
            provider: SourceState::Record(attestation()),
            register: SourceState::Record(StatusRecord {
                jurisdiction: *b"GH",
                ..record()
            }),
        };
        assert_eq!(
            verdict(&geo, &ctx),
            code(ForgeError::RecipientJurisdictionNotAllowed)
        );
    }

    #[test]
    fn an_expired_attestation_reads_as_absent_and_not_as_a_refusal() {
        // FR-008a2: рішення далі ухвалює те саме правило статусу.
        let mut short_lived = empty_slots();
        short_lived[0] = slot(
            rule_kind::STATUS,
            status_params(status_source::PROVIDER, 0, 3600),
        );
        let provider_party = |issued_at: i64| PartyContext {
            provider: SourceState::Record(ProviderStatus {
                record: record(),
                issued_at,
            }),
            register: SourceState::Absent,
        };

        let mut stale = context();
        stale.sender = provider_party(NOW - 3601);
        stale.recipient = provider_party(NOW - 3600);
        assert_eq!(
            verdict(&short_lived, &stale),
            code(ForgeError::SenderStatusMissing)
        );

        let mut fresh = context();
        fresh.sender = provider_party(NOW - 3600);
        fresh.recipient = provider_party(NOW - 3600);
        assert_eq!(verdict(&short_lived, &fresh), None);
    }

    #[test]
    fn an_expired_record_stops_denying_along_with_everything_else() {
        // Вибуваючи з чинних записів, протермінована атестація забирає з собою
        // і свою заборону.
        let mut ctx = context();
        ctx.sender = PartyContext {
            provider: SourceState::Record(ProviderStatus {
                record: StatusRecord {
                    denied: true,
                    expires_at: Some(NOW),
                    ..record()
                },
                ..attestation()
            }),
            register: SourceState::Record(record()),
        };
        assert_eq!(verdict(&open_policy(), &ctx), None);
    }

    #[test]
    fn applies_the_record_expiry_to_the_issuer_register_too() {
        let mut ctx = context();
        ctx.sender = PartyContext {
            provider: SourceState::Absent,
            register: SourceState::Record(StatusRecord {
                expires_at: Some(NOW),
                ..record()
            }),
        };
        assert_eq!(
            verdict(&open_policy(), &ctx),
            code(ForgeError::SenderStatusMissing)
        );
    }

    #[test]
    fn allows_a_transfer_of_exactly_the_per_transfer_limit() {
        let mut capped = open_policy();
        capped[1] = slot(rule_kind::TRANSFER_LIMIT, amount_params(100, None));
        let mut ctx = context();
        ctx.amount = 100;
        assert_eq!(verdict(&capped, &ctx), None);
    }

    #[test]
    fn ignores_what_was_spent_in_a_window_that_has_already_closed() {
        let mut period = open_policy();
        period[1] = slot(rule_kind::PERIOD_LIMIT, amount_params(100, Some(86_400)));

        let mut closed = context();
        closed.amount = 100;
        closed.velocity = Some(VelocityCounterView {
            window_start: NOW - 86_400,
            spent_in_window: 100,
        });
        assert_eq!(verdict(&period, &closed), None);

        let mut open = context();
        open.amount = 1;
        open.velocity = Some(VelocityCounterView {
            window_start: NOW - 86_399,
            spent_in_window: 100,
        });
        assert_eq!(
            verdict(&period, &open),
            code(ForgeError::PeriodLimitExceeded)
        );
    }

    #[test]
    fn refuses_instead_of_overflowing_on_an_amount_that_fills_u64() {
        // Паніка в хуку була б відмовою без коду, тобто відмовою без причини.
        // Насичена сума лишається більшою за будь-який досяжний ліміт; вище за
        // `u64::MAX` не буває й самого обігу, тож насичення нікого не милує.
        let mut period = open_policy();
        period[1] = slot(rule_kind::PERIOD_LIMIT, amount_params(100, Some(86_400)));
        let mut ctx = context();
        ctx.amount = 10;
        ctx.velocity = Some(VelocityCounterView {
            window_start: NOW - 10,
            spent_in_window: u64::MAX,
        });
        assert_eq!(
            verdict(&period, &ctx),
            code(ForgeError::PeriodLimitExceeded)
        );
    }

    #[test]
    fn ignores_a_missing_counter_when_no_period_rule_asks_for_one() {
        // «Правила немає = перевірки немає»: лічильник просто не читається.
        assert_eq!(verdict(&open_policy(), &context()), None);
    }
}
