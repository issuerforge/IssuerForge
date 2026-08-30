import { z } from 'zod'

/** base58 не має 0, O, I та l — звідси діапазони. Адреса Solana: 32 байти. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
/** Підпис транзакції — 64 байти, тобто 86–88 символів base58. */
const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/
/** Десятковий цілий рядок без провідних нулів. */
const DECIMAL_U64 = /^(0|[1-9][0-9]*)$/

export const U64_MAX = 18_446_744_073_709_551_615n

export const addressSchema = z.string().regex(BASE58_ADDRESS, 'expected a base58 Solana address')

export const signatureSchema = z
  .string()
  .regex(BASE58_SIGNATURE, 'expected a base58 transaction signature')

/**
 * Сума в найменших одиницях — через JSON їде **рядком**, не числом.
 *
 * u64 не влазить у double. Тут це не теоретичне зауваження: обіг стейблкоїна з
 * двома знаками й атестований резерв у найменших одиницях фіату — числа, які
 * порівнюються між собою в перевірці «емісія + обіг ≤ атестованого» (FR-022).
 * Мовчазна втрата молодших розрядів у цьому порівнянні означає емісію понад
 * резерв, тобто рівно те, чого весь продукт не має дозволяти.
 */
export const u64Schema = z
  .string()
  .regex(DECIMAL_U64, 'expected a non-negative integer in the smallest unit, as a decimal string')
  // Zod 4 проганяє всі перевірки, навіть коли попередня вже впала, тож форму
  // треба звірити ще раз: `BigInt('1.5')` кидає SyntaxError, і невалідне тіло
  // запиту поверталося б як 500 замість 400.
  .refine(
    (value) => DECIMAL_U64.test(value) && BigInt(value) <= U64_MAX,
    'value does not fit in u64',
  )

/**
 * Слот мережі. У БД це `bigint`, але поточні слоти Solana на дев'ять порядків
 * менші за `Number.MAX_SAFE_INTEGER`, тож числом він їде без ризику.
 */
export const slotSchema = z.number().int().nonnegative()

/**
 * Час блоку — unix-секунди, як їх віддає RPC, а не ISO-рядок.
 *
 * Журнал звіряється з мережею без доступу до систем емітента (FR-018, SC-006):
 * верифікатор порівнює поле запису з тим, що повернув `getTransaction`. Будь-яке
 * перетворення на цьому шляху — це місце, де звірка може розійтися на форматі,
 * а не на змісті. Форматує UI.
 *
 * `null` — не помилка індексації: RPC не має `blockTime` для блоків, підрізаних
 * із леджера, і подія від цього не перестає бути дійсною.
 */
export const blockTimeSchema = z.number().int().nullable()

/** Секунди unix. Ончейн це `i64`, але від'ємний час у цій системі не існує. */
export const unixSecondsSchema = z.number().int().nonnegative()

export type Address = z.infer<typeof addressSchema>
export type Signature = z.infer<typeof signatureSchema>
export type U64String = z.infer<typeof u64Schema>

/** Перетворення суми з транспортного рядка в число для арифметики. */
export function toU64(value: U64String): bigint {
  return BigInt(value)
}

/** Зворотне перетворення. Кидає на від'ємному значенні або на переповненні. */
export function fromU64(value: bigint): U64String {
  if (value < 0n) throw new RangeError(`u64 cannot be negative: ${value}`)
  if (value > U64_MAX) throw new RangeError(`value does not fit in u64: ${value}`)
  return value.toString(10)
}
