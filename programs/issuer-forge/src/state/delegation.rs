//! What the issuer entrusts to the platform's operational key (FR-035,
//! FR-035a, FR-035b) — the `OperationalDelegation` of the spec.
//!
//! **Not an account of its own.** The key and the mask are two fields of
//! `IssuerConfig`, read in the same account as the membership they are
//! checked against; a separate account would be one more address in every
//! routine instruction and a second source of truth about who may act for
//! the issuer. This module is the rules about those two fields.
//!
//! **The powers are closed in code, not in configuration.** Issuance,
//! seizure, pause and policy change have no bit here and cannot be given one:
//! a compromised operational key will not get these rights even from the
//! issuer's own quorum, because there is nothing to express them with. That
//! is what makes FR-035a a check rather than a promise.
//!
//! **The operational key is never a member of the membership.** Every
//! instruction that moves funds or changes configuration asks for a role in
//! the membership or for the quorum, and the quorum counts only members. With
//! the key kept out of the membership, every one of those checks refuses it
//! by construction — there is no list of instructions that must each remember
//! to exclude it. `initialize_issuer` and `set_delegation` enforce it; a
//! future membership change (FR-019a) must enforce it too.
use anchor_lang::prelude::*;

use crate::error::ForgeError;
use crate::quorum;
use crate::state::{role, IssuerConfig, Member};

/// Thawing an account after verification (FR-008b2).
pub const THAW_HOLDER: u8 = 1 << 0;
/// Updating the issuer's own status registry (FR-008a).
pub const SET_HOLDER_STATUS: u8 = 1 << 1;
/// Settling a redemption after the corridor's confirmation (FR-029).
pub const SETTLE_REDEMPTION: u8 = 1 << 2;

pub const ALL: u8 = THAW_HOLDER | SET_HOLDER_STATUS | SETTLE_REDEMPTION;

/// Whether a delegation may be stored at all, whoever authorised it.
///
/// The membership is passed in rather than read from an `IssuerConfig`
/// because `initialize_issuer` checks a membership that has no account yet.
pub fn validate(operational_key: &Pubkey, mask: u8, members: &[Member]) -> Result<()> {
    require!(
        *operational_key != Pubkey::default(),
        ForgeError::MissingOperationalKey
    );
    // An unknown bit is an attempt to delegate something the program cannot
    // execute under the operational key, and it is refused here rather than
    // stored until the first attempt to use it.
    require!(mask & !ALL == 0, ForgeError::UndelegatablePower);
    // The platform's key holding a role would cast a vote in the quorum and
    // sign as founder or officer — everything FR-035a takes away from it.
    require!(
        !members
            .iter()
            .any(|m| !m.is_empty() && m.wallet == *operational_key),
        ForgeError::OperationalKeyIsAMember
    );
    Ok(())
}

/// Whether the change only takes powers away from the key already in place.
///
/// A rotation is never narrowing, even to an empty mask: the new key is a
/// party the issuer has not trusted before, and naming it is as much a grant
/// as a new bit.
pub fn is_narrowing(issuer: &IssuerConfig, operational_key: &Pubkey, mask: u8) -> bool {
    *operational_key == issuer.operational_key && mask & !issuer.delegation_mask == 0
}

