import { readdirSync, readFileSync } from 'node:fs'
import {
  hookRefusalCodes,
  REFUSAL_CODES,
  type RefusalCode,
  refusalCodeSchema,
} from '@forge/shared/refusal'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  evaluateTransfer,
  implementedRefusalCodes,
  type PartyContext,
  type ProviderStatus,
  type RegisterStatus,
  refusalCodesCheckedElsewhere,
  simulateTransfer,
  type TransferContext,
  type TransferVerdict,
  transferContextSchema,
} from './evaluate.ts'
import { decodeRules, encodeRules, PolicyLayoutError, toHex } from './layout.ts'
import { MAX_ATTESTATION_AGE_SECONDS, type PolicyRules, policyRulesSchema } from './model.ts'

/** Фіксований час блоку: результат оцінювача не має залежати від годинника. */
const NOW = 1_800_000_000

const bothSources: PolicyRules['status'] = {
  sources: ['provider', 'register'],
  minTier: 0,
  maxAttestationAgeSeconds: 30 * 24 * 3600,
}

const policy = (over: Partial<PolicyRules> = {}): PolicyRules =>
  policyRulesSchema.parse({ status: bothSources, ...over })

/** Політика, яка приймає статус тільки з власного реєстру емітента. */
const registerOnly = (over: Partial<PolicyRules> = {}): PolicyRules =>
  policyRulesSchema.parse({ status: { sources: ['register'], minTier: 0 }, ...over })

const registerStatus = (over: Partial<RegisterStatus> = {}): RegisterStatus => ({
  denied: false,
  tier: 3,
  jurisdiction: 'NG',
  expiresAt: null,
  ...over,
})

const providerStatus = (over: Partial<ProviderStatus> = {}): ProviderStatus => ({
  ...registerStatus(),
  issuedAt: NOW - 3600,
  ...over,
})

const ABSENT = { kind: 'absent' } as const
const UNAVAILABLE = { kind: 'unavailable' } as const

const fromRegister = (over: Partial<RegisterStatus> = {}): PartyContext['register'] => ({
  kind: 'record',
  record: registerStatus(over),
})

const fromProvider = (over: Partial<ProviderStatus> = {}): PartyContext['provider'] => ({
  kind: 'record',
  record: providerStatus(over),
})

/** За замовчуванням сторона має чинний запис у реєстрі й нічого в провайдера. */
const party = (over: Partial<PartyContext> = {}): PartyContext => ({
  provider: ABSENT,
  register: fromRegister(),
  ...over,
})

const context = (over: Partial<TransferContext> = {}): TransferContext => ({
  sender: party(),
  recipient: party(),
  amount: '1000',
  mintPolicyVersion: 1,
  policyVersion: 1,
  now: NOW,
  ...over,
})

/** Код відмови або `null` на дозволі — так вердикти читаються в одну колонку. */
const codeOf = (verdict: TransferVerdict): RefusalCode | null =>
  verdict.allowed ? null : verdict.code

const verdict = (rules: PolicyRules, ctx: TransferContext): RefusalCode | null =>
  codeOf(evaluateTransfer(rules, ctx))

describe('the shape of the answer', () => {
  it('allows a transfer that meets an open policy', () => {
    expect(evaluateTransfer(policy(), context())).toEqual({ allowed: true })
  })

  it('carries the code and nothing else when it refuses', () => {
    expect(evaluateTransfer(policy(), context({ policyVersion: 2 }))).toEqual({
      allowed: false,
      code: 'POLICY_VERSION_MISMATCH',
    })
  })
})

