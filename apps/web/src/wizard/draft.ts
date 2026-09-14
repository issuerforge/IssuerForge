// Чернетка випуску: те, що людина набрала, і те, на що це перетворюється.
//
// **Тут немає React і немає мережі.** Правило T010 лишається чинним: усе, що
// варте перевірки, живе в чистих функціях і тестується без DOM. Кроки майстра —
// це форма над цим модулем, а не навпаки.
//
// **Схему тіла запиту цей файл не переписує.** Вона приходить із
// `@forge/api/contracts` — того самого модуля, який валідує запит на сервері.
// Другий опис того самого тіла розійшовся б із першим мовчки, і розбіжність
// коштувала б відмови після двох підписів.
import { type CreateTokenBody, createTokenBodySchema, MAX_DECIMALS } from '@forge/api/contracts'
import {
  MAX_ATTESTATION_AGE_SECONDS,
  MAX_JURISDICTIONS,
  MAX_PERIOD_SECONDS,
  MIN_ATTESTATION_AGE_SECONDS,
  MIN_PERIOD_SECONDS,
  type PolicyRules,
  policyRulesSchema,
  type StatusSource,
} from '@forge/policy/model'

export interface Draft {
  // ─── 1. Токен ──────────────────────────────────────────────────────────────
  name: string
  symbol: string
  uri: string
  /** Текст, а не число: поле форми буває порожнім, а `0` — дійсна точність. */
  decimals: string
  initialSupply: string
  /** Три незмінні параметри, які мусять бути підтверджені явно (FR-005). */
  ackSymbol: boolean
  ackDecimals: boolean
  ackPolicy: boolean

  // ─── 2. Хто може тримати ───────────────────────────────────────────────────
  sources: StatusSource[]
  minTier: number
  attestationAgeHours: string
  /**
   * Країни списком через кому, як їх набирає людина.
   *
   * Рядок, а не масив: чернетка — це форма, і розбір живе в чистій функції
   * поруч. Порожній рядок означає «правила немає», тобто країни не
   * перевіряються взагалі — і це не те саме, що порожній перелік, який модель
   * відхиляє (`@forge/policy`: правила немає ≠ правило, що не дозволяє нікого).
   */
  jurisdictions: string
  founderTier: number
  founderJurisdiction: string

  // ─── 3. Ліміти ─────────────────────────────────────────────────────────────
  transferLimit: string
  periodLimit: string
  periodHours: string

  // ─── 4. Резерв і комісія ───────────────────────────────────────────────────
  reserveAmount: string
  reserveCurrency: string
  reserveAgeHours: string
  credential: string
  schema: string
  feeBps: string
  treasury: string
}

export const STEPS = [
  { n: 1, label: 'Token' },
  { n: 2, label: 'Who may hold' },
  { n: 3, label: 'Limits' },
  { n: 4, label: 'Reserve and fee' },
  { n: 5, label: 'Review' },
] as const

export const LAST_STEP = STEPS.length

/**
 * Порожня чернетка.
 *
 * Незмінні параметри не підтверджені, лімітів немає, джерела статусу — обидва.
 * Числа, які щось означають, тут не вигадуються: назва, символ і суми приходять
 * від людини, і підставлене «правдоподібне» значення в комплаєнс-формі — це
 * значення, яке хтось підпише не читаючи.
 */
export const EMPTY_DRAFT: Draft = {
  name: '',
  symbol: '',
  uri: '',
  decimals: '2',
  initialSupply: '',
  ackSymbol: false,
  ackDecimals: false,
  ackPolicy: false,

  sources: ['provider', 'register'],
  minTier: 1,
  attestationAgeHours: '720',
  jurisdictions: '',
  founderTier: 1,
  founderJurisdiction: '',

  transferLimit: '',
  periodLimit: '',
  periodHours: '24',

  reserveAmount: '',
  reserveCurrency: '',
  reserveAgeHours: '24',
  credential: '',
  schema: '',
  feeBps: '0',
  treasury: '',
}

// ─── Числа ───────────────────────────────────────────────────────────────────

/**
 * Сума в одиницях токена → найменші одиниці, **без чисел із рухомою комою**.
 *
 * `Number.parseFloat('25000000.07') * 100` дає 2500000006.9999995, і саме так
 * гроші втрачають копійку на порожньому місці. Тут усе рахується рядками.
 *
 * `undefined` означає «це не сума». Зайва точність теж не сума, а помилка:
 * `1.234` при двох знаках — це або одруківка, або людина думає, що токен має
 * три знаки. Мовчки відкинути хвіст означало б підписати не те число.
 */
