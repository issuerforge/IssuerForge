//! Who may sign a routine issuer action (FR-035).
//!
//! Routine means an action that moves no one else's funds: thawing an
//! account, updating the issuer's own status registry, settling a
//! redemption. No quorum is needed for them (`quorum.rs` exists for something
//! else), but "any signature" will not do here either.
//!
//! **Two may sign: the platform's operational key within its delegation, or
//! an authorised member of the membership.** The second path is not there
//! for convenience: a delegation is revoked with one action (FR-035b), and
//! if the first path were the only one, a revocation would freeze onboarding
//! forever — the issuer would lose the ability to thaw an account with its
//! own hands. The key property of FR-035a does not change because of this:
//! the delegation mask has no power that moves funds and cannot have one,
//! and the second path leads to the issuer's own wallets.
//!
//! **Every other instruction refuses the operational key without asking about
//! it** (T030). They all ask for a role in the membership or for the quorum,
//! and the key is never a member (`state::delegation`), so there is no
//! per-instruction exclusion to forget. This file is where the key is
//! *accepted*, and only here.
use anchor_lang::prelude::*;

use crate::error::ForgeError;
use crate::state::{role, IssuerConfig};

/// Whether this address may perform a routine action with the named power.
///
/// The membership is asked first only because it is the common case; the
/// order decides nothing, since the operational key is never a member.
pub fn require_routine(issuer: &IssuerConfig, signer: &Pubkey, power: u8) -> Result<()> {
    if issuer.member_has(signer, role::AUTHORISING) {
        return Ok(());
    }

    require!(
        *signer == issuer.operational_key,
        ForgeError::NotAnOperatorOrOfficer
    );
    // A separate code, not the same one: "the wrong one signed" and "the one
    // who signed was not entrusted with this" are different events for the
    // journal and different actions for whoever reads the refusal.
    require!(issuer.delegates(power), ForgeError::PowerNotDelegated);
    Ok(())
}

/// Whether this address may freeze or unfreeze an account (FR-014).
///
/// **The officer alone, and nobody else.** Not the operational key: FR-035
/// names what it may sign, and a freeze is not on the list — a compromised
/// platform key must not be able to freeze an issuer's holders either. Not an
/// admin: FR-033 separates the roles, and a freeze is the one compliance
/// action a single officer takes without the quorum, which is exactly why it
/// stays with the role that answers for it. An issuer without an officer adds
/// one through the quorum; that is a membership change, not a gap here.
pub fn require_officer(issuer: &IssuerConfig, signer: &Pubkey) -> Result<()> {
    require!(
        issuer.member_has(signer, role::COMPLIANCE),
        ForgeError::NotAnOfficer
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::MAX_MEMBERS;
    use crate::state::{delegation, Member};

    fn wallet(seed: u8) -> Pubkey {
        Pubkey::new_from_array([seed; 32])
    }

    fn issuer(members: &[(u8, u8)], operational_key: Pubkey, mask: u8) -> IssuerConfig {
        let mut config = IssuerConfig {
            issuer_id: wallet(99),
            members: [Member::default(); MAX_MEMBERS],
            member_slots: members.len() as u8,
            quorum_n: 2,
            operational_key,
            delegation_mask: mask,
            bump: 254,
            token_count: 0,
        };
        for (slot, (seed, roles)) in members.iter().enumerate() {
            config.members[slot] = Member {
                wallet: wallet(*seed),
                roles: *roles,
            };
        }
        config
    }

    fn standard() -> IssuerConfig {
        issuer(
            &[
                (1, role::ADMIN),
                (2, role::COMPLIANCE),
                (3, role::OBSERVER),
                (4, role::ATTESTOR),
            ],
            wallet(10),
            delegation::THAW_HOLDER,
        )
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
    fn accepts_the_operational_key_within_its_delegation() {
        assert!(require_routine(&standard(), &wallet(10), delegation::THAW_HOLDER).is_ok());
    }

    #[test]
    fn refuses_the_operational_key_beyond_its_delegation() {
        assert_eq!(
            err(require_routine(
                &standard(),
                &wallet(10),
                delegation::SET_HOLDER_STATUS
            )),
            code(ForgeError::PowerNotDelegated)
        );
    }

    #[test]
    fn accepts_an_officer_and_an_admin_whatever_the_delegation_says() {
        // A revoked delegation must not freeze onboarding forever.
        let revoked = issuer(&[(1, role::ADMIN), (2, role::COMPLIANCE)], wallet(10), 0);
        assert!(require_routine(&revoked, &wallet(1), delegation::THAW_HOLDER).is_ok());
        assert!(require_routine(&revoked, &wallet(2), delegation::THAW_HOLDER).is_ok());
    }

    #[test]
    fn refuses_an_observer_and_an_attestor() {
        // An observer has no right to act, an attestor has no other powers
        // (FR-024) — neither of them thaws accounts.
        for seed in [3u8, 4] {
            assert_eq!(
                err(require_routine(&standard(), &wallet(seed), delegation::THAW_HOLDER)),
                code(ForgeError::NotAnOperatorOrOfficer)
            );
        }
    }

    #[test]
    fn refuses_a_stranger() {
        assert_eq!(
            err(require_routine(&standard(), &wallet(77), delegation::THAW_HOLDER)),
            code(ForgeError::NotAnOperatorOrOfficer)
        );
    }

    #[test]
    fn only_an_officer_freezes() {
        let full = issuer(
            &[
                (1, role::ADMIN),
                (2, role::COMPLIANCE),
                (3, role::OBSERVER),
                (4, role::ATTESTOR),
                (5, role::ADMIN | role::COMPLIANCE),
            ],
            wallet(10),
            delegation::ALL,
        );
        assert!(require_officer(&full, &wallet(2)).is_ok());
        assert!(require_officer(&full, &wallet(5)).is_ok());
        // An admin, an observer, an attestor, the operational key with every
        // power delegated, a stranger.
        for seed in [1u8, 3, 4, 10, 77] {
            assert_eq!(
                err(require_officer(&full, &wallet(seed))),
                code(ForgeError::NotAnOfficer),
                "wallet {seed}"
            );
        }
    }
}
