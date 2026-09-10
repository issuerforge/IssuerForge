//! Хто може підписати рутинну дію емітента (FR-035).
//!
//! Рутинна — це дія, що не рухає чужих коштів: розморожування рахунку,
//! оновлення власного реєстру статусів, сетлмент погашення. Кворум для них не
//! потрібен (`quorum.rs` існує для іншого), але й «будь-який підпис» тут не
//! годиться.
//!
//! **Підписати може двоє: операційний ключ платформи в межах делегації або
//! уповноважений учасник складу.** Другий шлях є не для зручності: делегація
//! відкликається однією дією (FR-035b), і якби він був єдиним, відкликання
//! заморозило б онбординг назавжди — емітент утратив би здатність розморозити
//! рахунок власними руками. Ключова властивість FR-035a від цього не
//! змінюється: у масці делегації немає й не може бути жодного повноваження, що
//! рухає кошти, а другий шлях веде до гаманців самого емітента.
//!
//! T030 узагальнить це на решту інструкцій; тут — рівно те, що потрібно
//! розморожуванню й статусам.
use anchor_lang::prelude::*;

use crate::error::ForgeError;
use crate::state::{role, IssuerConfig};

/// Чи може ця адреса виконати рутинну дію з названим повноваженням.
///
/// Порядок перевірки значущий: спершу склад, потім операційний ключ. Якщо та
/// сама адреса стоїть і там, і там, вона діє як учасник — інакше емітент,
/// що поставив власний гаманець операційним ключем, утратив би свої права
/// разом із відкликанням делегації.
pub fn require_routine(issuer: &IssuerConfig, signer: &Pubkey, power: u8) -> Result<()> {
    if issuer.member_has(signer, role::AUTHORISING) {
        return Ok(());
    }

    require!(
        *signer == issuer.operational_key,
        ForgeError::NotAnOperatorOrOfficer
    );
    // Окремий код, а не той самий: «підписав не той» і «підписав той, кому цього
    // не доручали» — різні події для журналу й різні дії для того, хто читає
    // відмову.
    require!(issuer.delegates(power), ForgeError::PowerNotDelegated);
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
        // Відкликана делегація не має заморожувати онбординг назавжди.
        let revoked = issuer(&[(1, role::ADMIN), (2, role::COMPLIANCE)], wallet(10), 0);
        assert!(require_routine(&revoked, &wallet(1), delegation::THAW_HOLDER).is_ok());
        assert!(require_routine(&revoked, &wallet(2), delegation::THAW_HOLDER).is_ok());
    }

    #[test]
    fn refuses_an_observer_and_an_attestor() {
        // Спостерігач не має права дії, атестатор не має інших повноважень
        // (FR-024) — жоден із них не розморожує рахунків.
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
    fn lets_a_member_act_as_a_member_even_when_they_are_the_operational_key() {
        // Інакше емітент, що поставив власний гаманець операційним ключем,
        // утратив би свої права разом із відкликанням делегації.
        let doubled = issuer(&[(1, role::ADMIN), (2, role::COMPLIANCE)], wallet(1), 0);
        assert!(require_routine(&doubled, &wallet(1), delegation::THAW_HOLDER).is_ok());
    }
}
