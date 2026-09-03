// Детермінований бінарний layout політики і `rules_hash`.
//
// Це друга половина пари «модель ↔ байти»: `model.ts` каже, що політика може
// сказати, а тут вона стає тими самими 384 байтами, які лежать у
// `PolicyConfig.rules` і які читає хук без алокацій.
//
// **Кодування канонічне: у політики рівно одне представлення в байтах.** Звідси
// три властивості, які треба тримати разом, бо поодинці кожна нічого не варта:
//
// 1. `encode` детермінований — слоти йдуть за зростанням `kind`, множини вже
//    впорядковані моделлю, набивка нульова;
// 2. `decode` відхиляє все, що не могло вийти з `encode` — ненульову набивку,
//    ненульовий `op`, невідомий `kind`, порядок не за зростанням;
// 3. `encode(decode(bytes)) === bytes` для будь-яких прийнятих байтів.
//
// Без (2) два різні масиви байтів означали б ту саму політику й мали різний
// `rules_hash` — тобто хеш перестав би бути іменем політики й став би іменем
// однієї з її записів.
//
// **`rules_hash` рахується над усіма 16 слотами**, як вони лежать в акаунті.
// Незалежному верифікатору (SC-006) не треба знати, скільки слотів заповнено:
// він бере зріз даних акаунта, хешує його й порівнює. Хеш доводить вміст
// акаунта байт у байт, а не його тлумачення.
import { fromU64, toU64 } from '@forge/shared/primitives'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  MAX_RULE_SLOTS,
  type PolicyRules,
  policyRulesSchema,
  RULE_KIND,
  RULE_PARAMS_BYTES,
  RULE_SLOT_BYTES,
  STATUS_SOURCE,
  STATUS_SOURCE_ALL,
  STATUS_SOURCES,
  statusSourceMask,
} from './model.ts'

/** Повний розмір поля `rules` в акаунті. */
export const RULES_BYTES = MAX_RULE_SLOTS * RULE_SLOT_BYTES

/**
 * Другий байт слота.
 *
 * `PLAN.md` задумував тут оператор порівняння, але з іменованою моделлю вид
 * правила вже визначає оператор, і другий спосіб сказати те саме міг би з ним
 * розійтися (`TRANSFER_LIMIT` із `gte` — що це означає?). Байт лишається нулем
 * і **перевіряється**: інакше він стає тихим каналом, у який щось потрапляє й
 * змінює `rules_hash`, нічого не змінюючи в змісті.
 *
 * Нове кодування параметрів — це новий `kind`, а не нове значення тут. Одна
 * вісь версій замість двох, і підписана політика ніколи не міняє сенсу.
 */
export const RULE_OP_RESERVED = 0

/** Зміщення слота в масиві. */
const slotOffset = (index: number): number => index * RULE_SLOT_BYTES

/** Порядок слотів — за зростанням `kind`. Іншого детермінованого немає. */
const SLOT_ORDER = [
  RULE_KIND.STATUS,
  RULE_KIND.JURISDICTIONS,
  RULE_KIND.TRANSFER_LIMIT,
  RULE_KIND.PERIOD_LIMIT,
] as const

export class PolicyLayoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PolicyLayoutError'
  }
}

// ─── Кодування ───────────────────────────────────────────────────────────────

function writeSlot(out: Uint8Array, index: number, kind: number, params: Uint8Array): void {
  if (params.length > RULE_PARAMS_BYTES) {
    throw new PolicyLayoutError(`rule ${kind} needs ${params.length} bytes, the slot holds 22`)
  }
  const at = slotOffset(index)
  out[at] = kind
  out[at + 1] = RULE_OP_RESERVED
  out.set(params, at + 2)
}

function statusParams(rules: PolicyRules): Uint8Array {
  const params = new Uint8Array(RULE_PARAMS_BYTES)
  params[0] = statusSourceMask(rules.status.sources)
  params[1] = rules.status.minTier
  // Нуль означає «строку немає»: модель не дозволяє значення менше за годину,
  // тож нуль не є дійсним строком і читається однозначно.
  new DataView(params.buffer).setUint32(2, rules.status.maxAttestationAgeSeconds ?? 0, true)
  return params
}

