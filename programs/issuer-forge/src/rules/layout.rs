//! The canonical layout of policy rules and its check at write time.
//!
//! A mirror of `packages/policy/src/layout.ts`. There `decode` rejects
//! everything `encode` could not have produced; here `validate` does the
//! same — and does it **before** the bytes land in the account. This is the
//! second lock on canonicity: the first is on the client, and the client is
//! not our program.
//!
//! Why it could not be left out: `rules_hash` names the policy, and two
//! different byte arrays with the same content would make that name the
//! name of a spelling rather than of the policy — exactly at the moment a
//! journal line refers to it.
//!
//! The rule evaluator (T015) reads these same slots on every transfer and
//! sits beside this, in `rules/`. Here there is only shape and bounds, with
//! no decision about a transfer.
use anchor_lang::prelude::*;
use solana_sha256_hasher::hash;

use crate::error::ForgeError;

/// Slots in `PolicyConfig.rules`. Fixed for zero-copy reading in the hook.
pub const MAX_RULE_SLOTS: usize = 16;

/// Bytes per slot: `kind`, `op`, `params`.
pub const RULE_SLOT_BYTES: usize = 24;

/// Parameter bytes in a slot — this budget is what limits every rule.
pub const RULE_PARAMS_BYTES: usize = 22;

/// The full size of the `rules` field.
pub const RULES_BYTES: usize = MAX_RULE_SLOTS * RULE_SLOT_BYTES;

/// Rule kind codes. Zero is reserved for an empty slot: a fixed-length array
/// always has a tail of zeros, and a rule kind with code 0 would turn that
/// tail into sixteen silent rules.
pub mod rule_kind {
    pub const EMPTY: u8 = 0;
    pub const STATUS: u8 = 1;
    pub const JURISDICTIONS: u8 = 2;
    pub const TRANSFER_LIMIT: u8 = 3;
    pub const PERIOD_LIMIT: u8 = 4;
}

/// The bit values of the status sources — a mirror of `STATUS_SOURCE` in `model.ts`.
pub mod status_source {
    pub const PROVIDER: u8 = 1 << 0;
    pub const REGISTER: u8 = 1 << 1;
    pub const ALL: u8 = PROVIDER | REGISTER;
}

/// The second byte of a slot stays zero and **is checked**: otherwise it
/// becomes a silent channel into which something gets in and changes
/// `rules_hash` without changing anything in the content. A new parameter
/// encoding is a new `kind`, not a new value here.
pub const RULE_OP_RESERVED: u8 = 0;

/// Jurisdictions in one rule: an ISO alpha-2 code is two bytes, the parameters are 22.
pub const MAX_JURISDICTIONS: usize = RULE_PARAMS_BYTES / 2;

pub const MIN_PERIOD_SECONDS: u32 = 3_600;
pub const MAX_PERIOD_SECONDS: u32 = 31 * 24 * 3_600;
pub const MIN_ATTESTATION_AGE_SECONDS: u32 = 3_600;
pub const MAX_ATTESTATION_AGE_SECONDS: u32 = 365 * 24 * 3_600;

/// One rule slot, as it lies in the account.
#[zero_copy]
pub struct RuleSlot {
    pub kind: u8,
    pub op: u8,
    pub params: [u8; RULE_PARAMS_BYTES],
}