/// Whether these signatures may make this change on the immediate path.
///
/// **Narrowing takes one admin; anything else takes the quorum.** A revocation
/// grants nobody anything — the worst a single admin can do with it is to
/// stop the platform thawing accounts, which the members can still do with
/// their own hands (`authority::require_routine`). And it is the action
/// needed in the hour a key is compromised, when waiting for a second signer
/// is the risk. A grant or a rotation hands the platform a power over the
/// issuer's holders, which is a membership-level decision (FR-035) and goes
/// through `quorum::check` like one.
///
/// Every listed signer must still be a member who may authorise, even on the
/// narrowing path: the instruction names them, and the journal must not name
/// a stranger as having revoked anything.
pub fn require_change_authorised(
    issuer: &IssuerConfig,
    approvals: &[Pubkey],
    narrowing: bool,
) -> Result<()> {
    if !narrowing {
        return quorum::check(issuer, approvals);
    }
    for (index, wallet) in approvals.iter().enumerate() {
        require!(
            issuer.member_has(wallet, role::AUTHORISING),
            ForgeError::NotAnAuthorisingSigner
        );
        require!(
            !approvals[..index].contains(wallet),
            ForgeError::DuplicateApproval
        );
    }
    require!(
        approvals.iter().any(|w| issuer.member_has(w, role::ADMIN)),
        ForgeError::NotAnAdmin
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::MAX_MEMBERS;

    fn wallet(seed: u8) -> Pubkey {
        Pubkey::new_from_array([seed; 32])
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

    const OPERATOR: u8 = 10;

    fn issuer() -> IssuerConfig {
        let mut members = [Member::default(); MAX_MEMBERS];
        for (slot, (seed, roles)) in [
            (1u8, role::ADMIN),
            (2, role::ADMIN),
            (3, role::COMPLIANCE),
            (4, role::OBSERVER),
        ]
        .into_iter()
        .enumerate()
        {
            members[slot] = Member {
                wallet: wallet(seed),
                roles,
            };
        }
        IssuerConfig {
            issuer_id: wallet(99),
            members,
            member_slots: 4,
            quorum_n: 2,
            operational_key: wallet(OPERATOR),
            delegation_mask: THAW_HOLDER | SET_HOLDER_STATUS,
            bump: 254,
            token_count: 0,
        }
    }

    #[test]
    fn refuses_an_operational_key_that_is_a_member() {
        let config = issuer();
        for seed in [1u8, 3, 4] {
            assert_eq!(
                err(validate(&wallet(seed), 0, &config.members)),
                code(ForgeError::OperationalKeyIsAMember),
                "wallet {seed}"
            );
        }
        assert!(validate(&wallet(OPERATOR), ALL, &config.members).is_ok());
    }

    #[test]
    fn an_empty_slot_does_not_make_the_default_key_a_member() {
        // The default key is refused for its own reason, before the
        // membership is consulted — the empty slots hold it too.
        assert_eq!(
            err(validate(&Pubkey::default(), 0, &issuer().members)),
            code(ForgeError::MissingOperationalKey)
        );
    }

    #[test]
    fn refuses_a_power_outside_the_closed_list() {
        for bit in 3..8 {
            assert_eq!(
                err(validate(&wallet(OPERATOR), 1 << bit, &issuer().members)),
                code(ForgeError::UndelegatablePower),
                "bit {bit}"
            );
        }
    }

    #[test]
    fn narrowing_is_dropping_bits_from_the_same_key() {
        let config = issuer();
        let key = wallet(OPERATOR);
        assert!(is_narrowing(&config, &key, THAW_HOLDER));
        assert!(is_narrowing(&config, &key, 0));
        assert!(!is_narrowing(&config, &key, ALL));
        // Swapping one bit for another is a grant of the new one.
        assert!(!is_narrowing(
            &config,
            &key,
            THAW_HOLDER | SETTLE_REDEMPTION
        ));
        // A rotation is a grant, even with nothing delegated.
        assert!(!is_narrowing(&config, &wallet(77), 0));
    }

    #[test]
    fn one_admin_narrows_and_nobody_else_does_alone() {
        let config = issuer();
        assert!(require_change_authorised(&config, &[wallet(1)], true).is_ok());
        // An officer may sign beside an admin, but not instead of one.
        assert!(require_change_authorised(&config, &[wallet(3), wallet(2)], true).is_ok());
        assert_eq!(
            err(require_change_authorised(&config, &[wallet(3)], true)),
            code(ForgeError::NotAnAdmin)
        );
        assert_eq!(
            err(require_change_authorised(&config, &[], true)),
            code(ForgeError::NotAnAdmin)
        );
        for seed in [4u8, OPERATOR, 77] {
            assert_eq!(
                err(require_change_authorised(
                    &config,
                    &[wallet(1), wallet(seed)],
                    true
                )),
                code(ForgeError::NotAnAuthorisingSigner),
                "wallet {seed}"
            );
        }
        assert_eq!(
            err(require_change_authorised(
                &config,
                &[wallet(1), wallet(1)],
                true
            )),
            code(ForgeError::DuplicateApproval)
        );
    }

    #[test]
    fn a_grant_takes_the_quorum() {
        let config = issuer();
        assert_eq!(
            err(require_change_authorised(&config, &[wallet(1)], false)),
            code(ForgeError::QuorumNotReached)
        );
        assert!(require_change_authorised(&config, &[wallet(1), wallet(3)], false).is_ok());
    }
}
