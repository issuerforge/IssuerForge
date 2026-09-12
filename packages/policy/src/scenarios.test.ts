import { describe, expect, it } from 'vitest'
import { OPEN_POLICY, type PolicyRules } from './model.ts'
import {
  buildScenario,
  SCENARIO_NAMES,
  type ScenarioName,
  SIMULATED_JURISDICTION,
  simulateScenarios,
} from './scenarios.ts'

const NOW = 1_800_000_000

const withLimits = (rules: Partial<PolicyRules> = {}): PolicyRules => ({ ...OPEN_POLICY, ...rules })

const verdicts = (rules: PolicyRules) =>
  Object.fromEntries(
    simulateScenarios(rules, { now: NOW }).map((s) => [
      s.name,
      s.verdict.allowed ? 'allowed' : s.verdict.code,
    ]),
  ) as Record<ScenarioName, string>

describe('набір сценаріїв', () => {
  it('перелік і порядок — ті самі, що у FR-004', () => {
    expect(SCENARIO_NAMES).toEqual(['verified', 'unverified', 'over-limit', 'denied', 'paused'])
    expect(simulateScenarios(OPEN_POLICY, { now: NOW }).map((s) => s.name)).toEqual([
      ...SCENARIO_NAMES,
    ])
  })

  it('названа частина набору повертається в тому порядку, у якому її просили', () => {
    const picked = simulateScenarios(OPEN_POLICY, { now: NOW, names: ['paused', 'verified'] })

    expect(picked.map((s) => s.name)).toEqual(['paused', 'verified'])
  })

  it('на найслабшій політиці кожен сценарій дає ту відмову, заради якої існує', () => {
    expect(verdicts(OPEN_POLICY)).toEqual({
      verified: 'allowed',
      unverified: 'RECIPIENT_STATUS_MISSING',
      // Ліміту немає — питання без змісту, і воно видиме як дозвіл, а не зникає.
      'over-limit': 'allowed',
      denied: 'RECIPIENT_DENIED',
      paused: 'TRANSFERS_PAUSED',
    })
  })
})

describe('ліміти', () => {
  it('верифікований переказ іде рівно на ліміт і проходить, ліміт+1 — ні', () => {
    const rules = withLimits({ transferLimit: '1000' })
    const [verified, , overLimit] = simulateScenarios(rules, { now: NOW })

    expect(verified?.amount).toBe('1000')
    expect(verified?.verdict).toEqual({ allowed: true })
    expect(overLimit?.amount).toBe('1001')
    expect(overLimit?.verdict).toEqual({ allowed: false, code: 'TRANSFER_LIMIT_EXCEEDED' })
  })

  it('за двох лімітів береться менший — той, що спрацює першим', () => {
    const rules = withLimits({
      transferLimit: '5000',
      periodLimit: { amount: '900', windowSeconds: 86_400 },
    })
    const overLimit = buildScenario(rules, 'over-limit', NOW)

    expect(overLimit.amount).toBe('901')
    expect(simulateScenarios(rules, { now: NOW, names: ['over-limit'] })[0]?.verdict).toEqual({
      allowed: false,
      code: 'PERIOD_LIMIT_EXCEEDED',
    })
  })

  it('політика без лімітів дає найменшу суму й незастосовний сценарій', () => {
    const overLimit = buildScenario(OPEN_POLICY, 'over-limit', NOW)

    expect(overLimit.applicable).toBe(false)
    expect(overLimit.amount).toBe('1')
  })

  it('ліміт у стелю u64 перевищити нічим — сценарій незастосовний', () => {
    const rules = withLimits({ transferLimit: '18446744073709551615' })

    expect(buildScenario(rules, 'over-limit', NOW).applicable).toBe(false)
  })

  it('ліміт за період дає лічильник відправника, без нього — не дає', () => {
    const withPeriod = buildScenario(
      withLimits({ periodLimit: { amount: '900', windowSeconds: 86_400 } }),
      'verified',
      NOW,
    )

    expect(withPeriod.context.velocity).toEqual({ windowStart: NOW, spentInWindow: '0' })
    expect(buildScenario(OPEN_POLICY, 'verified', NOW).context.velocity).toBeUndefined()
  })
})

describe('сторони переказу', () => {
  it('запис кладеться тільки в джерела, які приймає правило', () => {
    const rules = withLimits({ status: { sources: ['register'], minTier: 2 } })
    const { context } = buildScenario(rules, 'verified', NOW)

    expect(context.recipient.provider).toEqual({ kind: 'absent' })
    expect(context.recipient.register).toEqual({
      kind: 'record',
      record: { denied: false, tier: 2, jurisdiction: SIMULATED_JURISDICTION, expiresAt: null },
    })
  })

  it('атестація провайдера видана щойно — вік не робить її протермінованою', () => {
    const rules = withLimits({
      status: { sources: ['provider'], minTier: 0, maxAttestationAgeSeconds: 3600 },
    })
    const { context } = buildScenario(rules, 'verified', NOW)

    expect(context.recipient.provider).toMatchObject({ kind: 'record', record: { issuedAt: NOW } })
    expect(simulateScenarios(rules, { now: NOW, names: ['verified'] })[0]?.verdict).toEqual({
      allowed: true,
    })
  })

  it('рівень отримувача дорівнює мінімальному з політики, а не вигаданому числу', () => {
    const rules = withLimits({ status: { sources: ['register'], minTier: 7 } })

    expect(verdicts(rules).verified).toBe('allowed')
  })

  it('юрисдикція береться з дозволених, коли правило країн є', () => {
    const rules = withLimits({ jurisdictions: ['NG', 'KE'] })
    const { context } = buildScenario(rules, 'verified', NOW)

    // Перелік нормалізований сортуванням, тож перша — `KE`, а не та, що стояла
    // першою в запиті. Саме її й мусить взяти сценарій.
    expect(context.recipient.register).toMatchObject({ record: { jurisdiction: 'KE' } })
    expect(verdicts(rules).verified).toBe('allowed')
  })

  it('відправник верифікований у кожному сценарії — відмова стосується отримувача', () => {
    for (const name of SCENARIO_NAMES) {
      const { context } = buildScenario(OPEN_POLICY, name, NOW)
      expect(context.sender.register).toMatchObject({ kind: 'record', record: { denied: false } })
    }
  })

  it('версії політики збігаються — розбіжність версій не є сценарієм правил', () => {
    const { context } = buildScenario(OPEN_POLICY, 'verified', NOW)

    expect(context.policyVersion).toBe(context.mintPolicyVersion)
  })
})

describe('вхід', () => {
  it('битий час відкидається схемою', () => {
    expect(() => buildScenario(OPEN_POLICY, 'verified', -1)).toThrow()
  })

  it('бита політика відкидається схемою', () => {
    const broken = { status: { sources: [], minTier: 0 } } as unknown as PolicyRules

    expect(() => buildScenario(broken, 'verified', NOW)).toThrow()
  })
})