describe('the order of checks', () => {
  // Перелік перевірок не живе в оцінювачі: він іде `REFUSAL_CODES`. Цей тест
  // ловить зворотне — код відмови, оголошений хуковим, для якого перевірки
  // немає, і перевірку, що лишилась без оголошеного коду.
  it('implements the hook codes its input is able to express', () => {
    // `UNKNOWN_RULE_KIND` хук повертає, а цей оцінювач — ні: він бере розібрану
    // модель, і невідомий вид правила нею не виражається. Тест вимагає не
    // збігу, а **названої причини** для кожної розбіжності.
    const named = new Map(refusalCodesCheckedElsewhere().map((row) => [row.code, row.checkedBy]))
    for (const code of hookRefusalCodes()) {
      if (implementedRefusalCodes().includes(code)) continue
      expect(named.get(code)).toBe('policy-decoding')
    }
    for (const code of REFUSAL_CODES) {
      if (hookRefusalCodes().includes(code)) continue
      expect(named.get(code)).toBe('token-program')
    }
    expect(implementedRefusalCodes().length + named.size).toBe(REFUSAL_CODES.length)
  })

  it('keeps the checks in the order the shared table declares', () => {
    const declared = REFUSAL_CODES.filter((code) => implementedRefusalCodes().includes(code))
    expect(implementedRefusalCodes()).toEqual(declared)
  })

  // Кожен код мусить бути досяжним: перевірка, яку жоден переказ не вмикає, —
  // це або мертвий код, або зайвий код відмови в спільній таблиці.
  const reachable: ReadonlyArray<[RefusalCode, PolicyRules, TransferContext]> = [
    ['POLICY_VERSION_MISMATCH', policy(), context({ policyVersion: 2 })],
    ['SENDER_STATUS_MISSING', policy(), context({ sender: party({ register: ABSENT }) })],
    ['RECIPIENT_STATUS_MISSING', policy(), context({ recipient: party({ register: ABSENT }) })],
    [
      'STATUS_SOURCE_NOT_ACCEPTED',
      registerOnly(),
      context({ sender: party({ provider: fromProvider(), register: ABSENT }) }),
    ],
    ['STATUS_SOURCE_UNAVAILABLE', policy(), context({ sender: party({ provider: UNAVAILABLE }) })],
    [
      'SENDER_DENIED',
      policy(),
      context({ sender: party({ register: fromRegister({ denied: true }) }) }),
    ],
    [
      'RECIPIENT_DENIED',
      policy(),
      context({ recipient: party({ register: fromRegister({ denied: true }) }) }),
    ],
    ['RECIPIENT_TIER_TOO_LOW', policy({ status: { ...bothSources, minTier: 5 } }), context()],
    ['RECIPIENT_JURISDICTION_NOT_ALLOWED', policy({ jurisdictions: ['GH'] }), context()],
    ['TRANSFER_LIMIT_EXCEEDED', policy({ transferLimit: '100' }), context({ amount: '101' })],
    [
      'VELOCITY_COUNTER_MISSING',
      policy({ periodLimit: { amount: '100', windowSeconds: 86_400 } }),
      context(),
    ],
    [
      'PERIOD_LIMIT_EXCEEDED',
      policy({ periodLimit: { amount: '100', windowSeconds: 86_400 } }),
      context({ amount: '1', velocity: { windowStart: NOW - 10, spentInWindow: '100' } }),
    ],
  ]

  it.each(reachable)('reaches %s', (code, rules, ctx) => {
    expect(verdict(rules, ctx)).toBe(code)
  })

  // Порядок значущий сам по собі: дві реалізації, які відхилили той самий
  // переказ із різних причин, розійшлися, навіть якщо обидві сказали «ні».
  it('names the first failed check, not the worst one', () => {
    const broken = context({
      policyVersion: 2,
      sender: party({ register: fromRegister({ denied: true }) }),
      amount: '10000',
    })
    expect(verdict(policy({ transferLimit: '100' }), broken)).toBe('POLICY_VERSION_MISMATCH')
  })

  it('prefers a missing status over a source that is merely not accepted', () => {
    const ctx = context({
      sender: party({ register: ABSENT }),
      recipient: party({ provider: fromProvider(), register: ABSENT }),
    })
    expect(verdict(registerOnly(), ctx)).toBe('SENDER_STATUS_MISSING')
  })

  it('prefers an unavailable source over a denial it may itself have hidden', () => {
    const ctx = context({
      sender: party({ provider: UNAVAILABLE }),
      recipient: party({ register: fromRegister({ denied: true }) }),
    })
    expect(verdict(policy(), ctx)).toBe('STATUS_SOURCE_UNAVAILABLE')
  })
})