function jurisdictionParams(codes: readonly string[]): Uint8Array {
  const params = new Uint8Array(RULE_PARAMS_BYTES)
  codes.forEach((code, i) => {
    params[i * 2] = code.charCodeAt(0)
    params[i * 2 + 1] = code.charCodeAt(1)
  })
  return params
}

function amountParams(amount: string, windowSeconds?: number): Uint8Array {
  const params = new Uint8Array(RULE_PARAMS_BYTES)
  const view = new DataView(params.buffer)
  view.setBigUint64(0, toU64(amount), true)
  if (windowSeconds !== undefined) view.setUint32(8, windowSeconds, true)
  return params
}

/**
 * Політика → 384 байти поля `rules`.
 *
 * Вхід проганяється через схему: кодувати неперевірену політику означає
 * записати в акаунт значення, яке модель відхилила б, — і дізнатись про це
 * відмовою в переказі через тиждень.
 */
export function encodeRules(rules: PolicyRules): Uint8Array {
  const checked = policyRulesSchema.parse(rules)
  const out = new Uint8Array(RULES_BYTES)
  let index = 0

  for (const kind of SLOT_ORDER) {
    switch (kind) {
      case RULE_KIND.STATUS:
        writeSlot(out, index++, kind, statusParams(checked))
        break
      case RULE_KIND.JURISDICTIONS:
        if (checked.jurisdictions !== undefined) {
          writeSlot(out, index++, kind, jurisdictionParams(checked.jurisdictions))
        }
        break
      case RULE_KIND.TRANSFER_LIMIT:
        if (checked.transferLimit !== undefined) {
          writeSlot(out, index++, kind, amountParams(checked.transferLimit))
        }
        break
      case RULE_KIND.PERIOD_LIMIT:
        if (checked.periodLimit !== undefined) {
          const { amount, windowSeconds } = checked.periodLimit
          writeSlot(out, index++, kind, amountParams(amount, windowSeconds))
        }
        break
    }
  }

  return out
}

// ─── Декодування ─────────────────────────────────────────────────────────────

/** Читання чисел із параметрів слота. Зміщення — від початку `params`. */
const paramsView = (params: Uint8Array): DataView =>
  new DataView(params.buffer, params.byteOffset, params.byteLength)

function readStatus(params: Uint8Array): PolicyRules['status'] {
  const mask = params[0] ?? 0
  // Невідомий біт джерела — та сама відмова, що й невідомий вид правила:
  // джерело, якого читач не знає, не можна ані виконати, ані пропустити.
  if (mask === 0 || (mask & ~STATUS_SOURCE_ALL) !== 0) {
    throw new PolicyLayoutError(`status rule names no known source (mask ${mask})`)
  }

  const maxAge = paramsView(params).getUint32(2, true)
  const status: PolicyRules['status'] = {
    sources: STATUS_SOURCES.filter((source) => (mask & STATUS_SOURCE[source]) !== 0),
    minTier: params[1] ?? 0,
  }
  return maxAge === 0 ? status : { ...status, maxAttestationAgeSeconds: maxAge }
}

function readJurisdictions(params: Uint8Array): string[] {
  const codes: string[] = []
  for (let i = 0; i * 2 < RULE_PARAMS_BYTES; i++) {
    const high = params[i * 2] ?? 0
    const low = params[i * 2 + 1] ?? 0
    if (high === 0 && low === 0) break
    codes.push(String.fromCharCode(high, low))
  }
  return codes
}

/**
 * 384 байти → політика.
 *
 * Відхиляє все, що не могло вийти з `encode`. Це не педантизм: `rules_hash`
 * іменує політику, і два різні масиви з однаковим змістом зробили б це ім'я
 * неоднозначним у той самий момент, коли на нього посилається запис журналу.
 */
