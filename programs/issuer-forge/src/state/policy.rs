use anchor_lang::prelude::*;

use crate::rules::layout::{self, RuleSlot, MAX_RULE_SLOTS, RULES_BYTES};

/// A policy version. PDA: `["policy", mint, version]`, the version a `u32`
/// LE.
///
/// **The immutability of history is a property of the address, not of a
/// check in code.** Every version lives at its own PDA and is created through
/// `init`, so a repeat write into an existing version is rejected by the
/// runtime, not by our logic (FR-010). There is nothing to overwrite a
/// previous version with: the program has no instruction that would open it
/// for writing.
///
/// `zero_copy`, because the hook reads `rules` on **every** transfer: Borsh
/// deserialisation of 384 bytes within the hook's CU budget would cost more
/// than the check itself. Hence `#[repr(C)]`, explicit padding to eight
/// bytes and `AccountLoader` instead of `Account` on the instruction side.
#[account(zero_copy)]
pub struct PolicyConfig {
    /// The activation time, unix seconds — half of what FR-010 requires.
    pub activated_at: i64,
    pub version: u32,
    /// The mint whose policy this version describes.
    ///
    /// Duplicates the seeds, and that is a **requirement of the hook**, not a
    /// convenience. The hook reads the policy through `AccountLoader`, and
    /// `AccountLoader` fields are not visible in `#[account(...)]`
    /// attributes, so the account can be tied to the mint either by this
    /// comparison or by `create_program_address` — and the latter costs
    /// 1500 CU on every transfer (SC-003). Thirty-two bytes per policy
    /// version are cheaper.
    pub mint: Pubkey,
    /// Who initiated the change — the first signature of the collected
    /// quorum.
    ///
    /// The named list of everyone who authorised the action (FR-019c) is
    /// deliberately not here: it belongs to the journal and `ActionProposal`
    /// (T025, T029), and sixteen addresses in every policy version would be a
    /// third mirror of the same fact.
    pub author: Pubkey,
    /// The rules in the canonical layout. `rules::layout` holds the order and the bounds.
    pub rules: [RuleSlot; MAX_RULE_SLOTS],
    /// sha256 over the whole `rules` field, computed by the program at write
    /// time.
    ///
    /// Computed here rather than accepted from the client: a hash brought by
    /// the same party that brought the bytes proves only that the client
    /// knows how to compute hashes.
    pub rules_hash: [u8; 32],
    pub bump: u8,
    /// Explicit padding to alignment 8. Without it `bytemuck::Pod` cannot be
    /// derived, and the compiler's silent padding would end up in the account
    /// hash as garbage.
    pub padding: [u8; 3],
}

/// The account size including the Anchor discriminator.
pub const POLICY_CONFIG_LEN: usize = 8 + std::mem::size_of::<PolicyConfig>();

impl PolicyConfig {
    /// Writes a policy version.
    ///
    /// The only place in the program that writes a `PolicyConfig`:
    /// `set_policy` calls it for versions from the second, and `create_token`
    /// (T018) for the first. Two writers would mean two canonicity checks,
    /// one of which would fall behind some day.
    ///
    /// The bytes go through `layout::validate` **before** the write: a policy
    /// that could not have come out of `encode` must not survive to the
    /// moment a journal record refers to its hash.
    pub fn write(
        &mut self,
        version: u32,
        mint: Pubkey,
        author: Pubkey,
        rules: &[u8],
        activated_at: i64,
        bump: u8,
    ) -> Result<()> {
        require!(
            rules.len() == RULES_BYTES,
            crate::error::ForgeError::PolicyRulesNotCanonical
        );
        let slots: &[RuleSlot] = bytemuck::cast_slice(rules);
        layout::validate(slots)?;

        self.version = version;
        self.mint = mint;
        self.author = author;
        self.activated_at = activated_at;
        self.rules.copy_from_slice(slots);
        self.rules_hash = layout::rules_hash(slots);
        self.bump = bump;
        self.padding = [0u8; 3];
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ForgeError;
    use crate::rules::layout::{rule_kind, status_source, RULE_PARAMS_BYTES};

    fn open_rules() -> Vec<u8> {
        let mut bytes = vec![0u8; RULES_BYTES];
        bytes[0] = rule_kind::STATUS;
        bytes[2] = status_source::ALL;
        bytes[4..8].copy_from_slice(&layout::MAX_ATTESTATION_AGE_SECONDS.to_le_bytes());
        bytes
    }

    fn blank() -> PolicyConfig {
        PolicyConfig {
            activated_at: 0,
            version: 0,
            mint: Pubkey::default(),
            author: Pubkey::default(),
            rules: [RuleSlot {
                kind: 0,
                op: 0,
                params: [0u8; RULE_PARAMS_BYTES],
            }; MAX_RULE_SLOTS],
            rules_hash: [0u8; 32],
            bump: 0,
            padding: [0u8; 3],
        }
    }

    fn err(result: Result<()>) -> u32 {
        match result.expect_err("expected a failure") {
            anchor_lang::error::Error::AnchorError(e) => e.error_code_number,
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn writes_the_version_its_author_and_the_hash_it_computed() {
        let mut policy = blank();
        let author = Pubkey::new_from_array([7u8; 32]);
        let mint = Pubkey::new_from_array([8u8; 32]);
        policy
            .write(2, mint, author, &open_rules(), 1_800_000_000, 254)
            .expect("writes");

        assert_eq!(policy.version, 2);
        assert_eq!(policy.mint, mint);
        assert_eq!(policy.author, author);
        assert_eq!(policy.activated_at, 1_800_000_000);
        assert_eq!(policy.bump, 254);
        assert_eq!(policy.rules_hash, layout::rules_hash(&policy.rules));
    }

    #[test]
    fn refuses_rules_that_are_not_the_size_of_the_field() {
        let mut policy = blank();
        assert_eq!(
            err(policy.write(2, Pubkey::default(), Pubkey::default(), &[0u8; 10], 0, 254)),
            u32::from(ForgeError::PolicyRulesNotCanonical)
        );
    }

    /// Canonicity is checked **before** the write: otherwise the account would
    /// be left with half of the new policy after a refusal.
    #[test]
    fn refuses_a_policy_the_encoder_could_not_have_produced() {
        let mut rules = open_rules();
        rules[1] = 1; // a non-zero reserved byte
        let mut policy = blank();
        assert_eq!(
            err(policy.write(2, Pubkey::default(), Pubkey::default(), &rules, 0, 254)),
            u32::from(ForgeError::PolicyRulesNotCanonical)
        );
        assert_eq!(policy.version, 0);
    }

    /// The account size is part of the rent bill for every policy version.
    #[test]
    fn the_account_has_no_hidden_padding() {
        assert_eq!(std::mem::size_of::<PolicyConfig>(), 496);
        assert_eq!(POLICY_CONFIG_LEN, 504);
    }
}