describe('merging the two sources of status', () => {
  // FR-008a1: `sources` називає джерела, які можуть ДОЗВОЛИТИ. Заборона діє з
  // будь-якого джерела незалежно від переліку.
  it('honours a denial from a source the rule does not accept', () => {
    const ctx = context({
      sender: party({ provider: fromProvider({ denied: true }), register: fromRegister() }),
    })
    expect(verdict(registerOnly(), ctx)).toBe('SENDER_DENIED')
  })

  it('never lets an unaccepted source allow on its own', () => {
    const ctx = context({ recipient: party({ provider: fromProvider(), register: ABSENT }) })
    expect(verdict(registerOnly(), ctx)).toBe('STATUS_SOURCE_NOT_ACCEPTED')
  })

  // Розбіжність у рівні розв'язується суворішим значенням: друге джерело може
  // тільки звузити коло, дозволене першим.
  it('takes the lowest tier among the accepted sources', () => {
    const ctx = context({
      recipient: party({
        provider: fromProvider({ tier: 5 }),
        register: fromRegister({ tier: 2 }),
      }),
    })
    const strict = policyRulesSchema.parse({ status: { ...bothSources, minTier: 3 } })
    expect(verdict(strict, ctx)).toBe('RECIPIENT_TIER_TOO_LOW')
  })

  it('refuses when any accepted source names a jurisdiction outside the rule', () => {
    const ctx = context({
      recipient: party({
        provider: fromProvider({ jurisdiction: 'NG' }),
        register: fromRegister({ jurisdiction: 'GH' }),
      }),
    })
    expect(verdict(policy({ jurisdictions: ['NG'] }), ctx)).toBe(
      'RECIPIENT_JURISDICTION_NOT_ALLOWED',
    )
  })

  it('lets one accepted source carry the transfer when the other says nothing', () => {
    const ctx = context({ recipient: party({ provider: fromProvider(), register: ABSENT }) })
    expect(verdict(policy(), ctx)).toBeNull()
  })

  // FR-013: недоступність джерела не послаблює політику — навіть коли друге
  // джерело вже дало чинний дозвіл.
  it('refuses an unavailable source even when the other one allows', () => {
    const ctx = context({ recipient: party({ provider: UNAVAILABLE, register: fromRegister() }) })
    expect(verdict(policy(), ctx)).toBe('STATUS_SOURCE_UNAVAILABLE')
  })
})

describe('an attestation that is no longer current', () => {
  const shortLived = policyRulesSchema.parse({
    status: { sources: ['provider'], minTier: 0, maxAttestationAgeSeconds: 3600 },
  })

  /** Політика приймає тільки атестацію, тож реєстр у сторонах треба прибрати. */
  const onlyProvider = (over: Partial<ProviderStatus> = {}): PartyContext => ({
    provider: fromProvider(over),
    register: ABSENT,
  })

  const providerContext = (senderRecord: Partial<ProviderStatus> = {}): TransferContext =>
    context({ sender: onlyProvider(senderRecord), recipient: onlyProvider() })

  // FR-008a2: протермінована атестація прирівнюється до відсутньої, тож рішення
  // ухвалює те саме правило статусу — на виході `*_STATUS_MISSING`, а не
  // окремий код «протерміновано». Такого коду немає навмисно.
  it('reads as absent, not as a refusal of its own', () => {
    expect(verdict(shortLived, providerContext({ issuedAt: NOW - 3601 }))).toBe(
      'SENDER_STATUS_MISSING',
    )
  })

  it('is still current at the last second of its allowed age', () => {
    expect(verdict(shortLived, providerContext({ issuedAt: NOW - 3600 }))).toBeNull()
  })

  it('expires on its own `expiresAt` as well as on the policy age', () => {
    expect(verdict(shortLived, providerContext({ expiresAt: NOW }))).toBe('SENDER_STATUS_MISSING')
  })

  // Наслідок того самого правила, який легко втратити: вибуваючи з чинних
  // записів, протермінована атестація забирає з собою і свою заборону.
  it('stops denying once it is expired', () => {
    const ctx = context({
      sender: party({
        provider: fromProvider({ denied: true, expiresAt: NOW }),
        register: fromRegister(),
      }),
    })
    expect(verdict(policy(), ctx)).toBeNull()
  })

  it('lets the issuer register carry the transfer the provider can no longer support', () => {
    const ctx = context({
      sender: party({ provider: fromProvider({ expiresAt: NOW }), register: fromRegister() }),
    })
    expect(verdict(policy(), ctx)).toBeNull()
  })

  // Строк реєстру — власне поле запису; політика його віком не обмежує.
  it('applies the record expiry to the issuer register too', () => {
    const ctx = context({ sender: party({ register: fromRegister({ expiresAt: NOW }) }) })
    expect(verdict(policy(), ctx)).toBe('SENDER_STATUS_MISSING')
  })
})

