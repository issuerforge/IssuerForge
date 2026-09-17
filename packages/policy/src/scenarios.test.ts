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

describe('the scenario set', () => {
  it('the list and its order are those of FR-004', () => {
    expect(SCENARIO_NAMES).toEqual(['verified', 'unverified', 'over-limit', 'denied', 'paused'])
    expect(simulateScenarios(OPEN_POLICY, { now: NOW }).map((s) => s.name)).toEqual([
      ...SCENARIO_NAMES,
    ])
  })

  it('a named part of the set comes back in the order it was asked for', () => {
    const picked = simulateScenarios(OPEN_POLICY, { now: NOW, names: ['paused', 'verified'] })

    expect(picked.map((s) => s.name)).toEqual(['paused', 'verified'])
  })

  it('on the weakest policy each scenario yields the refusal it exists for', () => {
    expect(verdicts(OPEN_POLICY)).toEqual({
      verified: 'allowed',
      unverified: 'RECIPIENT_STATUS_MISSING',
      // No limit — a question without content, and it is visible as an allow rather than vanishing.
      'over-limit': 'allowed',
      denied: 'RECIPIENT_DENIED',
      paused: 'TRANSFERS_PAUSED',
    })
  })
})

describe('limits', () => {
  it('the verified transfer goes for exactly the limit and passes; limit+1 does not', () => {
    const rules = withLimits({ transferLimit: '1000' })
    const [verified, , overLimit] = simulateScenarios(rules, { now: NOW })

    expect(verified?.amount).toBe('1000')
    expect(verified?.verdict).toEqual({ allowed: true })
    expect(overLimit?.amount).toBe('1001')
    expect(overLimit?.verdict).toEqual({ allowed: false, code: 'TRANSFER_LIMIT_EXCEEDED' })
  })

  it('with two limits the smaller one is taken — the one that fires first', () => {
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

  it('a policy without limits yields the smallest amount and an inapplicable scenario', () => {
    const overLimit = buildScenario(OPEN_POLICY, 'over-limit', NOW)

    expect(overLimit.applicable).toBe(false)
    expect(overLimit.amount).toBe('1')
  })

  it('a limit at the u64 ceiling cannot be exceeded — the scenario is inapplicable', () => {
    const rules = withLimits({ transferLimit: '18446744073709551615' })

    expect(buildScenario(rules, 'over-limit', NOW).applicable).toBe(false)
  })

  it('a period limit yields a sender counter; without it there is none', () => {
    const withPeriod = buildScenario(
      withLimits({ periodLimit: { amount: '900', windowSeconds: 86_400 } }),
      'verified',
      NOW,
    )

    expect(withPeriod.context.velocity).toEqual({ windowStart: NOW, spentInWindow: '0' })
    expect(buildScenario(OPEN_POLICY, 'verified', NOW).context.velocity).toBeUndefined()
  })
})

describe('the parties to the transfer', () => {
  it('a record is placed only into the sources the rule accepts', () => {
    const rules = withLimits({ status: { sources: ['register'], minTier: 2 } })
    const { context } = buildScenario(rules, 'verified', NOW)

    expect(context.recipient.provider).toEqual({ kind: 'absent' })
    expect(context.recipient.register).toEqual({
      kind: 'record',
      record: { denied: false, tier: 2, jurisdiction: SIMULATED_JURISDICTION, expiresAt: null },
    })
  })

  it('a provider attestation issued just now — its age does not make it expired', () => {
    const rules = withLimits({
      status: { sources: ['provider'], minTier: 0, maxAttestationAgeSeconds: 3600 },
    })
    const { context } = buildScenario(rules, 'verified', NOW)

    expect(context.recipient.provider).toMatchObject({ kind: 'record', record: { issuedAt: NOW } })
    expect(simulateScenarios(rules, { now: NOW, names: ['verified'] })[0]?.verdict).toEqual({
      allowed: true,
    })
  })

  it("the recipient's tier equals the policy minimum, not an invented number", () => {
    const rules = withLimits({ status: { sources: ['register'], minTier: 7 } })

    expect(verdicts(rules).verified).toBe('allowed')
  })

  it('the jurisdiction is taken from the allowed ones when the country rule exists', () => {
    const rules = withLimits({ jurisdictions: ['NG', 'KE'] })
    const { context } = buildScenario(rules, 'verified', NOW)

    // The list is normalised by sorting, so the first is `KE`, not the one
    // that came first in the request. That is the one the scenario must take.
    expect(context.recipient.register).toMatchObject({ record: { jurisdiction: 'KE' } })
    expect(verdicts(rules).verified).toBe('allowed')
  })

  it('the sender is verified in every scenario — the refusal concerns the recipient', () => {
    for (const name of SCENARIO_NAMES) {
      const { context } = buildScenario(OPEN_POLICY, name, NOW)
      expect(context.sender.register).toMatchObject({ kind: 'record', record: { denied: false } })
    }
  })

  it('policy versions match — a version mismatch is not a rules scenario', () => {
    const { context } = buildScenario(OPEN_POLICY, 'verified', NOW)

    expect(context.policyVersion).toBe(context.mintPolicyVersion)
  })
})

describe('input', () => {
  it('a broken time is rejected by the schema', () => {
    expect(() => buildScenario(OPEN_POLICY, 'verified', -1)).toThrow()
  })

  it('a broken policy is rejected by the schema', () => {
    const broken = { status: { sources: [], minTier: 0 } } as unknown as PolicyRules

    expect(() => buildScenario(broken, 'verified', NOW)).toThrow()
  })
})
