//! Seeds and bounds shared by all the program's accounts.

/// `["issuer", issuer_id]`. `issuer_id` is a separate key generated at
/// creation; it signs nothing and never changes.
///
/// Deriving the address from the founder's wallet would be simpler, but then
/// that wallet would remain a load-bearing part forever: even after the
/// quorum removed it for being compromised, every client would need it just
/// to find the account.
pub const ISSUER_SEED: &[u8] = b"issuer";

/// `["token", mint]`.
pub const TOKEN_SEED: &[u8] = b"token";

/// `["policy", mint, version]`, the version a `u32` little-endian.
///
/// The version is in the seed, not a field that gets overwritten: every
/// version gets its own address, so the immutability of history (FR-010) is
/// guaranteed by the runtime, not by our check. The number encoding is pinned
/// on the client in `packages/chain/src/pda.ts`.
pub const POLICY_SEED: &[u8] = b"policy";

/// `["holder", mint, wallet]` — an address's status in the issuer's own registry.
pub const HOLDER_SEED: &[u8] = b"holder";

/// `["velocity", mint, wallet]` — the per-period limit counter.
pub const VELOCITY_SEED: &[u8] = b"velocity";

/// `["reserve", mint, index]` — an append-only reserve attestation, the index a `u64` LE.
pub const RESERVE_SEED: &[u8] = b"reserve";

/// `["mint", issuer_id, index]` — the token itself, the index a `u32`
/// little-endian.
///
/// The mint is a PDA, not a client key, for an arithmetic reason: a third
/// signature in the issuance transaction costs 64 bytes, and it already
/// weighs ~1180 of 1232 (the calculation is in `SCRATCHPAD.md`, block T018).
/// The consequence is better than the cause: the token address is derived
/// from the issuer and the number, so the console lists an issuer's tokens
/// without an indexer, and the client knows the address before signing.
pub const MINT_SEED: &[u8] = b"mint";

/// The number of the first policy version in seed encoding.
///
/// A constant rather than `to_le_bytes()` in place: in `create_token` this
/// seed appears in three different expressions, and three identical literals
/// would diverge quietly.
pub const FIRST_POLICY_VERSION_LE: [u8; 4] = FIRST_POLICY_VERSION.to_le_bytes();

/// The index of the first reserve attestation in seed encoding. `create_token` creates it.
pub const FIRST_ATTESTATION_INDEX_LE: [u8; 8] = 0u64.to_le_bytes();

/// The number of the first policy version. `create_token` writes it;
/// `set_policy` starts from the second, so zero here means "no token yet",
/// not "the policy is empty".
pub const FIRST_POLICY_VERSION: u32 = 1;

/// The ceiling on the authorised membership.
///
/// The number is fixed here, not in configuration: it sets both the size of
/// `IssuerConfig` and the width of the signature bitmap in `ActionProposal`.
/// Raising it after deploy means migrating every issuer's accounts.
pub const MAX_MEMBERS: usize = 8;

/// The minimum quorum. FR-019: actions with funds are executed **only** by a
/// 2-of-N quorum, so one is not a valid value here under any circumstances.
pub const MIN_QUORUM: u8 = 2;
