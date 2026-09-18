//! The differential comparison of the rule evaluator with the TS half
//! (SC-008, T019).
//!
//! Reads the same `fixtures/rules/*.json` files as
//! `packages/policy/src/evaluate.test.ts`. What is shared is **the input and
//! the expected verdict**; neither of the two implementations is the
//! reference for the other.
//!
//! **The expected verdict is written by hand from the requirement, not taken
//! from the implementation.** So the test catches not only a divergence
//! between the two implementations but also both agreeing on the wrong
//! thing — and that is exactly the mistake a duplicated model creates most
//! easily.
//!
//! **What is compared is the pure evaluator `rules::evaluate`, not the hook
//! at runtime.** That is a boundary, and it has to be known: reading
//! accounts, the `transferring` flag and the SAS attestation parser are not
//! covered by this test — T024 covers them on devnet. Here the model is
//! compared with the model, i.e. exactly the place where two implementations
//! diverge most quietly.
//!
//! **The code names have no third mirror.** The expected value is compared
//! with the `ForgeError` variant name converted from `PascalCase` to
//! `SCREAMING_SNAKE_CASE`. A "string → variant" table here would be a third
//! list of the same codes (after `refusal.ts` and `ForgeError`), and it is
//! the one that would diverge.
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
    // `CARGO_MANIFEST_DIR` is `programs/issuer-forge`; the fixtures live at
    // the repository root because they belong to both sides equally.
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

// ─── Fixture parsing ─────────────────────────────────────────────────────────

fn i64_at(value: &Value, key: &str) -> i64 {
    value[key].as_i64().unwrap_or_else(|| panic!("`{key}` must be an integer"))
}

/// Amounts travel through JSON as a **string**: a u64 does not fit in a
/// double, and silent rounding here would make the fixture about a different
/// amount than written.
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
        // `null` is "no expiry", not "expired". The same convention as in the
        // TS schema.
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
    // The alignment is one (`repr(C)` of nothing but `u8`), so the byte slice
    // is read as slots in place — the same way the hook reads it from the
    // account data.
    bytemuck::cast_slice::<u8, RuleSlot>(&bytes).to_vec()
}

/// The verdict in the same shape it is written in the fixture.
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

// ─── Tests ───────────────────────────────────────────────────────────────────

#[test]
fn every_fixture_yields_the_verdict_written_in_it() {
    let cases = fixtures();
    // The same floor as on the TS side: SC-008 asks for ≥15 scenarios.
    assert!(cases.len() >= 15, "only {} fixtures found", cases.len());

    for (name, fixture) in cases {
        assert_eq!(
            fixture["name"].as_str(),
            Some(name.as_str()),
            "fixture `{name}` names itself differently"
        );
        // The explanation is mandatory: a fixture without one is a number
        // nobody will be able to verify when the model changes.
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

/// A fixture the TS model does **not** express must be in the set: the hook
/// returns `UNKNOWN_RULE_KIND`, and this half is the one that checks it. The
/// TS side asserts in the same file that `decodeRules` throws on these bytes.
#[test]
fn the_unknown_rule_kind_is_covered_here_because_typescript_cannot_express_it() {
    let covered = fixtures().into_iter().any(|(_, fixture)| {
        fixture["expect"] == "UNKNOWN_RULE_KIND" && fixture["tsDecodeThrows"] == true
    });
    assert!(covered, "no fixture covers UNKNOWN_RULE_KIND");
}

/// Converting a variant name into a fixture code is the only place where the
/// shape of the name matters. A mistake here would look like an
/// implementation divergence, so it is checked separately and on known
/// names.
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

/// Every fixture with a structured policy must also carry its 384 bytes —
/// and every one without a structure must explain why it is absent.
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

/// The byte slice is read as exactly sixteen slots — the same way the hook
/// reads the account data. A mismatch here would mean the fixture describes
/// a different policy from the one the program checks.
#[test]
fn the_policy_hex_maps_onto_the_slot_array() {
    let (_, fixture) = fixtures().into_iter().next().expect("at least one fixture");
    assert_eq!(slots(fixture["rules"].as_str().expect("rules is hex")).len(), MAX_RULE_SLOTS);
}
