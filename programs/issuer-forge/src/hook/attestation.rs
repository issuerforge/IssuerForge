//! Reading a provider attestation from a SAS account.
//!
//! The second status source (FR-008a). The first is the issuer's own
//! registry, and it is simple: our account, our layout. Here it is
//! different: the account belongs to a foreign program, and the content of
//! its `data` field is set by a **schema**, not by the protocol.
//!
//! **The platform sets the schema, and it is fixed** — twelve bytes at the
//! start of `data`. The alternative (field offsets in `TokenConfig`) would
//! give flexibility at the price of configuration every issuer can get
//! wrong, and that would surface as a random verification tier in a real
//! transfer. A provider issuing attestations under a different schema simply
//! grants no allow — and that shows as a refusal, not as a mistaken allow.
//!
//! **The layout of the `Attestation` account itself is an assumption checked
//! at runtime.** The offsets below were taken from SAS's
//! `program/src/state/attestation.rs` and not verified against the live
//! network (spike T057 did not go there). So the parser does not trust them:
//! it checks `nonce`, `credential` and `schema` against what it already
//! knows, and on any mismatch returns `Unavailable` — i.e. a **refusal**,
//! not an allow. A wrong assumption costs an inoperable source, not a
//! transfer let through. Verification against devnet is T024.
use anchor_lang::prelude::*;

use crate::rules::evaluate::{ProviderStatus, SourceState, StatusRecord};

/// The Solana Attestation Service program.
pub const SAS_PROGRAM_ID: Pubkey = pubkey!("22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG");

/// The SAS account discriminator — one byte before the body.
const DISCRIMINATOR_LEN: usize = 1;

const NONCE_OFFSET: usize = DISCRIMINATOR_LEN;
const CREDENTIAL_OFFSET: usize = NONCE_OFFSET + 32;
const SCHEMA_OFFSET: usize = CREDENTIAL_OFFSET + 32;
/// `data: Vec<u8>` — a `u32` length, then the bytes.
const DATA_LEN_OFFSET: usize = SCHEMA_OFFSET + 32;
const DATA_OFFSET: usize = DATA_LEN_OFFSET + 4;

/// The platform schema: the first twelve bytes of `data`.
///
/// `denied` is there on purpose, even though an attestation is usually
/// revoked by deleting the account (the source then reads as `Absent`). The
/// byte lets the provider say "no" **explicitly**, without waiting for
/// someone to close the account — and under FR-008a1 such a "no" overrides
/// an allow from the issuer's registry.
const SCHEMA_TIER: usize = 0;
const SCHEMA_JURISDICTION: usize = 1;
const SCHEMA_DENIED: usize = 3;
const SCHEMA_ISSUED_AT: usize = 4;
/// How many bytes the schema requires of `data`. The rest is ignored.
pub const SCHEMA_BYTES: usize = SCHEMA_ISSUED_AT + 8;

fn pubkey_at(data: &[u8], at: usize) -> Option<Pubkey> {
    let bytes: [u8; 32] = data.get(at..at + 32)?.try_into().ok()?;
    Some(Pubkey::new_from_array(bytes))
}

fn i64_at(data: &[u8], at: usize) -> Option<i64> {
    let bytes: [u8; 8] = data.get(at..at + 8)?.try_into().ok()?;
    Some(i64::from_le_bytes(bytes))
}

fn u32_at(data: &[u8], at: usize) -> Option<u32> {
    let bytes: [u8; 4] = data.get(at..at + 4)?.try_into().ok()?;
    Some(u32::from_le_bytes(bytes))
}