describe('the limits', () => {
  it('allows a transfer of exactly the per-transfer limit', () => {
    expect(verdict(policy({ transferLimit: '100' }), context({ amount: '100' }))).toBeNull()
  })

  it('compares amounts as u64, not as doubles', () => {
    const rules = policy({ transferLimit: '18446744073709551615' })
    expect(verdict(rules, context({ amount: '18446744073709551615' }))).toBeNull()
    expect(
      verdict(
        policy({ transferLimit: '18446744073709551614' }),
        context({ amount: '18446744073709551615' }),
      ),
    ).toBe('TRANSFER_LIMIT_EXCEEDED')
  })

  const periodRules = policy({ periodLimit: { amount: '100', windowSeconds: 86_400 } })

  it('adds the transfer to what the open window already spent', () => {
    const ctx = context({
      amount: '40',
      velocity: { windowStart: NOW - 100, spentInWindow: '61' },
    })
    expect(verdict(periodRules, ctx)).toBe('PERIOD_LIMIT_EXCEEDED')
  })

  // Лічильник скидається на межі вікна, і хук робить це в тій самій інструкції.
  // Читати витрачене без порівняння з початком вікна означало б рахувати
  // позаминулий тиждень у поточному ліміті.
  it('ignores what was spent in a window that has already closed', () => {
    const ctx = context({
      amount: '100',
      velocity: { windowStart: NOW - 86_400, spentInWindow: '100' },
    })
    expect(verdict(periodRules, ctx)).toBeNull()
  })

  it('still counts the last second of an open window', () => {
    const ctx = context({
      amount: '1',
      velocity: { windowStart: NOW - 86_399, spentInWindow: '100' },
    })
    expect(verdict(periodRules, ctx)).toBe('PERIOD_LIMIT_EXCEEDED')
  })

  // Хук не створює акаунтів: лічильник з'являється при `thaw_holder`, і його
  // відсутність — відмова, а не пропуск перевірки (FR-013).
  it('refuses when the period rule has no counter to read', () => {
    expect(verdict(periodRules, context())).toBe('VELOCITY_COUNTER_MISSING')
  })

  // «Правила немає = перевірки немає»: без правила лічильник просто не читається.
  it('ignores a missing counter when no period rule asks for one', () => {
    expect(verdict(policy(), context())).toBeNull()
  })
})

describe('the token-program layer', () => {
  it('answers exactly like the evaluator when nothing blocks the transfer', () => {
    expect(simulateTransfer(policy(), context())).toEqual(evaluateTransfer(policy(), context()))
  })

  // Пауза й заморозка спрацьовують до виклику хука, тож вони перекривають
  // будь-яку відмову правил — хоча в `REFUSAL_CODES` стоять останніми.
  it('reports the pause before any rule gets a say', () => {
    const broken = context({ policyVersion: 2, sender: party({ register: ABSENT }) })
    const state = { paused: true, senderFrozen: true, recipientFrozen: false }
    expect(codeOf(simulateTransfer(policy(), broken, state))).toBe('TRANSFERS_PAUSED')
  })

  it('reports a frozen account of either party', () => {
    const state = { paused: false, senderFrozen: false, recipientFrozen: true }
    expect(codeOf(simulateTransfer(policy(), context(), state))).toBe('ACCOUNT_FROZEN')
  })
})

describe('the context it accepts', () => {
  // Контекст, якого не могло статися в мережі, дав би майстру відповідь, якої
  // ланцюг не дасть, — тому він відхиляється, а не тлумачиться.
  it('rejects a jurisdiction that is not an ISO alpha-2 code', () => {
    const ctx = context({ recipient: party({ register: fromRegister({ jurisdiction: 'ng' }) }) })
    expect(() => evaluateTransfer(policy(), ctx)).toThrow()
  })

  it('rejects an amount that is not a decimal u64 string', () => {
    expect(() => transferContextSchema.parse({ ...context(), amount: '1.5' })).toThrow()
  })

  it('rejects a source state it does not know', () => {
    const ctx = { ...context(), sender: { provider: { kind: 'maybe' }, register: ABSENT } }
    expect(() => transferContextSchema.parse(ctx)).toThrow()
  })

  it('accepts a record with no expiry at all', () => {
    expect(transferContextSchema.parse(context()).sender.register).toEqual({
      kind: 'record',
      record: registerStatus(),
    })
  })

  it('keeps the longest allowed attestation age within the model bounds', () => {
    const rules = policyRulesSchema.parse({
      status: {
        sources: ['provider'],
        minTier: 0,
        maxAttestationAgeSeconds: MAX_ATTESTATION_AGE_SECONDS,
      },
    })
    const aged: PartyContext = {
      provider: fromProvider({ issuedAt: NOW - MAX_ATTESTATION_AGE_SECONDS }),
      register: ABSENT,
    }
    const ctx = context({ sender: aged, recipient: aged })
    expect(verdict(rules, ctx)).toBeNull()
  })
})

// ─── Диференційні фікстури (SC-008, T019) ────────────────────────────────────

