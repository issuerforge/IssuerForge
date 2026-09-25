//! The 2-of-N quorum: the check that an action was authorised by the
//! required number of authorised wallets (FR-019).
//!
//! **The threshold check serves two paths and does not know which.**
//! `approvals_from` reads the signatures of one transaction; `ActionProposal`
//! (T025, `state/proposal.rs`) collects addresses over days and hands them to
//! `check` as a slice. T025 brought asynchrony, not the quorum — which is
//! why nothing in this file changed when it landed.
//!
//! **`check` reads the membership as it is now, not as it was when the
//! signature was given.** On the deferred path that is the whole of FR-019a:
//! a member removed between the approval and the action stops filling the
//! quorum, and nothing has to go looking for their old approvals.
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

    /// The deferred path (T025) is this file's second caller, and the
    /// composition is what carries FR-019a: the addresses come out of an
    /// `ActionProposal` collected over days, and `check` reads the membership
    /// as it is **now**.
    mod deferred {
        use super::*;
        use crate::state::{ActionKind, ActionProposal};

        fn proposal(approvers: &[u8]) -> ActionProposal {
            let mut p = ActionProposal {
                mint: wallet(50),
                issuer: wallet(51),
                payer: wallet(52),
                nonce: 1,
                action: ActionKind::SetPolicy {
                    version: 2,
                    rules_hash: [0u8; 32],
                },
                approvals: [Pubkey::default(); MAX_MEMBERS],
                approval_count: 0,
                created_at: 1_000,
                expires_at: 10_000,
                executed_at: 0,
                bump: 253,
            };
            for seed in approvers {
                p.add_approval(wallet(*seed)).expect("within capacity");
            }
            p
        }

        #[test]
        fn signatures_given_on_different_days_fill_the_quorum() {
            assert!(check(&two_admins(), proposal(&[1, 2]).approvals()).is_ok());
        }

        #[test]
        fn one_signature_in_a_proposal_is_still_one_signature() {
            // FR-019b: an action below the quorum stays a proposal. It is the
            // same code as on the immediate path, because it is the same check.
            assert_eq!(
                err(check(&two_admins(), proposal(&[1]).approvals())),
                code(ForgeError::QuorumNotReached)
            );
        }

        #[test]
        fn a_member_removed_after_approving_stops_filling_the_quorum() {
            // The whole reason the proposal stores addresses and not a bitmap
            // over member slots: the approval is re-read against the
            // membership of the moment, so nothing has to go hunting for the
            // approvals of a wallet that was just removed.
            let collected = proposal(&[1, 2]);
            let after_removal = issuer(&[(1, role::ADMIN)], 2);
            assert_eq!(
                err(check(&after_removal, collected.approvals())),
                code(ForgeError::NotAnAuthorisingSigner)
            );
        }

        #[test]
        fn a_member_demoted_to_observer_stops_filling_the_quorum() {
            let collected = proposal(&[1, 2]);
            let demoted = issuer(&[(1, role::ADMIN), (2, role::OBSERVER)], 2);
            assert_eq!(
                err(check(&demoted, collected.approvals())),
                code(ForgeError::NotAnAuthorisingSigner)
            );
        }

        #[test]
        fn a_threshold_raised_after_the_signatures_were_given_is_the_one_that_applies() {
            let collected = proposal(&[1, 2]);
            let raised = issuer(
                &[(1, role::ADMIN), (2, role::ADMIN), (3, role::ADMIN)],
                3,
            );
            assert_eq!(
                err(check(&raised, collected.approvals())),
                code(ForgeError::QuorumNotReached)
            );
        }
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
