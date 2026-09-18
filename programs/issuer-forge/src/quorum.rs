//! The 2-of-N quorum: the check that an action was authorised by the
//! required number of authorised wallets (FR-019).
//!
//! **Here the quorum is collected from the signatures of one transaction.**
//! `ActionProposal` with `propose`/`approve` and a revocation period is
//! FR-019b, i.e. the ability to collect signatures **at different times**,
//! and it arrives with T025. The threshold check does not change because of
//! that: T025 brings asynchrony, not the quorum, and calls these same two
//! functions.
//!
//! The split into two functions is not cosmetic: `check` is pure, and it is
//! what carries the rule, so it is tested with unit tests without a runtime.
//! `approvals_from` touches `AccountInfo` and decides nothing.
use anchor_lang::prelude::*;

use crate::error::ForgeError;
use crate::state::{role, IssuerConfig};

/// The keys of those who signed the transaction, in the order passed.
///
/// An unsigned account is rejected here, not ignored: an account in the
/// authorising list that signed nothing is either a client mistake or an
/// attempt to fill the quorum with someone else's addresses.
pub fn approvals_from(accounts: &[AccountInfo]) -> Result<Vec<Pubkey>> {
    accounts
        .iter()
        .map(|account| {
            require!(account.is_signer, ForgeError::NotAnAuthorisingSigner);
            Ok(*account.key)
        })
        .collect()
}

/// Whether these signatures are enough for an action on the issuer's behalf.
///
/// Every signature must belong to a member of the membership with a role that
/// grants the right to authorise (`role::AUTHORISING`); an observer and an
/// attestor never count towards the quorum. A repeated address is rejected,
/// not collapsed: otherwise a 2-of-N quorum would be collected with one
/// wallet passed twice — exactly what SC-013 measures.
pub fn check(issuer: &IssuerConfig, approvals: &[Pubkey]) -> Result<()> {
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
        approvals.len() >= issuer.quorum_n as usize,
        ForgeError::QuorumNotReached
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::MAX_MEMBERS;
    use crate::state::Member;

    fn wallet(seed: u8) -> Pubkey {
        Pubkey::new_from_array([seed; 32])
    }

    fn issuer(members: &[(u8, u8)], quorum_n: u8) -> IssuerConfig {
        let mut config = IssuerConfig {
            issuer_id: wallet(99),
            members: [Member::default(); MAX_MEMBERS],
            member_slots: members.len() as u8,
            quorum_n,
            operational_key: wallet(98),
            delegation_mask: 0,
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

    fn two_admins() -> IssuerConfig {
        issuer(&[(1, role::ADMIN), (2, role::ADMIN)], 2)
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
    fn accepts_the_threshold_the_issuer_set() {
        assert!(check(&two_admins(), &[wallet(1), wallet(2)]).is_ok());
    }

    #[test]
    fn refuses_one_signature_out_of_two() {
        // SC-013 measures exactly this: an action with one signature has no on-chain effect.
        assert_eq!(
            err(check(&two_admins(), &[wallet(1)])),
            code(ForgeError::QuorumNotReached)
        );
        assert_eq!(err(check(&two_admins(), &[])), code(ForgeError::QuorumNotReached));
    }

    #[test]
    fn refuses_the_same_wallet_counted_twice() {
        // Otherwise a 2-of-N quorum would be collected with one wallet passed twice.
        assert_eq!(
            err(check(&two_admins(), &[wallet(1), wallet(1)])),
            code(ForgeError::DuplicateApproval)
        );
    }

    #[test]
    fn refuses_a_signer_who_is_not_in_the_member_list() {
        assert_eq!(
            err(check(&two_admins(), &[wallet(1), wallet(5)])),
            code(ForgeError::NotAnAuthorisingSigner)
        );
    }

    #[test]
    fn does_not_count_observers_or_attestors() {
        // An observer has no right to act, an attestor has no other powers
        // (FR-024) — neither of them fills the quorum.
        let config = issuer(
            &[
                (1, role::ADMIN),
                (2, role::OBSERVER),
                (3, role::ATTESTOR),
                (4, role::COMPLIANCE),
            ],
            2,
        );
        assert_eq!(
            err(check(&config, &[wallet(1), wallet(2)])),
            code(ForgeError::NotAnAuthorisingSigner)
        );
        assert_eq!(
            err(check(&config, &[wallet(1), wallet(3)])),
            code(ForgeError::NotAnAuthorisingSigner)
        );
        assert!(check(&config, &[wallet(1), wallet(4)]).is_ok());
    }

    #[test]
    fn accepts_more_signatures_than_the_threshold() {
        let config = issuer(
            &[(1, role::ADMIN), (2, role::ADMIN), (3, role::COMPLIANCE)],
            2,
        );
        assert!(check(&config, &[wallet(1), wallet(2), wallet(3)]).is_ok());
    }
}
