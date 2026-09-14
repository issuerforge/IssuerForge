// Контракт двох ручок майстра: що приймає api й що він віддає.
//
// **Чому окремим модулем, а не в маршруті.** Схеми оголошувалися в
// `routes/tokens.ts` (T021) із наміром, щоб консоль брала їх звідти, а не
// писала другий опис того самого тіла. Намір був правильний, а місце — ні:
// разом зі схемою консоль затягнула б у бандл `hono`, `drizzle` і `postgres`,
// тобто пакети, яких у браузері не буває. Тут не імпортується нічого, крім
// `zod`, моделі правил і примітивів, — і той самий файл читають обидві сторони.
//
// **Межі значень нижче — дзеркало `create_token.rs`.** Програма перевіряє все
// це сама й лишається авторитетом; тут перевірка стоїть, щоб помилка в майстрі
// була реченням у формі, а не відмовою девнета через півхвилини.
import { TX_STEPS } from '@forge/chain/plan'
import { transferVerdictSchema } from '@forge/policy/evaluate'
import { jurisdictionSchema, policyRulesSchema, tierSchema } from '@forge/policy/model'
import { SCENARIO_NAMES, scenarioNameSchema } from '@forge/policy/scenarios'
import { addressSchema, toU64, u64Schema, unixSecondsSchema } from '@forge/shared/primitives'
import { z } from 'zod'

// ─── Межі, узяті з програми ──────────────────────────────────────────────────

/** `MAX_NAME_LEN`, `MAX_SYMBOL_LEN`, `MAX_URI_LEN` з `create_token.rs`. */
export const MAX_NAME_BYTES = 32
export const MAX_SYMBOL_BYTES = 12
export const MAX_URI_BYTES = 200
/** `MAX_FEE_BPS`: сто відсотків у базисних пунктах. */
export const MAX_FEE_BPS = 10_000
/** Точність токена. Стеля — та сама, що `CHECK` у таблиці `tokens`. */
export const MAX_DECIMALS = 9

/**
 * Рядок, обмежений **байтами**, а не символами.
 *
 * Програма міряє `args.name.len()`, тобто довжину UTF-8. Перевірка по символах
 * пропустила б назву з кирилицею, яка вдвічі довша за дозволене, — і відмова
 * прийшла б із мережі після двох підписів.
 */
