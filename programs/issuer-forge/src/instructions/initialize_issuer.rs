use anchor_lang::prelude::*;

use crate::constants::{ISSUER_SEED, MAX_MEMBERS, MIN_QUORUM};
use crate::error::ForgeError;
use crate::state::{delegation, role, IssuerConfig, Member};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeIssuerArgs {
    /// Незмінний ідентифікатор емітента — seed його PDA. Генерується клієнтом і
    /// нічого не підписує, тож ключем від нього володіти не обов'язково.
    pub issuer_id: Pubkey,
    /// Початковий склад: адреса й маска ролей. Порядок стає індексом у бітмапі
    /// підписів `ActionProposal`, тому зберігається як переданий.
    pub members: Vec<Member>,
    pub quorum_n: u8,
    pub operational_key: Pubkey,
    pub delegation_mask: u8,
}

#[derive(Accounts)]
#[instruction(args: InitializeIssuerArgs)]
pub struct InitializeIssuer<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + IssuerConfig::INIT_SPACE,
        seeds = [ISSUER_SEED, args.issuer_id.as_ref()],
        bump,
    )]
    pub issuer_config: Account<'info, IssuerConfig>,

    /// Хто платить оренду. Свідомо відділений від `founder`: гаманець офіцера,
    /// створений через Privy, законно має нуль SOL, і вимагати від нього
    /// платити означало б, що вхід без криптодосвіду (FR-034) не працює на
    /// першому ж кроці. Повноважень цей підпис не дає — жодна перевірка нижче
    /// його не питає.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Хто засновує. Мусить бути в складі з роллю адміністратора: емітента не
    /// можна створити від імені людей, серед яких тебе немає.
    pub founder: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeIssuer>, args: InitializeIssuerArgs) -> Result<()> {
    let members = validate_members(&args.members)?;
    validate_quorum(args.quorum_n, &members)?;
    validate_delegation(args.delegation_mask, &args.operational_key)?;

    require!(
        members
            .iter()
            .any(|m| m.wallet == ctx.accounts.founder.key() && m.has(role::ADMIN)),
        ForgeError::NotAnAdmin
    );

    let config = &mut ctx.accounts.issuer_config;
    config.issuer_id = args.issuer_id;
    config.members = [Member::default(); MAX_MEMBERS];
    for (slot, member) in members.iter().enumerate() {
        config.members[slot] = *member;
    }
    config.member_slots = members.len() as u8;
    config.quorum_n = args.quorum_n;
    config.operational_key = args.operational_key;
    config.delegation_mask = args.delegation_mask;
    config.bump = ctx.bumps.issuer_config;

    Ok(())
}

fn validate_members(members: &[Member]) -> Result<&[Member]> {
    require!(members.len() >= MIN_QUORUM as usize, ForgeError::TooFewMembers);
    require!(members.len() <= MAX_MEMBERS, ForgeError::TooManyMembers);

    for (index, member) in members.iter().enumerate() {
        require!(member.roles != 0, ForgeError::MemberWithoutRole);
        require!(member.roles & !role::ALL == 0, ForgeError::UnknownRole);

        // FR-024: ключ атестатора не може ані випустити токени, ані рухнути
        // кошти, ані змінити політику. Тут це стає перевіркою, а не обіцянкою:
        // біт атестатора несумісний із будь-яким іншим.
        if member.has(role::ATTESTOR) {
            require!(
                member.roles == role::ATTESTOR,
                ForgeError::AttestorHoldsOtherRoles
            );
        }

        // Дублікат адреси дав би одній людині два голоси в кворумі — тобто
        // кворум 2-з-N, який збирається одним підписом.
        require!(
            !members[..index].iter().any(|m| m.wallet == member.wallet),
            ForgeError::DuplicateMember
        );
    }

    Ok(members)
}

fn validate_quorum(quorum_n: u8, members: &[Member]) -> Result<()> {
    require!(quorum_n >= MIN_QUORUM, ForgeError::QuorumTooSmall);

    let authorising = members
        .iter()
        .filter(|m| m.has(role::AUTHORISING))
        .count() as u8;

    // Поріг, вищий за кількість тих, хто взагалі може підписувати, зробив би
    // вилучення й паузу неможливими назавжди — і виявилось би це в день, коли
    // емітент отримав припис.
    require!(
        quorum_n <= authorising,
        ForgeError::QuorumExceedsSigners
    );

    Ok(())
}