export function toSmallestUnit(input: string, decimals: number): string | undefined {
  const cleaned = input.replace(/[\s,_]/g, '')
  if (!/^\d+(\.\d*)?$/.test(cleaned)) return undefined
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) return undefined

  const [whole = '', fraction = ''] = cleaned.split('.')
  if (fraction.length > decimals) return undefined

  const digits = `${whole}${fraction.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '')
  return digits === '' ? '0' : digits
}

/** Ціле число з поля форми. `undefined` — «не число», а не нуль. */
export function toInteger(input: string): number | undefined {
  const cleaned = input.replace(/[\s,_]/g, '')
  if (!/^\d+$/.test(cleaned)) return undefined
  const value = Number(cleaned)
  return Number.isSafeInteger(value) ? value : undefined
}

/**
 * «ng, GH , ke» → `['NG', 'GH', 'KE']`.
 *
 * Порядок не нормалізується тут: його нормалізує сама модель правил, бо від
 * нього залежить `rules_hash` (T012). Дублікати теж лишаються — їх відхиляє
 * схема, і зробити це мовчки означало б прийняти помилку за намір.
 */
export function parseJurisdictions(raw: string): string[] {
  return raw
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter((code) => code !== '')
}

const hoursToSeconds = (input: string): number | undefined => {
  const hours = toInteger(input)
  return hours === undefined ? undefined : hours * 3600
}

// ─── Чернетка → політика ─────────────────────────────────────────────────────

/**
 * Правила в тій формі, у якій їх приймає модель.
 *
 * Порожнє поле — це **відсутнє правило**, а не нульове: домовленість
 * `@forge/policy` одна на всі поля, і саме тому нуль не є допустимою сумою
 * ліміту, а порожній перелік країн не є способом сказати «усі».
 */
export function draftPolicy(draft: Draft): unknown {
  const decimals = toInteger(draft.decimals) ?? 0

  const transferLimit = toSmallestUnit(draft.transferLimit, decimals)
  const periodAmount = toSmallestUnit(draft.periodLimit, decimals)
  const windowSeconds = hoursToSeconds(draft.periodHours)

  return {
    status: {
      sources: draft.sources,
      minTier: draft.minTier,
      // Строк придатності атестації має сенс лише тоді, коли атестації взагалі
      // приймаються; інакше поле не «нуль», а відсутнє.
      ...(draft.sources.includes('provider')
        ? { maxAttestationAgeSeconds: hoursToSeconds(draft.attestationAgeHours) }
        : {}),
    },
    ...(parseJurisdictions(draft.jurisdictions).length > 0
      ? { jurisdictions: parseJurisdictions(draft.jurisdictions) }
      : {}),
    ...(draft.transferLimit.trim() === '' ? {} : { transferLimit }),
    ...(draft.periodLimit.trim() === ''
      ? {}
      : { periodLimit: { amount: periodAmount, windowSeconds } }),
  }
}

/** Розібрані правила або `undefined`, поки чернетка ще не політика. */
export function parsedPolicy(draft: Draft): PolicyRules | undefined {
  const parsed = policyRulesSchema.safeParse(draftPolicy(draft))
  return parsed.success ? parsed.data : undefined
}

// ─── Чернетка → тіло запиту ──────────────────────────────────────────────────

export interface DraftBody {
  ok: boolean
  body?: CreateTokenBody
  /** Проблеми в тій формі, у якій їх показує форма: «поле: що не так». */
  problems: readonly string[]
}

/**
 * Чернетка → тіло `POST /api/tokens`, перевірене **тією самою схемою**, що на
 * сервері.
 *
 * `now` приходить аргументом: час атестації резерву рахується від нього, і
 * прихований `Date.now()` зробив би цю функцію неперевірюваною.
 */
export function toCreateTokenBody(draft: Draft, now: number): DraftBody {
  const decimals = toInteger(draft.decimals)
  const reserveAgeSeconds = hoursToSeconds(draft.reserveAgeHours)

  const candidate = {
    name: draft.name.trim(),
    symbol: draft.symbol.trim(),
    uri: draft.uri.trim(),
    decimals,
    policy: draftPolicy(draft),
    initialSupply: toSmallestUnit(draft.initialSupply, decimals ?? 0),
    reserve: {
      amount: toSmallestUnit(draft.reserveAmount, decimals ?? 0),
      currency: draft.reserveCurrency.trim().toUpperCase(),
      attestedAt: now,
    },
    attestation: {
      credential: draft.credential.trim(),
      schema: draft.schema.trim(),
      maxAgeSeconds: reserveAgeSeconds,
    },
    fee: { treasury: draft.treasury.trim(), bps: toInteger(draft.feeBps) },
    founderStatus: {
      tier: draft.founderTier,
      jurisdiction: draft.founderJurisdiction.trim().toUpperCase(),
      expiresAt: 0,
    },
  }

  const parsed = createTokenBodySchema.safeParse(candidate)
  if (parsed.success) return { ok: true, body: parsed.data, problems: [] }

  return {
    ok: false,
    problems: parsed.error.issues.map((issue) => {
      const field = issue.path.join('.')
      return field === '' ? issue.message : `${field}: ${issue.message}`
    }),
  }
}

// ─── Готовність кроків ───────────────────────────────────────────────────────

const missing = (value: string, label: string): string[] =>
  value.trim() === '' ? [`${label} is required`] : []

/**
 * Що заважає піти з цього кроку далі.
 *
 * Порожній масив — «крок повний». Список, а не булеве значення: людині треба
 * сказати, чого бракує, а не пофарбувати кнопку сірим.
 *
 * Крок доводить **свої** поля, і тільки їх. Наскрізні звірки (емісія проти
 * резерву, статус засновника проти політики) стоять на кроці, де видно обидва
 * числа, — інакше крок 1 відмовляв би через поле, якого на ньому ще немає.
 */
export function problemsAt(step: number, draft: Draft): readonly string[] {
  const decimals = toInteger(draft.decimals)

  if (step === 1) {
    const problems = [
      ...missing(draft.name, 'token name'),
      ...missing(draft.symbol, 'symbol'),
      ...missing(draft.uri, 'metadata URI'),
    ]
    if (decimals === undefined || decimals > MAX_DECIMALS) {
      problems.push(`decimals must be a whole number from 0 to ${MAX_DECIMALS}`)
    }
    if (toSmallestUnit(draft.initialSupply, decimals ?? 0) === undefined) {
      problems.push(`initial issuance must be an amount with at most ${decimals ?? 0} decimals`)
    }
    if (!(draft.ackSymbol && draft.ackDecimals && draft.ackPolicy)) {
      problems.push('all three fixed parameters must be acknowledged')
    }
    return problems
  }

  if (step === 2) {
    const problems: string[] = []
    if (draft.sources.length === 0) {
      problems.push('a policy with no status source refuses every transfer')
    }
    if (draft.sources.includes('provider')) {
      const seconds = hoursToSeconds(draft.attestationAgeHours)
      if (
        seconds === undefined ||
        seconds < MIN_ATTESTATION_AGE_SECONDS ||
        seconds > MAX_ATTESTATION_AGE_SECONDS
      ) {
        problems.push('provider attestations need a validity between 1 hour and 365 days')
      }
    }
    const codes = parseJurisdictions(draft.jurisdictions)
    if (codes.length > MAX_JURISDICTIONS) {
      problems.push(`a rule holds at most ${MAX_JURISDICTIONS} jurisdictions`)
    }
    if (codes.some((code) => !/^[A-Z]{2}$/.test(code))) {
      problems.push('each jurisdiction is a two-letter ISO 3166-1 code, like NG or GH')
    }
    if (new Set(codes).size !== codes.length) {
      problems.push('a jurisdiction is named twice')
    }
    if (!/^[A-Z]{2}$/.test(draft.founderJurisdiction.trim().toUpperCase())) {
      problems.push('the founder needs a jurisdiction: it goes into their status at issuance')
    }
    return problems
  }

  if (step === 3) {
    const problems: string[] = []
    if (draft.transferLimit.trim() !== '') {
      const amount = toSmallestUnit(draft.transferLimit, decimals ?? 0)
      if (amount === undefined || amount === '0') {
        problems.push('a transfer limit of zero stops every transfer: leave it empty instead')
      }
    }
    if (draft.periodLimit.trim() !== '') {
      const amount = toSmallestUnit(draft.periodLimit, decimals ?? 0)
      if (amount === undefined || amount === '0') {
        problems.push('a period limit of zero stops every transfer: leave it empty instead')
      }
      const seconds = hoursToSeconds(draft.periodHours)
      if (seconds === undefined || seconds < MIN_PERIOD_SECONDS || seconds > MAX_PERIOD_SECONDS) {
        problems.push('the period must be between 1 hour and 31 days')
      }
    }
    return problems
  }

  // Кроки 4 і 5 доводяться тим самим, чим доводить сервер: схемою тіла. Тут
  // уперше видно всі поля разом, тож наскрізні правила (емісія ≤ резерв)
  // перевіряються саме на них.
  return toCreateTokenBody(draft, 0).problems
}

/**
 * Попередження — не те саме, що проблеми: вони нічого не блокують.
 *
 * Обидва нижче — про засновника, і жодне з них не перевіряє програма. Вона й не
 * має: політика стосується переказів, а не того, кому дістався початковий
 * випуск. Наслідок при цьому цілком реальний — токен, який нікуди не рухається,
 * — і побачити його треба до підпису, а не після.
 */
export function warningsFor(draft: Draft): readonly string[] {
  const warnings: string[] = []
  const jurisdiction = draft.founderJurisdiction.trim().toUpperCase()
  const allowed = parseJurisdictions(draft.jurisdictions)

  if (allowed.length > 0 && !allowed.includes(jurisdiction)) {
    warnings.push(
      `the founder’s jurisdiction ${jurisdiction || '—'} is not among the ones this policy allows: the whole issuance would sit in an account that cannot send`,
    )
  }
  if (draft.founderTier < draft.minTier) {
    warnings.push(
      `the founder’s tier ${draft.founderTier} is below the minimum ${draft.minTier} this policy requires: the whole issuance would sit in an account that cannot send`,
    )
  }
  return warnings
}
