//! Кворум 2-з-N: перевірка, що дію санкціонувала потрібна кількість
//! уповноважених гаманців (FR-019).
//!
//! **Тут кворум зібраний підписами однієї транзакції.** `ActionProposal` із
//! `propose`/`approve` і строком відкликання — це FR-019b, тобто можливість
//! зібрати підписи **в різний час**, і вона приходить із T025. Перевірка порогу
//! від цього не змінюється: T025 приносить асинхронність, а не кворум, і кличе
//! ці ж дві функції.
//!
//! Розділення на дві функції не косметичне: `check` — чиста, і саме вона несе
//! правило, тому перевіряється модульними тестами без рантайму. `approvals_from`
//! торкається `AccountInfo` і не вирішує нічого.
use anchor_lang::prelude::*;

use crate::error::ForgeError;
use crate::state::{role, IssuerConfig};

/// Ключі тих, хто підписав транзакцію, у порядку передачі.
///
/// Непідписаний акаунт відхиляється тут, а не ігнорується: акаунт у переліку
/// санкціонувальних, який нічого не підписав, — це або помилка клієнта, або
/// спроба добрати кворум чужими адресами.
pub fn approvals_from(accounts: &[AccountInfo]) -> Result<Vec<Pubkey>> {
    accounts
        .iter()
        .map(|account| {
            require!(account.is_signer, ForgeError::NotAnAuthorisingSigner);
            Ok(*account.key)
        })
        .collect()
}

/// Чи достатньо цих підписів для дії від імені емітента.
///
/// Кожен підпис мусить належати учаснику складу з роллю, що дає право
/// санкціонувати (`role::AUTHORISING`); спостерігач і атестатор у кворум не
/// рахуються ніколи. Повтор адреси відхиляється, а не згортається: інакше
/// кворум 2-з-N збирався б одним гаманцем, переданим двічі, — рівно те, що
/// міряє SC-013.
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
        // SC-013 міряє саме це: дія з одним підписом не має ончейн-ефекту.
        assert_eq!(
            err(check(&two_admins(), &[wallet(1)])),
            code(ForgeError::QuorumNotReached)
        );
        assert_eq!(err(check(&two_admins(), &[])), code(ForgeError::QuorumNotReached));
    }

    #[test]
    fn refuses_the_same_wallet_counted_twice() {
        // Інакше кворум 2-з-N збирався б одним гаманцем, переданим двічі.
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
        // Спостерігач не має права дії, атестатор не має інших повноважень
        // (FR-024) — жоден із них не добирає кворум.
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
