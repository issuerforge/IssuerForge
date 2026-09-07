import { z } from 'zod'

/**
 * Коди відмови в переказі (FR-011). Джерело правди для трьох споживачів:
 * TS-оцінювача в майстрі (`packages/policy`), індексатора логів (`apps/worker`)
 * і незалежного верифікатора журналу (`tools/verify-journal`, SC-006). Rust-хук
 * тримає дзеркало — див. `REFUSAL_TABLE` нижче.
 *
 * Порядок перелічення повторює порядок перевірок у хуку (`docs/PLAN.md` →
 * «Порядок перевірок у хуку»): відмова — це **перша** перевірка, що не пройшла,
 * а не набір усіх, що не пройшли. Тому порядок тут значущий, і диференційні
 * тести (SC-008) звіряють саме його: дві реалізації, які відхиляють той самий
 * переказ із різних причин, розійшлися, навіть якщо обидві сказали «ні».
 */
export const REFUSAL_CODES = [
  'POLICY_VERSION_MISMATCH',
  'SENDER_STATUS_MISSING',
  'RECIPIENT_STATUS_MISSING',
  'STATUS_SOURCE_NOT_ACCEPTED',
  'STATUS_SOURCE_UNAVAILABLE',
  'SENDER_DENIED',
  'RECIPIENT_DENIED',
  'RECIPIENT_TIER_TOO_LOW',
  'RECIPIENT_JURISDICTION_NOT_ALLOWED',
  'TRANSFER_LIMIT_EXCEEDED',
  'VELOCITY_COUNTER_MISSING',
  'PERIOD_LIMIT_EXCEEDED',
  'UNKNOWN_RULE_KIND',
  'TRANSFERS_PAUSED',
  'ACCOUNT_FROZEN',
] as const

export type RefusalCode = (typeof REFUSAL_CODES)[number]

export const refusalCodeSchema = z.enum(REFUSAL_CODES)

/**
 * Хто саме відхилив переказ.
 *
 * `token-program` — не деталь реалізації, а межа відповідальності: паузу й
 * заморозку рахунку виконує розширення Token-2022 (`Pausable`,
 * `DefaultAccountState`), і такий переказ падає **до** того, як токен-програма
 * покличе наш хук. Наш код цих двох кодів не повертає ніколи; індексатор
 * дізнається про них із помилки токен-програми.
 */
export type RefusalSource = 'hook' | 'token-program'

type RefusalMeta = {
  /**
   * Позиція у Rust-переліку помилок хука, або `null`, якщо хук цього коду не
   * повертає. Anchor нумерує власні помилки з `ANCHOR_ERROR_OFFSET`, тож саме
   * ця позиція, а не назва, приїжджає в логах транзакції.
   */
  hookIndex: number | null
  source: RefusalSource
}

/**
 * Таблиця, яку дзеркалить `ForgeError` у `programs/issuer-forge/src/error.rs`:
 * там ці ж коди стоять **першими** в переліку, тож `hookIndex` збігається з
 * порядковим номером варіанта, а `6000 + hookIndex` — із кодом, який приїжджає
 * в логах. Розвести два переліки зсувом не можна: `#[error_code(offset = …)]`
 * діє тільки в рантаймі, а генератор IDL хардкодить `6000 + index`.
 *
 * Дзеркало неминуче: Anchor вимагає перелік помилок у Rust, а індексатор і
 * верифікатор живуть у TS. Тому воно зроблене явним і числовим — тест звіряє,
 * що індекси щільні й унікальні, а `refusal_codes_match_the_shared_table` у
 * програмі звіряє, що Rust-перелік дає ті самі числа. Мовчазне розходження тут
 * коштувало б неправильної причини відмови в журналі, тобто неправильної
 * відповіді регулятору.
 */
