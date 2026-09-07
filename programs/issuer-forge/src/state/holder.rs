use anchor_lang::prelude::*;

use crate::error::ForgeError;
use crate::rules::evaluate::{StatusRecord, VelocityCounterView};

/// Статус адреси у власному реєстрі емітента. PDA: `["holder", mint, wallet]`.
///
/// Це **одне з двох** джерел статусу (FR-008a); друге — атестація провайдера,
/// яку хук читає напряму зі спільного сервісу атестацій (спайк T057).
///
/// **Двох полів із `docs/PLAN.md` тут немає, і це свідомо:**
/// - `source` (issuer/provider) був потрібен, поки статус провайдера планували
///   дзеркалити сюди. T057 закрив це питання інакше — атестація читається
///   напряму, — тож поле означало б «джерело цього запису в реєстрі емітента
///   не емітент», чого не буває.
/// - `thawed` був би другим джерелом правди про стан, який авторитетно тримає
///   сам токен-акаунт (`DefaultAccountState`, `freeze_account`). Офіцер може
///   заморозити рахунок (T026), не торкаючись цього акаунта, і прапорець тут
///   одразу став би брехнею. Черга на розморожування (FR-008b2) живе офчейн.
///
/// Через це `flags` звівся до одного значення й лишився `bool`: бітмаска на
/// один біт — це маска, яку читають, звіряючись із коментарем.
#[account]
#[derive(InitSpace)]
pub struct HolderStatus {
    /// Обидва поля дублюють seeds навмисно: консоль і індексатор шукають
    /// холдерів через `getProgramAccounts` із фільтром за mint, а зробити такий
    /// фільтр по seeds неможливо.
    pub mint: Pubkey,
    pub wallet: Pubkey,
    /// Рівень верифікації, як його присвоїв емітент.
    pub tier: u8,
    /// Код ISO 3166-1 alpha-2 у верхньому регістрі.
    pub jurisdiction: [u8; 2],
    /// Заборона емітента. Діє **незалежно** від того, чи приймає політика це
    /// джерело (FR-008a1): власний реєстр звужує коло, дозволене провайдером, і
    /// ніколи його не розширює.
    pub denied: bool,
    /// Строк придатності запису, unix-секунди. **Нуль означає «без строку»**, а
    /// не «протерміновано»: запис без строку — дійсний стан реєстру, і саме він
    /// відрізняє реєстр від атестації, яка строк має завжди.
    pub expires_at: i64,
    /// Коли запис востаннє писали.
    ///
    /// Не декорація: **нуль тут означає «запису ще не було»**. Свіжостворений
    /// акаунт весь нульовий, а жоден справжній запис не має нульового часу
    /// блоку, тож `thaw_holder` за цим полем відрізняє перше розморожування від
    /// повторного — і не переписує статус, якого йому не доручали писати.
    pub updated_at: i64,
    pub bump: u8,
}

/// Лічильник ліміту за період. PDA: `["velocity", mint, wallet]`.
///
/// `mint` і `wallet` тут **не** дублюються, на відміну від `HolderStatus`:
/// лічильник читає тільки хук, за виведеною адресою, і жодного сканування за
/// фільтром по ньому не буває. Зайві 64 байти на кожного холдера — це оренда,
/// яку платить емітент.
#[account]
#[derive(InitSpace)]
pub struct VelocityCounter {
    /// Початок поточного вікна. Нуль означає, що вікна ще не було.
    pub window_start: i64,
    pub spent_in_window: u64,
    pub bump: u8,
}

impl HolderStatus {
    /// Запис у тій формі, у якій його читає оцінювач правил.
    ///
    /// Перетворення живе тут, в одному місці: інакше хук (T017) виводив би
    /// «нуль означає без строку» вдруге, і два прочитання того самого поля
    /// колись розійшлись би.
    pub fn record(&self) -> StatusRecord {
        StatusRecord {
            denied: self.denied,
            tier: self.tier,
            jurisdiction: self.jurisdiction,
            expires_at: (self.expires_at != 0).then_some(self.expires_at),
        }
    }

    /// Чи писали цей акаунт хоч раз.
    pub fn is_written(&self) -> bool {
        self.updated_at != 0
    }
}

impl VelocityCounter {
    pub fn view(&self) -> VelocityCounterView {
        VelocityCounterView {
            window_start: self.window_start,
            spent_in_window: self.spent_in_window,
        }
    }
}

/// Значення статусу, які приносить інструкція.
///
/// Окремий тип від акаунта: в акаунті є ще й `mint`, `wallet`, `bump` і
/// `updated_at`, і жодне з них клієнт не задає.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct HolderStatusInput {
    pub tier: u8,
    pub jurisdiction: [u8; 2],
    pub denied: bool,
    /// Нуль — без строку.
    pub expires_at: i64,
}