fn validate_delegation(mask: u8, operational_key: &Pubkey) -> Result<()> {
    require!(
        *operational_key != Pubkey::default(),
        ForgeError::MissingOperationalKey
    );
    // FR-035a: емісії, вилучення, паузи й зміни політики в масці немає й бути
    // не може. Невідомий біт — це спроба делегувати те, чого програма не вміє
    // виконувати за операційним ключем, і вона відхиляється тут, а не мовчки
    // зберігається до першої спроби скористатись.
    require!(mask & !delegation::ALL == 0, ForgeError::UndelegatablePower);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::VALIDATION_ERROR_BASE;

    fn member(seed: u8, roles: u8) -> Member {
        Member {
            wallet: Pubkey::new_from_array([seed; 32]),
            roles,
        }
    }

    fn two_admins() -> Vec<Member> {
        vec![member(1, role::ADMIN), member(2, role::ADMIN)]
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
    fn accepts_a_minimal_two_admin_issuer() {
        let members = two_admins();
        assert!(validate_members(&members).is_ok());
        assert!(validate_quorum(2, &members).is_ok());
    }

    #[test]
    fn rejects_a_single_member_issuer() {
        assert_eq!(
            err(validate_members(&[member(1, role::ADMIN)]).map(|_| ())),
            code(ForgeError::TooFewMembers)
        );
    }

    #[test]
    fn rejects_a_repeated_wallet() {
        // Одна адреса двічі — це кворум 2-з-N, що збирається одним підписом.
        let members = vec![member(1, role::ADMIN), member(1, role::COMPLIANCE)];
        assert_eq!(
            err(validate_members(&members).map(|_| ())),
            code(ForgeError::DuplicateMember)
        );
    }

    #[test]
    fn rejects_a_member_with_no_role_and_an_unknown_bit() {
        assert_eq!(
            err(validate_members(&[member(1, 0), member(2, role::ADMIN)]).map(|_| ())),
            code(ForgeError::MemberWithoutRole)
        );
        assert_eq!(
            err(validate_members(&[member(1, 1 << 6), member(2, role::ADMIN)]).map(|_| ())),
            code(ForgeError::UnknownRole)
        );
    }

    #[test]
    fn rejects_an_attestor_who_can_do_anything_else() {
        // FR-024: атестатор підтверджує резерв і більше не може нічого.
        let members = vec![
            member(1, role::ADMIN),
            member(2, role::ADMIN),
            member(3, role::ATTESTOR | role::COMPLIANCE),
        ];
        assert_eq!(
            err(validate_members(&members).map(|_| ())),
            code(ForgeError::AttestorHoldsOtherRoles)
        );
    }

    #[test]
    fn accepts_an_attestor_who_can_do_nothing_else() {
        let members = vec![
            member(1, role::ADMIN),
            member(2, role::COMPLIANCE),
            member(3, role::ATTESTOR),
        ];
        assert!(validate_members(&members).is_ok());
    }

    #[test]
    fn rejects_a_quorum_of_one() {
        // FR-019 не має режиму «одного підпису достатньо»; SC-013 міряє саме це.
        assert_eq!(
            err(validate_quorum(1, &two_admins())),
            code(ForgeError::QuorumTooSmall)
        );
    }

    #[test]
    fn rejects_a_quorum_nobody_can_reach() {
        assert_eq!(
            err(validate_quorum(3, &two_admins())),
            code(ForgeError::QuorumExceedsSigners)
        );
    }

    #[test]
    fn does_not_count_observers_or_attestors_toward_the_quorum() {
        // Спостерігач не має права дії, атестатор не має інших повноважень —
        // кворум 3 з такого складу недосяжний, хоч рядків у ньому чотири.
        let members = vec![
            member(1, role::ADMIN),
            member(2, role::COMPLIANCE),
            member(3, role::OBSERVER),
            member(4, role::ATTESTOR),
        ];
        assert!(validate_members(&members).is_ok());
        assert!(validate_quorum(2, &members).is_ok());
        assert_eq!(
            err(validate_quorum(3, &members)),
            code(ForgeError::QuorumExceedsSigners)
        );
    }

    #[test]
    fn refuses_to_delegate_a_power_that_moves_money() {
        // Біт поза `delegation::ALL` — це спроба делегувати емісію, вилучення,
        // паузу чи зміну політики. Виразити їх нічим, і саме в цьому суть.
        let key = Pubkey::new_from_array([9u8; 32]);
        assert_eq!(
            err(validate_delegation(1 << 3, &key)),
            code(ForgeError::UndelegatablePower)
        );
        assert_eq!(
            err(validate_delegation(delegation::ALL, &Pubkey::default())),
            code(ForgeError::MissingOperationalKey)
        );
        assert!(validate_delegation(delegation::ALL, &key).is_ok());
        assert!(validate_delegation(0, &key).is_ok());
    }

    #[test]
    fn error_numbering_leaves_the_refusal_range_untouched() {
        // 6000…6011 належить кодам відмови (packages/shared/src/refusal.ts).
        // Перевірки починаються за ними; розкладку самої нумерації тримає
        // `error.rs`, тут звіряється лише те, що ця інструкція в неї не залазить.
        assert_eq!(code(ForgeError::TooFewMembers), VALIDATION_ERROR_BASE);
        assert_eq!(code(ForgeError::MissingOperationalKey), VALIDATION_ERROR_BASE + 10);
    }
}