export const REFUSAL_TABLE = {
  /** Політика, на яку налаштований mint, не та, що передана в переказі. */
  POLICY_VERSION_MISMATCH: { hookIndex: 0, source: 'hook' },
  /**
   * Акаунта статусу немає. Хук не створює акаунтів — ані payer, ані підпису
   * system program у нього немає, — тож відсутність акаунта означає відмову,
   * а не пропуск перевірки (FR-013).
   */
  SENDER_STATUS_MISSING: { hookIndex: 1, source: 'hook' },
  RECIPIENT_STATUS_MISSING: { hookIndex: 2, source: 'hook' },
  /** Статус є, але з джерела, якого це правило не приймає (FR-008a). */
  STATUS_SOURCE_NOT_ACCEPTED: { hookIndex: 3, source: 'hook' },
  /**
   * Джерело статусу недоступне в момент переказу: акаунт атестації не
   * переданий або переданий не той. Недоступність джерела не послаблює
   * політику (FR-013).
   *
   * Протермінована атестація сюди **не** належить: за FR-008a2 вона
   * прирівнюється до відсутньої, після чого рішення ухвалює те правило, яке на
   * неї посилалось, — тобто на виході буде `*_STATUS_MISSING` або дозвіл.
   * Окремий код зробив би «протерміновано» самостійною причиною відмови, а це
   * інша поведінка, ніж написана у вимозі.
   */
  STATUS_SOURCE_UNAVAILABLE: { hookIndex: 4, source: 'hook' },
  /** Заборонений реєстр емітента: адреса не може ані відправляти, ані отримувати. */
  SENDER_DENIED: { hookIndex: 5, source: 'hook' },
  RECIPIENT_DENIED: { hookIndex: 6, source: 'hook' },
  RECIPIENT_TIER_TOO_LOW: { hookIndex: 7, source: 'hook' },
  RECIPIENT_JURISDICTION_NOT_ALLOWED: { hookIndex: 8, source: 'hook' },
  TRANSFER_LIMIT_EXCEEDED: { hookIndex: 9, source: 'hook' },
  /** Лічильник вікна створюється при `thaw_holder`; його відсутність — відмова. */
  VELOCITY_COUNTER_MISSING: { hookIndex: 10, source: 'hook' },
  PERIOD_LIMIT_EXCEEDED: { hookIndex: 11, source: 'hook' },
  /**
   * Політика містить вид правила, якого ця версія програми не знає.
   *
   * Стоїть **останнім** серед перевірок хука, і це не поступка порядку
   * оголошення: правило, якого читач не розуміє, робить неможливим саме
   * «так». Якщо котресь із зрозумілих правил уже відмовило, причина відмови —
   * воно, і вона точніша. Якщо ж усі зрозумілі правила пройшли, сказати «так»
   * не можна: невідоме правило могло сказати «ні». Той самий принцип, що й
   * FR-013 — політика, зрозуміла не повністю, не стає слабшою мовчки.
   *
   * Досяжний лише після відкату програми на версію, старшу за політику: запис
   * невідомого виду відхиляє `set_policy` (T014).
   */
  UNKNOWN_RULE_KIND: { hookIndex: 12, source: 'hook' },
  /** Розширення `Pausable` на mint (FR-016). Хук не викликається взагалі. */
  TRANSFERS_PAUSED: { hookIndex: null, source: 'token-program' },
  /** `freeze_account` або `DefaultAccountState = Frozen` (FR-014, FR-008b). */
  ACCOUNT_FROZEN: { hookIndex: null, source: 'token-program' },
} as const satisfies Record<RefusalCode, RefusalMeta>

/** Anchor нумерує помилки програми з 6000; нижче — його власні коди. */
export const ANCHOR_ERROR_OFFSET = 6000

/** Номер помилки Anchor для коду, або `null`, якщо код приходить не з хука. */
export function anchorErrorFor(code: RefusalCode): number | null {
  const { hookIndex } = REFUSAL_TABLE[code]
  return hookIndex === null ? null : ANCHOR_ERROR_OFFSET + hookIndex
}

/**
 * Зворотний бік: індексатор бачить у логах число, а не назву.
 *
 * Невідоме число повертає `null`, а не кидає: логи читаються з мережі, і
 * програма новішої версії, ніж цей воркер, — очікуваний стан, а не збій. Тоді
 * подія записується з невпізнаним кодом, а не губиться.
 */
export function refusalCodeFromAnchorError(anchorError: number): RefusalCode | null {
  const index = anchorError - ANCHOR_ERROR_OFFSET
  return REFUSAL_CODES.find((code) => REFUSAL_TABLE[code].hookIndex === index) ?? null
}

/** Коди, які повертає саме наш хук — тобто ті, що мають дзеркало в Rust. */
export function hookRefusalCodes(): RefusalCode[] {
  return REFUSAL_CODES.filter((code) => REFUSAL_TABLE[code].source === 'hook')
}