export function decodeRules(bytes: Uint8Array): PolicyRules {
  if (bytes.length !== RULES_BYTES) {
    throw new PolicyLayoutError(`expected ${RULES_BYTES} bytes of rules, got ${bytes.length}`)
  }

  const draft: Record<string, unknown> = {}
  const seen = new Set<number>()
  let previousKind = 0
  let ended = false

  for (let index = 0; index < MAX_RULE_SLOTS; index++) {
    const at = slotOffset(index)
    const slot = bytes.subarray(at, at + RULE_SLOT_BYTES)
    const kind = slot[0] ?? 0
    const op = slot[1] ?? 0
    const params = slot.subarray(2)

    if (kind === 0) {
      // Порожній слот мусить бути порожній цілком: ненульовий хвіст не змінює
      // змісту політики, але змінює її хеш.
      if (slot.some((byte) => byte !== 0)) {
        throw new PolicyLayoutError(`slot ${index} is empty but not zeroed`)
      }
      ended = true
      continue
    }

    // Дірка між правилами дала б два кодування однієї політики.
    if (ended) throw new PolicyLayoutError(`slot ${index} follows an empty slot`)
    if (op !== RULE_OP_RESERVED) {
      throw new PolicyLayoutError(`slot ${index} sets the reserved byte to ${op}`)
    }
    if (seen.has(kind)) throw new PolicyLayoutError(`rule kind ${kind} appears twice`)
    if (kind <= previousKind) {
      throw new PolicyLayoutError(`slot ${index} breaks the ascending order of rule kinds`)
    }
    seen.add(kind)
    previousKind = kind

    switch (kind) {
      case RULE_KIND.STATUS:
        draft.status = readStatus(params)
        break
      case RULE_KIND.JURISDICTIONS:
        draft.jurisdictions = readJurisdictions(params)
        break
      case RULE_KIND.TRANSFER_LIMIT:
        draft.transferLimit = fromU64(paramsView(params).getBigUint64(0, true))
        break
      case RULE_KIND.PERIOD_LIMIT: {
        const view = paramsView(params)
        draft.periodLimit = {
          amount: fromU64(view.getBigUint64(0, true)),
          windowSeconds: view.getUint32(8, true),
        }
        break
      }
      // Невідомий вид правила — відмова, а не пропуск. Політика, яку читач не
      // розуміє повністю, не стає слабшою мовчки: це той самий принцип, що й
      // FR-013 про недоступне джерело статусу. `set_policy` не пропустить таке
      // при записі (T014), а хук однаково відмовить (T015).
      default:
        throw new PolicyLayoutError(`slot ${index} carries an unknown rule kind ${kind}`)
    }
  }

  // Схема ловить решту: набивку, що не є дійсним значенням, суму нуль,
  // відсутнє обов'язкове правило статусу.
  const parsed = policyRulesSchema.safeParse(draft)
  if (!parsed.success) {
    throw new PolicyLayoutError(
      `rules do not form a valid policy: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    )
  }
  return parsed.data
}

// ─── Хеш ─────────────────────────────────────────────────────────────────────

/**
 * sha256 над полем `rules` цілком.
 *
 * sha256, а не щось інше, бо його рахує сама програма: у Solana це нативний
 * syscall, тобто один дешевий виклик при зміні політики — і жодного на
 * переказі. Хеш, який ончейн-код не може перерахувати, доводив би тільки те,
 * що клієнт уміє рахувати хеші.
 */
export function hashEncodedRules(bytes: Uint8Array): Uint8Array {
  if (bytes.length !== RULES_BYTES) {
    throw new PolicyLayoutError(`expected ${RULES_BYTES} bytes of rules, got ${bytes.length}`)
  }
  return sha256(bytes)
}

/** `rules_hash` політики. Те саме, що `hashEncodedRules(encodeRules(rules))`. */
export function rulesHash(rules: PolicyRules): Uint8Array {
  return hashEncodedRules(encodeRules(rules))
}

/** Шістнадцятковий рядок — те, що показує майстер і що лежить у `policy_versions`. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
