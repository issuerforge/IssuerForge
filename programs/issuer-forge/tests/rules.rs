//! Диференційна звірка оцінювача правил із TS-половиною (SC-008, T019).
//!
//! Читає ті самі файли `fixtures/rules/*.json`, що й
//! `packages/policy/src/evaluate.test.ts`. Спільними є **вхід і очікуваний
//! вердикт**; жодна з двох реалізацій не є еталоном для другої.
//!
//! **Очікуваний вердикт написаний рукою з вимоги, а не знятий із реалізації.**
//! Тому тест ловить не тільки розходження двох реалізацій, а й згоду обох на
//! неправильному — а це саме та помилка, яку дубль моделі створює найлегше.
//!
//! **Звіряється чистий оцінювач `rules::evaluate`, а не хук у рантаймі.** Це
//! межа, і її треба знати: читання акаунтів, прапорець `transferring` і парсер
//! атестації SAS цим тестом не покриті — їх покриває T024 на devnet. Тут
//! звіряється модель проти моделі, тобто рівно те місце, де дві реалізації
//! розходяться найтихіше.
//!
//! **Назви кодів не мають третього дзеркала.** Очікуване порівнюється з іменем
//! варіанта `ForgeError`, переведеним із `PascalCase` у `SCREAMING_SNAKE_CASE`.
//! Таблиця «рядок → варіант» тут була б третім переліком тих самих кодів (після
//! `refusal.ts` і `ForgeError`), і розійшовся б саме він.
use std::fs;
use std::path::PathBuf;

use anchor_lang::prelude::*;
use issuer_forge::rules::evaluate::{
    evaluate, PartyContext, ProviderStatus, SourceState, StatusRecord, TransferContext,
    VelocityCounterView,
};
use issuer_forge::rules::layout::{RuleSlot, MAX_RULE_SLOTS, RULES_BYTES};
use serde_json::Value;

fn fixture_dir() -> PathBuf {
    // `CARGO_MANIFEST_DIR` — `programs/issuer-forge`; фікстури лежать у корені
    // репо, бо належать обом сторонам однаково.
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/rules")
}

fn hex_bytes(hex: &str) -> Vec<u8> {
    assert!(hex.len() % 2 == 0, "hex length must be even");
    (0..hex.len() / 2)
        .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).expect("hex digit"))
        .collect()
}

/// `PolicyVersionMismatch` → `POLICY_VERSION_MISMATCH`.
fn screaming(pascal: &str) -> String {
    let mut out = String::with_capacity(pascal.len() + 8);
    for (index, ch) in pascal.char_indices() {
        if ch.is_ascii_uppercase() && index != 0 {
            out.push('_');
        }
        out.push(ch.to_ascii_uppercase());
    }
    out
}

// ─── Розбір фікстури ─────────────────────────────────────────────────────────

fn i64_at(value: &Value, key: &str) -> i64 {
    value[key].as_i64().unwrap_or_else(|| panic!("`{key}` must be an integer"))
}

/// Суми їдуть через JSON **рядком**: u64 не влазить у double, і мовчазне
/// округлення тут зробило б фікстуру про іншу суму, ніж написано.
fn u64_at(value: &Value, key: &str) -> u64 {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("`{key}` must be a decimal string"))
        .parse()
        .expect("value fits in u64")
}

fn jurisdiction(value: &Value) -> [u8; 2] {
    let code = value["jurisdiction"].as_str().expect("jurisdiction is a string");
    let bytes = code.as_bytes();
    assert_eq!(bytes.len(), 2, "jurisdiction is an alpha-2 code");
    [bytes[0], bytes[1]]
}

fn record(value: &Value) -> StatusRecord {
    StatusRecord {
        denied: value["denied"].as_bool().expect("denied is a bool"),
        tier: u8::try_from(i64_at(value, "tier")).expect("tier fits in u8"),
        jurisdiction: jurisdiction(value),
        // `null` — «без строку», а не «протерміновано». Та сама домовленість,
        // що в TS-схемі.
        expires_at: value["expiresAt"].as_i64(),
    }
}

fn source_state<T>(value: &Value, from_record: impl Fn(&Value) -> T) -> SourceState<T> {
    match value["kind"].as_str().expect("source state has a kind") {
        "unavailable" => SourceState::Unavailable,
        "absent" => SourceState::Absent,
        "record" => SourceState::Record(from_record(&value["record"])),
        other => panic!("unknown source state `{other}`"),
    }
}

fn party(value: &Value) -> PartyContext {
    PartyContext {
        provider: source_state(&value["provider"], |record_value| ProviderStatus {
            record: record(record_value),
            issued_at: i64_at(record_value, "issuedAt"),
        }),
        register: source_state(&value["register"], record),
    }
}

fn context(value: &Value) -> TransferContext {
    let velocity = value.get("velocity").filter(|v| !v.is_null()).map(|v| VelocityCounterView {
        window_start: i64_at(v, "windowStart"),
        spent_in_window: u64_at(v, "spentInWindow"),
    });

    TransferContext {
        sender: party(&value["sender"]),
        recipient: party(&value["recipient"]),
        amount: u64_at(value, "amount"),
        velocity,
        mint_policy_version: u32::try_from(i64_at(value, "mintPolicyVersion")).expect("u32"),
        policy_version: u32::try_from(i64_at(value, "policyVersion")).expect("u32"),
        now: i64_at(value, "now"),
    }
}

