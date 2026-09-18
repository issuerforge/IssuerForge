use anchor_lang::prelude::*;

use crate::state::reserve::CURRENCY_BYTES;

/// The configuration of an issued token. PDA: `["token", mint]`.
///
/// **The field order here is part of the protocol, not style.** The hook
/// receives the provider attestation account through `ExtraAccountMetaList`,
/// and its address is derived from the seeds
/// `["attestation", credential, schema, nonce]` (spike T057). Two 32-byte
/// literals never fit into a 32-byte `address_config`, so `credential` and
/// `schema` are taken as **slices of this account's data** — and the offset
/// in an `AccountData` seed is exactly one byte wide.
///
/// Hence two constraints that are now requirements on the layout:
/// - both fields must lie within the first 256 bytes of the account;
/// - their offsets are baked into the `address_config` of every
///   `ExtraAccountMetaList` already created, so inserting a new field
///   **before them** silently redirects the hook to someone else's 32 bytes.
///   The test `token_config_offsets_are_pinned` exists precisely against
///   that.
#[account]
#[derive(InitSpace)]
pub struct TokenConfig {
    pub issuer: Pubkey,
    pub mint: Pubkey,
    /// The SAS credential of the verification provider whose attestations this token accepts.
    pub attestation_credential: Pubkey,
    /// The SAS schema of those attestations.
    pub attestation_schema: Pubkey,
    /// The current reserve attestor **of this token** (FR-024b).
    ///
    /// Lives here rather than in `IssuerConfig`, despite `docs/PLAN.md`:
    /// FR-024b checks the signature against the attestor of a specific token,
    /// and an issuer with two tokens legitimately has different attestors for
    /// them.
    pub attestor: Pubkey,
    /// The platform treasury: the fee on issuance and redemption goes here (FR-038).
    pub treasury: Pubkey,
    /// The policy version the mint is configured with. A mismatch is the
    /// hook's first check and the first refusal code.
    pub policy_version: u32,
    /// The declared fee rate (FR-038a).
    pub fee_bps: u16,
    /// The attestation validity period, seconds (FR-023b).
    pub attestation_max_age: i64,
    /// A mirror of the pause state for the journal and the screens; `0` — not
    /// paused. The `Pausable` extension on the mint itself remains
    /// authoritative (FR-016).
    pub paused_at: i64,
    pub bump: u8,
    /// How many reserve attestations have been published. The next one gets
    /// exactly this index.
    ///
    /// A counter, not an amount: the attested amount and time are read from
    /// the same account the journal verifier reads (SC-006), and here lies
    /// only **which** attestation is the latest. An older attestation with a
    /// larger amount is an issuance beyond the reserve, and without the
    /// counter there is nothing to tell it from a fresh one.
    ///
    /// Appended at the end of the struct: the offsets of `credential`,
    /// `schema` and `policy_version` are baked into the `address_config` of
    /// every `ExtraAccountMetaList` created and must never move.
    pub attestation_count: u64,
    /// The reserve currency, which is also the currency of the token itself.
    ///
    /// The equality is mandatory: the check "issuance + circulation ≤
    /// attested" compares two numbers, and if they were in different
    /// currencies the comparison would require an exchange rate — which the
    /// program does not have and never will.
    pub reserve_currency: [u8; CURRENCY_BYTES],
}

/// The offset of `attestation_credential` from the start of the account,
/// including the Anchor discriminator.
///
/// `u8` on purpose: the type matches the `data_index` field of an
/// `AccountData` seed, so a field that does not fit in the first 256 bytes
/// fails to compile rather than breaking on devnet.
pub const TOKEN_CONFIG_CREDENTIAL_OFFSET: u8 = 8 + 32 + 32;

/// The offset of `attestation_schema`.
pub const TOKEN_CONFIG_SCHEMA_OFFSET: u8 = TOKEN_CONFIG_CREDENTIAL_OFFSET + 32;

/// The offset of `policy_version`.
///
/// Also addressed from seeds: `PolicyConfig` lives at
/// `["policy", mint, version]`, and the hook must get the current version
/// from this account's data rather than receive it as a number from the
/// client. The same two constraints as above: within 256 bytes and with no
/// insertions before this field.
/// Three keys: `attestation_schema` itself, then `attestor` and `treasury`.
pub const TOKEN_CONFIG_POLICY_VERSION_OFFSET: u8 = TOKEN_CONFIG_SCHEMA_OFFSET + 32 * 3;

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::AccountSerialize;

    use crate::state::reserve::currency_bytes;

    const NGN_CURRENCY: [u8; CURRENCY_BYTES] = currency_bytes(b"NGN");

    fn sample() -> TokenConfig {
        TokenConfig {
            issuer: Pubkey::new_from_array([1u8; 32]),
            mint: Pubkey::new_from_array([2u8; 32]),
            attestation_credential: Pubkey::new_from_array([3u8; 32]),
            attestation_schema: Pubkey::new_from_array([4u8; 32]),
            attestor: Pubkey::new_from_array([5u8; 32]),
            treasury: Pubkey::new_from_array([6u8; 32]),
            policy_version: 7,
            fee_bps: 12,
            attestation_max_age: 86_400,
            paused_at: 0,
            bump: 254,
            attestation_count: 0,
            reserve_currency: NGN_CURRENCY,
        }
    }

    fn serialised() -> Vec<u8> {
        let mut buffer = Vec::new();
        sample().try_serialize(&mut buffer).expect("serialises");
        buffer
    }

    /// The offsets are baked into the `address_config` of every
    /// `ExtraAccountMetaList` already created. A layout change breaks neither
    /// the build nor the hook tests — it simply starts reading someone else's
    /// 32 bytes as the credential.
    #[test]
    fn token_config_offsets_are_pinned() {
        let data = serialised();
        let credential = TOKEN_CONFIG_CREDENTIAL_OFFSET as usize;
        let schema = TOKEN_CONFIG_SCHEMA_OFFSET as usize;

        assert_eq!(&data[credential..credential + 32], &[3u8; 32]);
        assert_eq!(&data[schema..schema + 32], &[4u8; 32]);

        let version = TOKEN_CONFIG_POLICY_VERSION_OFFSET as usize;
        assert_eq!(&data[version..version + 4], &7u32.to_le_bytes());
    }

    /// The offset in an `AccountData` seed is one byte. A field beyond the
    /// 256-byte boundary is no more expressible in seeds than a literal is —
    /// i.e. not at all.
    #[test]
    fn seed_addressable_fields_stay_in_the_first_256_bytes() {
        assert!(TOKEN_CONFIG_SCHEMA_OFFSET as usize + 32 <= 256);
        assert!(TOKEN_CONFIG_POLICY_VERSION_OFFSET as usize + 4 <= 256);
    }

    #[test]
    fn declared_space_covers_the_serialised_account() {
        assert_eq!(serialised().len(), 8 + TokenConfig::INIT_SPACE);
    }
}
