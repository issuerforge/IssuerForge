use anchor_lang::prelude::*;

use crate::rules::layout::{self, RuleSlot, MAX_RULE_SLOTS, RULES_BYTES};

/// Версія політики. PDA: `["policy", mint, version]`, версія — `u32` LE.
///
/// **Незмінність історії — властивість адреси, а не перевірки в коді.** Кожна
/// версія живе за власним PDA й створюється через `init`, тож повторний запис у
/// вже існуючу версію відхиляє рантайм, а не наша логіка (FR-010). Перезаписати
/// попередню версію нічим: інструкції, яка б відкрила її на запис, у програмі
/// немає.
///
/// `zero_copy`, бо хук читає `rules` на **кожному** переказі: десеріалізація
/// Borsh 384 байтів у CU-бюджеті хука коштувала б дорожче за саму перевірку.
/// Звідси `#[repr(C)]`, явна набивка до восьми байтів і `AccountLoader` замість
/// `Account` на боці інструкцій.
#[account(zero_copy)]
pub struct PolicyConfig {
    /// Час активації, unix-секунди — половина того, чого вимагає FR-010.
    pub activated_at: i64,
    pub version: u32,
    /// Хто ініціював зміну — перший підпис із зібраного кворуму.
    ///
    /// Поіменний склад усіх, хто санкціонував дію (FR-019c), тут не лежить
    /// навмисно: він належить журналу й `ActionProposal` (T025, T029), а
    /// шістнадцять адрес у кожній версії політики були б третім дзеркалом того
    /// самого факту.
    pub author: Pubkey,
    /// Правила у канонічній розкладці. Порядок і межі тримає `rules::layout`.
    pub rules: [RuleSlot; MAX_RULE_SLOTS],
    /// sha256 над усім полем `rules`, порахований програмою при записі.
    ///
    /// Рахується тут, а не приймається від клієнта: хеш, який приніс той самий,
    /// хто приніс байти, доводить лише те, що клієнт уміє рахувати хеші.
    pub rules_hash: [u8; 32],
    pub bump: u8,
    /// Явна набивка до вирівнювання 8. Без неї `bytemuck::Pod` не виводиться, а
    /// мовчазна набивка компілятора потрапила б у хеш акаунта як сміття.
    pub padding: [u8; 3],
}

/// Розмір акаунта з дискримінатором Anchor.
pub const POLICY_CONFIG_LEN: usize = 8 + std::mem::size_of::<PolicyConfig>();

impl PolicyConfig {
    /// Записати версію політики.
    ///
    /// Єдина точка запису `PolicyConfig` у програмі: її кличе `set_policy` для
    /// версій від другої й `create_token` (T018) для першої. Два писці означали
    /// б дві перевірки канонічності, з яких одна колись відстане.
    ///
    /// Байти проходять `layout::validate` **до** запису: політика, що не могла
    /// вийти з `encode`, не повинна доживати до того моменту, коли на її хеш
    /// пошлеться запис журналу.
    pub fn write(
        &mut self,
        version: u32,
        author: Pubkey,
        rules: &[u8],
        activated_at: i64,
        bump: u8,
    ) -> Result<()> {
        require!(
            rules.len() == RULES_BYTES,
            crate::error::ForgeError::PolicyRulesNotCanonical
        );
        let slots: &[RuleSlot] = bytemuck::cast_slice(rules);
        layout::validate(slots)?;

        self.version = version;
        self.author = author;
        self.activated_at = activated_at;
        self.rules.copy_from_slice(slots);
        self.rules_hash = layout::rules_hash(slots);
        self.bump = bump;
        self.padding = [0u8; 3];
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ForgeError;
    use crate::rules::layout::{rule_kind, status_source, RULE_PARAMS_BYTES};

    fn open_rules() -> Vec<u8> {
        let mut bytes = vec![0u8; RULES_BYTES];
        bytes[0] = rule_kind::STATUS;
        bytes[2] = status_source::ALL;
        bytes[4..8].copy_from_slice(&layout::MAX_ATTESTATION_AGE_SECONDS.to_le_bytes());
        bytes
    }

    fn blank() -> PolicyConfig {
        PolicyConfig {
            activated_at: 0,
            version: 0,
            author: Pubkey::default(),
            rules: [RuleSlot {
                kind: 0,
                op: 0,
                params: [0u8; RULE_PARAMS_BYTES],
            }; MAX_RULE_SLOTS],
            rules_hash: [0u8; 32],
            bump: 0,
            padding: [0u8; 3],
        }
    }

    fn err(result: Result<()>) -> u32 {
        match result.expect_err("expected a failure") {
            anchor_lang::error::Error::AnchorError(e) => e.error_code_number,
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn writes_the_version_its_author_and_the_hash_it_computed() {
        let mut policy = blank();
        let author = Pubkey::new_from_array([7u8; 32]);
        policy
            .write(2, author, &open_rules(), 1_800_000_000, 254)
            .expect("writes");

        assert_eq!(policy.version, 2);
        assert_eq!(policy.author, author);
        assert_eq!(policy.activated_at, 1_800_000_000);
        assert_eq!(policy.bump, 254);
        assert_eq!(policy.rules_hash, layout::rules_hash(&policy.rules));
    }

    #[test]
    fn refuses_rules_that_are_not_the_size_of_the_field() {
        let mut policy = blank();
        assert_eq!(
            err(policy.write(2, Pubkey::default(), &[0u8; 10], 0, 254)),
            u32::from(ForgeError::PolicyRulesNotCanonical)
        );
    }

    /// Канонічність перевіряється **до** запису: інакше акаунт лишався б із
    /// половиною нової політики після відмови.
    #[test]
    fn refuses_a_policy_the_encoder_could_not_have_produced() {
        let mut rules = open_rules();
        rules[1] = 1; // ненульовий зарезервований байт
        let mut policy = blank();
        assert_eq!(
            err(policy.write(2, Pubkey::default(), &rules, 0, 254)),
            u32::from(ForgeError::PolicyRulesNotCanonical)
        );
        assert_eq!(policy.version, 0);
    }

    /// Розмір акаунта — частина рахунку за оренду в кожній версії політики.
    #[test]
    fn the_account_has_no_hidden_padding() {
        assert_eq!(std::mem::size_of::<PolicyConfig>(), 464);
        assert_eq!(POLICY_CONFIG_LEN, 472);
    }
}