fn slots(hex: &str) -> Vec<RuleSlot> {
    let bytes = hex_bytes(hex);
    assert_eq!(bytes.len(), RULES_BYTES, "policy is exactly {RULES_BYTES} bytes");
    // Вирівнювання одиничне (`repr(C)` з самих `u8`), тож зріз байтів читається
    // слотами на місці — так само, як його читає хук із даних акаунта.
    bytemuck::cast_slice::<u8, RuleSlot>(&bytes).to_vec()
}

/// Вердикт у тій самій формі, у якій його записано у фікстурі.
fn verdict(slots: &[RuleSlot], ctx: &TransferContext) -> String {
    match evaluate(slots, ctx) {
        Ok(()) => "ALLOWED".to_string(),
        Err(Error::AnchorError(error)) => screaming(&error.error_name),
        Err(other) => panic!("unexpected error kind: {other:?}"),
    }
}

fn fixtures() -> Vec<(String, Value)> {
    let mut files: Vec<PathBuf> = fs::read_dir(fixture_dir())
        .expect("fixtures/rules exists")
        .map(|entry| entry.expect("readable entry").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();

    files
        .into_iter()
        .map(|path| {
            let name = path.file_stem().expect("file stem").to_string_lossy().into_owned();
            let body = fs::read_to_string(&path).expect("fixture is readable");
            (name, serde_json::from_str(&body).expect("fixture is valid JSON"))
        })
        .collect()
}

// ─── Тести ───────────────────────────────────────────────────────────────────

#[test]
fn every_fixture_yields_the_verdict_written_in_it() {
    let cases = fixtures();
    // Та сама підлога, що й на боці TS: SC-008 просить ≥15 сценаріїв.
    assert!(cases.len() >= 15, "only {} fixtures found", cases.len());

    for (name, fixture) in cases {
        assert_eq!(
            fixture["name"].as_str(),
            Some(name.as_str()),
            "fixture `{name}` names itself differently"
        );
        // Пояснення обов'язкове: фікстура без нього — це число, яке ніхто не
        // зможе перевірити, коли модель зміниться.
        assert!(
            fixture["why"].as_str().is_some_and(|why| !why.is_empty()),
            "fixture `{name}` says nothing about why"
        );

        let expected = fixture["expect"].as_str().expect("expect is a string");
        let ctx = context(&fixture["context"]);
        let actual = verdict(&slots(fixture["rules"].as_str().expect("rules is hex")), &ctx);
        assert_eq!(actual, expected, "fixture `{name}`");
    }
}

/// Фікстура, якої **не** виражає модель TS, мусить бути в наборі: хук повертає
/// `UNKNOWN_RULE_KIND`, і саме ця половина його й перевіряє. TS-сторона в тому
/// самому файлі стверджує, що `decodeRules` на цих байтах кидає.
#[test]
fn the_unknown_rule_kind_is_covered_here_because_typescript_cannot_express_it() {
    let covered = fixtures().into_iter().any(|(_, fixture)| {
        fixture["expect"] == "UNKNOWN_RULE_KIND" && fixture["tsDecodeThrows"] == true
    });
    assert!(covered, "no fixture covers UNKNOWN_RULE_KIND");
}

/// Переведення імені варіанта в код фікстури — єдине місце, де форма назви має
/// значення. Помилка тут виглядала б як розходження реалізацій, тому вона
/// перевіряється окремо й на відомих іменах.
#[test]
fn error_names_convert_to_the_shared_spelling() {
    assert_eq!(
        screaming(issuer_forge::error::ForgeError::PolicyVersionMismatch.name().as_str()),
        "POLICY_VERSION_MISMATCH"
    );
    assert_eq!(
        screaming(issuer_forge::error::ForgeError::UnknownRuleKind.name().as_str()),
        "UNKNOWN_RULE_KIND"
    );
    assert_eq!(
        screaming(
            issuer_forge::error::ForgeError::RecipientJurisdictionNotAllowed
                .name()
                .as_str()
        ),
        "RECIPIENT_JURISDICTION_NOT_ALLOWED"
    );
}

/// Кожна фікстура зі структурованою політикою мусить нести й свої 384 байти —
/// а кожна без структури мусить пояснити, чому її там немає.
#[test]
fn fixtures_carry_the_policy_in_both_forms() {
    for (name, fixture) in fixtures() {
        let has_structure = fixture.get("policy").is_some_and(|value| !value.is_null());
        let decode_throws = fixture["tsDecodeThrows"] == true;
        assert!(
            has_structure != decode_throws,
            "fixture `{name}` must carry a readable policy or say why it cannot"
        );
        assert_eq!(
            hex_bytes(fixture["rules"].as_str().expect("rules is hex")).len(),
            RULES_BYTES
        );
    }
}

/// Зріз байтів читається рівно шістнадцятьма слотами — так само, як хук читає
/// дані акаунта. Розбіжність тут означала б, що фікстура описує іншу політику,
/// ніж та, яку перевіряє програма.
#[test]
fn the_policy_hex_maps_onto_the_slot_array() {
    let (_, fixture) = fixtures().into_iter().next().expect("at least one fixture");
    assert_eq!(slots(fixture["rules"].as_str().expect("rules is hex")).len(), MAX_RULE_SLOTS);
}