/// An attestation as a status source for one party to the transfer.
///
/// Three states, and the difference between the last two is the difference
/// between two refusal codes:
/// - `Absent` — the account does not exist. The provider did not attest this
///   address; that is a normal state, and the status rule then makes the
///   decision.
/// - `Unavailable` — the account exists, but could not be read as an
///   attestation of **this** address: a foreign owner, a short body, the
///   wrong keys inside. Source unavailability does not weaken the policy
///   (FR-013).
///
/// The account address is **not re-derived** here, and that is not skimping
/// on a check. `nonce`, `credential` and `schema` are exactly the seeds SAS
/// derived the PDA from, and it is SAS that wrote them there. An account
/// owned by SAS and holding these three values inside lies at that address
/// by construction. Comparing the three keys proves the same thing as
/// `create_program_address` and does not cost 1500 CU on every transfer
/// (SC-003).
pub fn read(
    account: &AccountInfo,
    credential: &Pubkey,
    schema: &Pubkey,
    wallet: &Pubkey,
) -> SourceState<ProviderStatus> {
    // An empty account at the derived address means "no attestation". That
    // is not source unavailability: the source answered, and the answer is
    // "I did not attest this address".
    if account.data_is_empty() {
        return SourceState::Absent;
    }
    if account.owner != &SAS_PROGRAM_ID {
        return SourceState::Unavailable;
    }

    let data = account.data.borrow();
    let parsed = parse(&data, credential, schema, wallet);
    parsed.map_or(SourceState::Unavailable, SourceState::Record)
}