impl HolderStatusInput {
    pub fn validate(&self, now: i64) -> Result<()> {
        // Юрисдикція звіряється з переліком у політиці байт у байт, тож код не
        // у верхньому регістрі не «майже підходить» — він не підходить ніколи, і
        // дізнатись про це відмовою в переказі через тиждень було б дорого.
        require!(
            self.jurisdiction[0].is_ascii_uppercase() && self.jurisdiction[1].is_ascii_uppercase(),
            ForgeError::HolderJurisdictionInvalid
        );
        // Запис, протермінований у мить створення, читається як відсутній —
        // тобто дія нічого не робить, але виглядає виконаною. Відкликання
        // статусу виражається `denied`, а не строком у минулому.
        require!(
            self.expires_at == 0 || self.expires_at > now,
            ForgeError::HolderStatusAlreadyExpired
        );
        Ok(())
    }
}

impl HolderStatus {
    /// Записати значення статусу. Єдина точка запису цих полів у програмі.
    pub fn apply(&mut self, input: &HolderStatusInput, now: i64) -> Result<()> {
        input.validate(now)?;
        self.tier = input.tier;
        self.jurisdiction = input.jurisdiction;
        self.denied = input.denied;
        self.expires_at = input.expires_at;
        self.updated_at = now;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;

    fn blank() -> HolderStatus {
        HolderStatus {
            mint: Pubkey::default(),
            wallet: Pubkey::default(),
            tier: 0,
            jurisdiction: [0, 0],
            denied: false,
            expires_at: 0,
            updated_at: 0,
            bump: 254,
        }
    }

    fn input() -> HolderStatusInput {
        HolderStatusInput {
            tier: 3,
            jurisdiction: *b"NG",
            denied: false,
            expires_at: 0,
        }
    }

    fn err(result: Result<()>) -> u32 {
        match result.expect_err("expected a failure") {
            anchor_lang::error::Error::AnchorError(e) => e.error_code_number,
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn a_fresh_account_reads_as_never_written() {
        // На цьому тримається різниця між першим розморожуванням і повторним.
        assert!(!blank().is_written());
        let mut holder = blank();
        holder.apply(&input(), NOW).expect("applies");
        assert!(holder.is_written());
        assert_eq!(holder.updated_at, NOW);
    }

    #[test]
    fn zero_expiry_means_no_expiry_and_not_an_expired_record() {
        let mut holder = blank();
        holder.apply(&input(), NOW).expect("applies");
        assert_eq!(holder.record().expires_at, None);

        holder
            .apply(
                &HolderStatusInput {
                    expires_at: NOW + 3600,
                    ..input()
                },
                NOW,
            )
            .expect("applies");
        assert_eq!(holder.record().expires_at, Some(NOW + 3600));
    }

    #[test]
    fn refuses_a_jurisdiction_that_is_not_an_upper_case_iso_code() {
        let mut holder = blank();
        assert_eq!(
            err(holder.apply(
                &HolderStatusInput {
                    jurisdiction: *b"ng",
                    ..input()
                },
                NOW
            )),
            u32::from(ForgeError::HolderJurisdictionInvalid)
        );
        // Невдала перевірка не лишає наполовину записаного статусу.
        assert!(!holder.is_written());
    }

    #[test]
    fn refuses_a_record_that_is_expired_the_moment_it_is_written() {
        let mut holder = blank();
        for expires_at in [NOW, NOW - 1] {
            assert_eq!(
                err(holder.apply(
                    &HolderStatusInput {
                        expires_at,
                        ..input()
                    },
                    NOW
                )),
                u32::from(ForgeError::HolderStatusAlreadyExpired)
            );
        }
        assert!(holder
            .apply(
                &HolderStatusInput {
                    expires_at: NOW + 1,
                    ..input()
                },
                NOW
            )
            .is_ok());
    }

    #[test]
    fn carries_the_denial_into_the_record_the_evaluator_reads() {
        let mut holder = blank();
        holder
            .apply(
                &HolderStatusInput {
                    denied: true,
                    ..input()
                },
                NOW,
            )
            .expect("applies");
        let record = holder.record();
        assert!(record.denied);
        assert_eq!(record.tier, 3);
        assert_eq!(record.jurisdiction, *b"NG");
    }

    #[test]
    fn the_counter_view_carries_the_window_untouched() {
        let counter = VelocityCounter {
            window_start: NOW - 10,
            spent_in_window: 42,
            bump: 254,
        };
        assert_eq!(counter.view(), counter.view());
        assert_eq!(counter.view().window_start, NOW - 10);
        assert_eq!(counter.view().spent_in_window, 42);
    }
}