/// The canonicity check of the whole slot array.
///
/// Rejects everything `encode` on the TS side could not have produced:
/// non-zero padding of an empty slot, a gap between rules, a non-zero `op`,
/// an order not ascending by `kind` (which also catches duplicates), an
/// unknown rule kind and parameters outside the model's bounds. None of
/// these changes what the policy means — and every one changes its hash.
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
            // An empty slot must be entirely empty.
            require!(
                slot.op == 0 && slot.params.iter().all(|byte| *byte == 0),
                ForgeError::PolicyRulesNotCanonical
            );
            ended = true;
            continue;
        }

        // A gap between rules would give two encodings of one policy.
        require!(!ended, ForgeError::PolicyRulesNotCanonical);
        require!(
            slot.op == RULE_OP_RESERVED,
            ForgeError::PolicyRulesNotCanonical
        );
        // Strictly ascending: the same comparison also drops duplicates.
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
            // An unknown rule kind is a refusal, not a skip: a policy the reader
            // does not fully understand does not get weaker silently. The same
            // principle as FR-013 about an unavailable status source.
            _ => return err!(ForgeError::PolicyRuleKindUnknown),
        }
    }

    // A policy without an answer to "who may hold" is impossible under the
    // model; FR-008b1 requires a continuous check, not a one-off thaw.
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
    // An empty mask is "allow no one", and an unknown bit is a source the
    // reader does not know: it can be neither executed nor skipped.
    require!(
        mask != 0 && mask & !status_source::ALL == 0,
        ForgeError::PolicyRuleParamsOutOfRange
    );

    // params[1] is the minimum tier; the tier ceiling is the byte ceiling, so
    // any value is valid, and there is no ground to invent a product bound
    // here.
    let max_age = u32_at(params, 2);
    // Zero means "no validity period": the model allows no value below an
    // hour, so zero is not a valid period and reads unambiguously.
    require!(
        max_age == 0
            || (MIN_ATTESTATION_AGE_SECONDS..=MAX_ATTESTATION_AGE_SECONDS).contains(&max_age),
        ForgeError::PolicyRuleParamsOutOfRange
    );
    // FR-008a2: a policy that accepts provider attestations and does not name
    // their validity period is a verification done once and valid forever.
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
        // Strictly ascending — the same determinism as in the slot order: a set
        // of countries has no order, and the policy hash must be identical for
        // identical content. Duplicates are dropped by the same comparison.
        require!(
            count == 0 || code > previous,
            ForgeError::PolicyRulesNotCanonical
        );
        previous = code;
        count += 1;
    }

    // An empty list is not a way to say "all": no rule — no check, and there
    // must be no second way of saying the same thing.
    require!(count > 0, ForgeError::PolicyRuleParamsOutOfRange);
    Ok(())
}

fn validate_transfer_limit(params: &[u8; RULE_PARAMS_BYTES]) -> Result<()> {
    // A zero limit refuses every transfer — that is not a limit but a halt of
    // circulation, for which a pause exists.
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

/// `rules_hash` — sha256 over all sixteen slots, as they lie in the account.
///
/// sha256 and not something else, because the program itself computes it
/// with a native syscall: one call per policy change and none on a transfer.
/// The hash is computed over the **whole** field, not the filled part: the
/// independent verifier (SC-006) takes a slice of the account data and
/// hashes it without knowing how many slots are in use.
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
            // An empty string leaves a pair of zeros — that is how a gap inside
            // the list is written in a test.
            if code.len() == 2 {
                params[index * 2..index * 2 + 2].copy_from_slice(code.as_bytes());
            }
        }
        params
    }

    /// The weakest policy the model allows to be written: both sources, the
    /// tier is not checked, the attestation is given the longest allowed
    /// validity.
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
        // An empty policy fails with the same code: there are slots, there is no status.
        assert_eq!(
            err(validate(&empty_slots())),
            code(ForgeError::PolicyStatusRuleMissing)
        );
    }

    #[test]
    fn refuses_a_rule_kind_it_does_not_define() {
        // This is the second lock on canonicity from T012: the first is on the
        // client, and the client is not our program.
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
        // Non-zero padding of an empty slot.
        let mut padded = open_policy();
        padded[5].params[7] = 1;
        assert_eq!(
            err(validate(&padded)),
            code(ForgeError::PolicyRulesNotCanonical)
        );

        // A non-zero reserved byte.
        let mut op = open_policy();
        op[0].op = 1;
        assert_eq!(
            err(validate(&op)),
            code(ForgeError::PolicyRulesNotCanonical)
        );

        // Padding inside a rule's parameters.
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
        // FR-008a2 exists precisely against a verification done once and valid
        // forever.
        let mut slots = open_policy();
        slots[0].params = status_params(status_source::PROVIDER, 0, 0);
        assert_eq!(
            err(validate(&slots)),
            code(ForgeError::PolicyRuleParamsOutOfRange)
        );

        // Without the provider among the sources no validity period is needed.
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
        // A zero limit is a halt of circulation, for which a pause exists.
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
        // Two policies differing only in one filled slot must have different
        // hashes; the hash is taken over all 384 bytes, so the input length is
        // constant.
        assert_ne!(rules_hash(&open_policy()), rules_hash(&full_policy()));
        assert_eq!(bytemuck::cast_slice::<RuleSlot, u8>(&open_policy()).len(), RULES_BYTES);
    }

    /// Two implementations compute the hash: this one and `rulesHash` in
    /// `packages/policy`. The vector below was taken from TS and hardcoded
    /// here as a number — a divergence must fail a test, not surface as a
    /// mismatched policy name in the journal.
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