fn parse(
    data: &[u8],
    credential: &Pubkey,
    schema: &Pubkey,
    wallet: &Pubkey,
) -> Option<ProviderStatus> {
    // All three keys must match: each of them is a seed of the address, and a
    // mismatch means either a foreign account or a wrong layout assumption.
    if pubkey_at(data, NONCE_OFFSET)? != *wallet
        || pubkey_at(data, CREDENTIAL_OFFSET)? != *credential
        || pubkey_at(data, SCHEMA_OFFSET)? != *schema
    {
        return None;
    }

    let body_len = u32_at(data, DATA_LEN_OFFSET)? as usize;
    let body = data.get(DATA_OFFSET..DATA_OFFSET + body_len)?;
    // An attestation shorter than the schema is not "less data" but a different schema.
    if body.len() < SCHEMA_BYTES {
        return None;
    }

    // `expiry` lies **after** `data`, i.e. at a variable offset: parsing, not
    // a constant. Between them there is also `signer` (spike T057).
    let expiry = i64_at(data, DATA_OFFSET + body_len + 32)?;

    let jurisdiction: [u8; 2] = body
        .get(SCHEMA_JURISDICTION..SCHEMA_JURISDICTION + 2)?
        .try_into()
        .ok()?;

    Some(ProviderStatus {
        record: StatusRecord {
            denied: body[SCHEMA_DENIED] != 0,
            tier: body[SCHEMA_TIER],
            jurisdiction,
            // Zero reads as "no expiry" — the same convention as in the
            // issuer's registry, and it is one for both sources.
            expires_at: (expiry != 0).then_some(expiry),
        },
        issued_at: i64_at(body, SCHEMA_ISSUED_AT)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(seed: u8) -> Pubkey {
        Pubkey::new_from_array([seed; 32])
    }

    /// Builds an account **under our layout assumption**.
    ///
    /// A test on such a fixture proves that the parser is self-consistent,
    /// and does **not** prove that the assumption is right: that is checked
    /// only against the live SAS on devnet (T024). That is exactly why the
    /// parser refuses on a mismatch rather than allowing.
    fn account_bytes(
        nonce: Pubkey,
        credential: Pubkey,
        schema: Pubkey,
        body: &[u8],
        expiry: i64,
    ) -> Vec<u8> {
        let mut data = vec![0u8; DATA_OFFSET];
        data[NONCE_OFFSET..NONCE_OFFSET + 32].copy_from_slice(nonce.as_ref());
        data[CREDENTIAL_OFFSET..CREDENTIAL_OFFSET + 32].copy_from_slice(credential.as_ref());
        data[SCHEMA_OFFSET..SCHEMA_OFFSET + 32].copy_from_slice(schema.as_ref());
        data[DATA_LEN_OFFSET..DATA_LEN_OFFSET + 4].copy_from_slice(&(body.len() as u32).to_le_bytes());
        data.extend_from_slice(body);
        data.extend_from_slice(key(200).as_ref()); // signer
        data.extend_from_slice(&expiry.to_le_bytes());
        data.extend_from_slice(key(201).as_ref()); // token_account
        data
    }

    fn body(tier: u8, jurisdiction: &[u8; 2], denied: bool, issued_at: i64) -> Vec<u8> {
        let mut body = vec![0u8; SCHEMA_BYTES];
        body[SCHEMA_TIER] = tier;
        body[SCHEMA_JURISDICTION..SCHEMA_JURISDICTION + 2].copy_from_slice(jurisdiction);
        body[SCHEMA_DENIED] = u8::from(denied);
        body[SCHEMA_ISSUED_AT..SCHEMA_ISSUED_AT + 8].copy_from_slice(&issued_at.to_le_bytes());
        body
    }

    fn good() -> Vec<u8> {
        account_bytes(
            key(1),
            key(2),
            key(3),
            &body(4, b"NG", false, 1_700_000_000),
            1_900_000_000,
        )
    }

    #[test]
    fn reads_the_schema_the_platform_declares() {
        let status = parse(&good(), &key(2), &key(3), &key(1)).expect("parses");
        assert_eq!(status.record.tier, 4);
        assert_eq!(status.record.jurisdiction, *b"NG");
        assert!(!status.record.denied);
        assert_eq!(status.record.expires_at, Some(1_900_000_000));
        assert_eq!(status.issued_at, 1_700_000_000);
    }

    #[test]
    fn reads_a_zero_expiry_as_no_expiry() {
        // The same convention as in the issuer's registry, and it is one for
        // both sources.
        let data = account_bytes(key(1), key(2), key(3), &body(1, b"GH", false, 0), 0);
        let status = parse(&data, &key(2), &key(3), &key(1)).expect("parses");
        assert_eq!(status.record.expires_at, None);
    }

    #[test]
    fn refuses_an_attestation_issued_for_another_wallet() {
        assert!(parse(&good(), &key(2), &key(3), &key(9)).is_none());
    }

    #[test]
    fn refuses_another_credential_or_another_schema() {
        // A foreign provider and a foreign schema are not "a slightly different
        // status", they are no status for this token at all.
        assert!(parse(&good(), &key(9), &key(3), &key(1)).is_none());
        assert!(parse(&good(), &key(2), &key(9), &key(1)).is_none());
    }

    #[test]
    fn refuses_a_body_shorter_than_the_schema() {
        // An attestation shorter than the schema is a different schema, not less data.
        let short = account_bytes(key(1), key(2), key(3), &[0u8; 4], 0);
        assert!(parse(&short, &key(2), &key(3), &key(1)).is_none());
    }

    #[test]
    fn refuses_a_truncated_account_instead_of_reading_past_it() {
        let mut cut = good();
        cut.truncate(DATA_OFFSET + SCHEMA_BYTES);
        assert!(parse(&cut, &key(2), &key(3), &key(1)).is_none());
        assert!(parse(&[], &key(2), &key(3), &key(1)).is_none());
    }

    #[test]
    fn carries_a_denial_the_provider_states_explicitly() {
        let data = account_bytes(key(1), key(2), key(3), &body(9, b"NG", true, 1), 0);
        let status = parse(&data, &key(2), &key(3), &key(1)).expect("parses");
        assert!(status.record.denied);
    }

    #[test]
    fn ignores_bytes_the_schema_does_not_claim() {
        // The provider may put more into `data` than the schema requires; that
        // does not affect our reading.
        let mut long = body(2, b"KE", false, 5);
        long.extend_from_slice(&[0xAA; 40]);
        let data = account_bytes(key(1), key(2), key(3), &long, 0);
        let status = parse(&data, &key(2), &key(3), &key(1)).expect("parses");
        assert_eq!(status.record.tier, 2);
        assert_eq!(status.issued_at, 5);
    }
}