const bounded = (maxBytes: number, label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .refine(
      (value) => new TextEncoder().encode(value).length <= maxBytes,
      `${label} must be at most ${maxBytes} bytes`,
    )

/** `validate_currency` з `state/reserve.rs`: 3–8 великих латинських літер. */
const currencySchema = z
  .string()
  .regex(/^[A-Z]{3,8}$/, 'expected 3 to 8 uppercase letters, like USD or NGN')

// ─── POST /api/policy/simulate ───────────────────────────────────────────────

/**
 * Тіло симуляції: чернетка політики й, за бажанням, звужений набір сценаріїв.
 *
 * Сценарії названі іменами, а не описані контекстами: що таке «понад ліміт» за
 * цієї політики, вирішує каталог у `@forge/policy` (T021), і те саме число
 * бачать майстер і демо-сценарій. Клієнт, який складав би контексти сам, мав би
 * власну відповідь на це питання.
 */
export const simulatePolicyBodySchema = z.strictObject({
  policy: policyRulesSchema,
  /**
   * Стеля й заборона повторів — не педантизм, а межа роботи, яку запит замовляє.
   *
   * Перелік іменований і скінченний, тож більше за каталог попросити нема чого;
   * без стелі та сама назва, повторена 50 000 разів, коштувала б секунди
   * процесора й чотирьох мегабайтів відповіді на один запит (виміряно).
   * Дублікат — помилка клієнта, а не спосіб замовити сценарій двічі.
   */
  scenarios: z
    .array(scenarioNameSchema)
    .min(1)
    .max(SCENARIO_NAMES.length)
    .refine((names) => new Set(names).size === names.length, 'a scenario is named twice')
    .optional(),
})

export type SimulatePolicyBody = z.infer<typeof simulatePolicyBodySchema>

/**
 * Відповідь симуляції.
 *
 * `applicable: false` — не привід зникнути з переліку: «понад ліміт» при
 * політиці без лімітів лишається видимим рядком «ліміту немає — дозволено».
 * Чотири сценарії замість п'яти прочитались би як «усе гаразд» (рішення T021),
 * і консоль зобов'язана показати цей рядок окремо, а не сховати його.
 */
export const simulatePolicyResponseSchema = z.object({
  /** Годинник **сервера**: за ним рахувалися строки в сценаріях. */
  now: unixSecondsSchema,
  scenarios: z.array(
    z.object({
      name: scenarioNameSchema,
      applicable: z.boolean(),
      amount: u64Schema,
      verdict: transferVerdictSchema,
    }),
  ),
})

export type SimulatePolicyResponse = z.infer<typeof simulatePolicyResponseSchema>

// ─── POST /api/tokens ────────────────────────────────────────────────────────

/**
 * Тіло випуску.
 *
 * **Невідоме поле — помилка, а не сміття.** Схема строга: `attestedat` замість
 * `attestedAt` інакше просто зникло б, і атестація резерву отримала б час
 * запиту замість дати звіту аудитора — тобто мовчки інше значення там, де вся
 * задача продукту в тому, щоб чисел не підміняли.
 *
 * Чого тут немає навмисно:
 * - **номера токена** — його диктує `issuer_config.token_count`, а не клієнт;
 * - **`issuer_id`** — він береться з сесії й не перекривається параметром (FR-036);
 * - **`denied` у статусі засновника** — емітент не заводить власного засновника
 *   в чорний список у мить випуску, а поле, яке завжди `false`, було б місцем,
 *   де випуск можна зробити непрацездатним одним зайвим полем у JSON.
 */
export const createTokenBodySchema = z
  .strictObject({
    name: bounded(MAX_NAME_BYTES, 'name'),
    symbol: bounded(MAX_SYMBOL_BYTES, 'symbol'),
    uri: bounded(MAX_URI_BYTES, 'uri'),
    decimals: z.number().int().min(0).max(MAX_DECIMALS),
    policy: policyRulesSchema,
    initialSupply: u64Schema,
    reserve: z.strictObject({
      amount: u64Schema,
      currency: currencySchema,
      /**
       * Коли резерв підтверджений. За замовчуванням — час запиту.
       *
       * Поле існує тому, що атестація буває зроблена раніше за випуск (звіт
       * підписали вчора), а програма порівнює саме цей момент із дозволеним
       * віком. Час із майбутнього вона відхиляє, і маршрут відхиляє його теж.
       */
      attestedAt: unixSecondsSchema.optional(),
    }),
    attestation: z.strictObject({
      credential: addressSchema,
      schema: addressSchema,
      /**
       * Скільки атестація резерву лишається чинною. Стелі немає: строк
       * призначає емітент зі своїм аудитором, і вигадана тут межа відкинула б
       * дійсний випуск із причини, якої немає в жодній вимозі.
       */
      maxAgeSeconds: z.number().int().positive(),
    }),
    fee: z.strictObject({
      treasury: addressSchema,
      bps: z.number().int().min(0).max(MAX_FEE_BPS),
    }),
    founderStatus: z.strictObject({
      tier: tierSchema,
      jurisdiction: jurisdictionSchema,
      /** Нуль — без строку, як і в самому `HolderStatus`. */
      expiresAt: unixSecondsSchema.default(0),
    }),
    /** Потрібні, лише коли в складі кілька адміністраторів або атестаторів. */
    founder: addressSchema.optional(),
    attestor: addressSchema.optional(),
  })
  // Та сама нерівність, що в `ReserveCheck`: обіг нульовий, тож уся емісія
  // мусить уміститись в атестований резерв (FR-022). Програма перевірить це
  // ще раз і лишається авторитетом.
  .refine((body) => toU64(body.initialSupply) <= toU64(body.reserve.amount), {
    error: 'initial supply exceeds the attested reserve',
    path: ['initialSupply'],
  })

export type CreateTokenBody = z.infer<typeof createTokenBodySchema>

/**
 * Непідписана транзакція в тому вигляді, у якому вона їде до браузера.
 *
 * `signers` — адреси, чиїх підписів їй бракує, у порядку «платник, далі решта»
 * (T020). Консоль питає підписи саме в цьому порядку, а не вигадує свій.
 * `dependsOnPrevious` — заборона надіслати пачкою: `set_token_metadata` і
 * `initialize_extra_account_meta_list` читають `TokenConfig`, якого до
 * підтвердження `create_token` не існує.
 */
export const unsignedTransactionSchema = z.object({
  step: z.enum(TX_STEPS),
  base64: z.string().min(1),
  signers: z.array(addressSchema).min(1),
  dependsOnPrevious: z.boolean(),
  bytes: z.number().int().positive(),
})

export type UnsignedTransactionView = z.infer<typeof unsignedTransactionSchema>

/**
 * Відповідь випуску: три транзакції й адреси, відомі наперед.
 *
 * Адреси є в відповіді тому, що mint — PDA від номера токена, і консоль має
 * показати їх **до** підпису: людина, яка підписує створення токена, мусить
 * бачити його адресу, а не дізнаватись її з підтвердження.
 */
export const createTokenResponseSchema = z.object({
  tokenIndex: z.number().int().nonnegative(),
  mint: addressSchema,
  tokenConfig: addressSchema,
  policyConfig: addressSchema,
  attestation: addressSchema,
  extraAccountMetaList: addressSchema,
  founder: addressSchema,
  attestor: addressSchema,
  blockhash: z.string().min(1),
  transactions: z.array(unsignedTransactionSchema).min(1),
})

export type CreateTokenResponse = z.infer<typeof createTokenResponseSchema>