/**
 * Спільні фікстури `fixtures/rules/`. Цей файл — **одна з двох** сторін звірки;
 * друга — `programs/issuer-forge/tests/rules.rs`, і вона читає ті самі файли.
 *
 * **Очікуваний вердикт у фікстурі написаний рукою з вимоги, а не знятий із
 * реалізації.** Через це тест ловить не тільки розходження двох реалізацій, а й
 * згоду обох на неправильному: фікстура є специфікацією моделі, а не знімком її
 * поведінки. Ціна — кожен новий сценарій треба продумати, а не згенерувати.
 *
 * Політика лежить у фікстурі **двічі**: структурою (щоб її можна було прочитати
 * очима) і канонічними 384 байтами (бо саме їх читає Rust). Тест нижче звіряє,
 * що це те саме, тож `layout` потрапляє під ту саму звірку безкоштовно.
 */
const FIXTURE_DIR = new URL('../../../fixtures/rules/', import.meta.url)

const fixtureSchema = z.object({
  name: z.string(),
  why: z.string().min(1),
  /** Немає у фікстурі, якої модель TS не виражає, — див. `tsDecodeThrows`. */
  policy: z.unknown().optional(),
  rules: z.string().regex(/^[0-9a-f]+$/),
  context: z.unknown(),
  expect: z.union([z.literal('ALLOWED'), refusalCodeSchema]),
  /**
   * Байти, які `decodeRules` відхиляє. Такі фікстури існують: хук повертає
   * `UNKNOWN_RULE_KIND`, а модель TS невідомого виду правила не виражає взагалі.
   * Прапорець не є звільненням від перевірки — він її **міняє**: замість
   * вердикту TS-половина стверджує, що декодування кидає.
   */
  tsDecodeThrows: z.boolean().optional(),
})

type Fixture = z.infer<typeof fixtureSchema>

function loadFixtures(): Fixture[] {
  const names = readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
  return names.map((file) => {
    const parsed = fixtureSchema.parse(JSON.parse(readFileSync(new URL(file, FIXTURE_DIR), 'utf8')))
    // Ім'я файла і поле `name` — те саме: інакше повідомлення тесту вказувало б
    // не на той файл, а це найдорожча дрібниця в диференційному тесті.
    expect(`${parsed.name}.json`).toBe(file)
    return parsed
  })
}

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16))

const FIXTURES = loadFixtures()

describe('диференційні фікстури', () => {
  it('їх достатньо, і кожна названа один раз', () => {
    // SC-008 просить ≥15 сценаріїв. Число тут — не стеля, а підлога.
    expect(FIXTURES.length).toBeGreaterThanOrEqual(15)
    expect(new Set(FIXTURES.map((f) => f.name)).size).toBe(FIXTURES.length)
  })

  /**
   * Набір повний тоді, коли кожен код, який цей модуль **уміє** повернути,
   * має свій сценарій. Перелік береться з таблиці перевірок, а не з другого
   * списку тут: код, дописаний у модель без фікстури, падає цим тестом.
   */
  it('покривають кожен код відмови, який оцінювач уміє повернути', () => {
    const covered = new Set(FIXTURES.map((f) => f.expect))
    expect(implementedRefusalCodes().filter((code) => !covered.has(code))).toEqual([])
    // Дозвіл — теж вердикт, і без нього набір складався б із самих відмов.
    expect(covered.has('ALLOWED')).toBe(true)
    // Код, якого TS не виражає, теж мусить бути покритий — з іншого боку.
    expect(FIXTURES.some((f) => f.expect === 'UNKNOWN_RULE_KIND' && f.tsDecodeThrows)).toBe(true)
  })

  it.each(FIXTURES.map((f): [string, Fixture] => [f.name, f]))(
    '%s — байти політики збігаються з її структурою',
    (_name, fixture) => {
      if (fixture.tsDecodeThrows) {
        // Тут перевіряється саме те, що модель цих байтів не приймає: без цього
        // рядка фікстура була б у наборі, але нічого б не доводила.
        expect(() => decodeRules(fromHex(fixture.rules))).toThrow(PolicyLayoutError)
        return
      }
      const structured = policyRulesSchema.parse(fixture.policy)
      expect(toHex(encodeRules(structured))).toBe(fixture.rules)
      // Круг замикається в обидва боки: байти, які читає Rust, дають ту саму
      // політику, яку прочитала людина.
      expect(decodeRules(fromHex(fixture.rules))).toEqual(structured)
    },
  )

  it.each(FIXTURES.filter((f) => !f.tsDecodeThrows).map((f): [string, Fixture] => [f.name, f]))(
    '%s — вердикт збігається з написаним у фікстурі',
    (_name, fixture) => {
      const rules = decodeRules(fromHex(fixture.rules))
      const ctx = transferContextSchema.parse(fixture.context)
      const result = evaluateTransfer(rules, ctx)
      expect(result.allowed ? 'ALLOWED' : result.code).toBe(fixture.expect)
    },
  )
})
