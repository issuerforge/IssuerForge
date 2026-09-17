import { REFUSAL_CODES } from '@forge/shared/refusal'
import { describe, expect, it } from 'vitest'
import {
  MAX_ATTESTATION_AGE_SECONDS,
  MAX_JURISDICTIONS,
  MAX_PERIOD_SECONDS,
  MAX_RULE_SLOTS,
  MIN_ATTESTATION_AGE_SECONDS,
  MIN_PERIOD_SECONDS,
  OPEN_POLICY,
  policyRulesSchema,
  RULE_KIND,
  RULE_KIND_NAMES,
  RULE_PARAMS_BYTES,
  STATUS_SOURCE,
  STATUS_SOURCE_ALL,
  STATUS_SOURCES,
  statusRuleSchema,
  statusSourceMask,
  usedRuleSlots,
} from './model.ts'

const status = {
  sources: ['provider', 'register'] as const,
  minTier: 2,
  maxAttestationAgeSeconds: 30 * 24 * 3600,
}

const fullPolicy = {
  status,
  jurisdictions: ['NG', 'GH', 'KE'],
  transferLimit: '50000000',
  periodLimit: { amount: '200000000', windowSeconds: 86_400 },
}

const problems = (value: unknown): string[] => {
  const parsed = policyRulesSchema.safeParse(value)
  return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
}

describe('the rule kinds', () => {
  // Zero is an empty slot in a fixed-length array. A rule kind with code 0
  // would turn the tail of zeros into sixteen silent rules.
  it('never uses zero, which belongs to the empty slot', () => {
    expect(Object.values(RULE_KIND).every((kind) => kind > 0)).toBe(true)
  })

  it('numbers every kind uniquely', () => {
    const codes = Object.values(RULE_KIND)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('fits the fixed slot array with room to grow', () => {
    expect(RULE_KIND_NAMES.length).toBeLessThanOrEqual(MAX_RULE_SLOTS)
  })

  // A pause is executed by the Pausable extension, not by the hook, so it must
  // not be a rule kind either. The test pins down exactly this decision:
  // `TRANSFERS_PAUSED` exists among the refusal codes, and the temptation to
  // add a rule for it is quite real.
  it('has no kind for pausing, which the mint extension does', () => {
    expect(REFUSAL_CODES).toContain('TRANSFERS_PAUSED')
    expect(RULE_KIND_NAMES).not.toContain('PAUSE')
  })
})

describe('status sources', () => {
  it('keeps the mask and the tuple from drifting apart', () => {
    expect(Object.keys(STATUS_SOURCE)).toEqual([...STATUS_SOURCES])
    expect(statusSourceMask(STATUS_SOURCES)).toBe(STATUS_SOURCE_ALL)
  })

  it('builds a mask from any subset', () => {
    expect(statusSourceMask([])).toBe(0)
    expect(statusSourceMask(['register'])).toBe(STATUS_SOURCE.register)
  })

  // A set has no order, and `rules_hash` (T012) must be the same for the same
  // content — otherwise the wizard says "policy changed" on swapping two
  // checkboxes.
  it('normalises the order of sources', () => {
    const reversed = statusRuleSchema.parse({ ...status, sources: ['register', 'provider'] })
    expect(reversed.sources).toEqual(['provider', 'register'])
  })

  it('refuses an empty source list instead of reading it as "anyone"', () => {
    expect(statusRuleSchema.safeParse({ ...status, sources: [] }).success).toBe(false)
  })

  it('refuses the same source twice', () => {
    expect(
      statusRuleSchema.safeParse({ ...status, sources: ['register', 'register'] }).success,
    ).toBe(false)
  })
})

describe('the status rule', () => {
  // FR-008a2: an attestation without a validity period is a verification done
  // once and valid forever.
  it('demands an expiry whenever it accepts provider attestations', () => {
    const missing = statusRuleSchema.safeParse({ sources: ['provider'], minTier: 0 })
    expect(missing.success).toBe(false)
    expect(missing.error?.issues[0]?.path).toEqual(['maxAttestationAgeSeconds'])
  })

  it('needs no expiry when only the issuer register is accepted', () => {
    expect(statusRuleSchema.safeParse({ sources: ['register'], minTier: 0 }).success).toBe(true)
  })

  it('bounds the expiry at both ends', () => {
    for (const seconds of [MIN_ATTESTATION_AGE_SECONDS, MAX_ATTESTATION_AGE_SECONDS]) {
      expect(
        statusRuleSchema.safeParse({ ...status, maxAttestationAgeSeconds: seconds }).success,
      ).toBe(true)
    }
    for (const seconds of [MIN_ATTESTATION_AGE_SECONDS - 1, MAX_ATTESTATION_AGE_SECONDS + 1]) {
      expect(
        statusRuleSchema.safeParse({ ...status, maxAttestationAgeSeconds: seconds }).success,
      ).toBe(false)
    }
  })

  it('takes tier zero as "any current status" and stops at the byte', () => {
    expect(statusRuleSchema.safeParse({ ...status, minTier: 0 }).success).toBe(true)
    expect(statusRuleSchema.safeParse({ ...status, minTier: 255 }).success).toBe(true)
    expect(statusRuleSchema.safeParse({ ...status, minTier: 256 }).success).toBe(false)
    expect(statusRuleSchema.safeParse({ ...status, minTier: -1 }).success).toBe(false)
  })
})

describe('the policy body', () => {
  it('accepts a policy with every rule set', () => {
    expect(policyRulesSchema.parse(fullPolicy)).toMatchObject({
      jurisdictions: ['GH', 'KE', 'NG'],
      transferLimit: '50000000',
    })
  })

  // A policy without an answer to "who may hold" is impossible by type:
  // FR-008b1 requires a continuous status check, not a one-off thaw.
  it('refuses a policy with no status rule', () => {
    expect(problems({ transferLimit: '1' })).toEqual([
      'status: Invalid input: expected object, received undefined',
    ])
    expect(problems({})).toHaveLength(1)
  })

  it('treats every other rule as optional', () => {
    expect(policyRulesSchema.safeParse({ status }).success).toBe(true)
  })

  it('sorts jurisdictions so the same set hashes the same', () => {
    const one = policyRulesSchema.parse({ status, jurisdictions: ['KE', 'NG', 'GH'] })
    const two = policyRulesSchema.parse({ status, jurisdictions: ['GH', 'NG', 'KE'] })
    expect(one.jurisdictions).toEqual(two.jurisdictions)
  })

  it('stops at the number of jurisdictions the slot holds', () => {
    const codes = Array.from(
      { length: MAX_JURISDICTIONS },
      (_, i) => `A${String.fromCharCode(65 + i)}`,
    )
    expect(policyRulesSchema.safeParse({ status, jurisdictions: codes }).success).toBe(true)
    expect(policyRulesSchema.safeParse({ status, jurisdictions: [...codes, 'ZZ'] }).success).toBe(
      false,
    )
  })

  // The ceiling is not chosen but computed from the slot budget: two ASCII bytes per code.
  it('derives that ceiling from the slot budget, not from taste', () => {
    expect(MAX_JURISDICTIONS * 2).toBe(RULE_PARAMS_BYTES)
  })

  it('refuses a lower-case or malformed jurisdiction', () => {
    for (const code of ['ng', 'NGA', 'N', '']) {
      expect(policyRulesSchema.safeParse({ status, jurisdictions: [code] }).success).toBe(false)
    }
  })

  it('refuses the same jurisdiction twice', () => {
    expect(policyRulesSchema.safeParse({ status, jurisdictions: ['NG', 'NG'] }).success).toBe(false)
  })

  it('refuses an empty jurisdiction list instead of reading it as "all"', () => {
    expect(policyRulesSchema.safeParse({ status, jurisdictions: [] }).success).toBe(false)
  })
})

describe('limits', () => {
  // Zero and absence would say opposite things equally inconspicuously.
  it('refuses a zero limit, which is a stopped token and not a limit', () => {
    expect(policyRulesSchema.safeParse({ status, transferLimit: '0' }).success).toBe(false)
    expect(
      policyRulesSchema.safeParse({ status, periodLimit: { amount: '0', windowSeconds: 86_400 } })
        .success,
    ).toBe(false)
  })

  it('carries amounts as decimal strings, because u64 does not fit a double', () => {
    const parsed = policyRulesSchema.parse({ status, transferLimit: '18446744073709551615' })
    expect(parsed.transferLimit).toBe('18446744073709551615')
    expect(
      policyRulesSchema.safeParse({ status, transferLimit: '18446744073709551616' }).success,
    ).toBe(false)
  })

  it('refuses an amount that is a number, not a string', () => {
    expect(policyRulesSchema.safeParse({ status, transferLimit: 500 }).success).toBe(false)
  })

  it('bounds the period window at both ends', () => {
    for (const windowSeconds of [MIN_PERIOD_SECONDS, MAX_PERIOD_SECONDS]) {
      expect(
        policyRulesSchema.safeParse({ status, periodLimit: { amount: '1', windowSeconds } })
          .success,
      ).toBe(true)
    }
    for (const windowSeconds of [MIN_PERIOD_SECONDS - 1, MAX_PERIOD_SECONDS + 1]) {
      expect(
        policyRulesSchema.safeParse({ status, periodLimit: { amount: '1', windowSeconds } })
          .success,
      ).toBe(false)
    }
  })
})

describe('slot budget', () => {
  it('counts the slots a policy will occupy', () => {
    expect(usedRuleSlots(OPEN_POLICY)).toBe(1)
    expect(usedRuleSlots(policyRulesSchema.parse(fullPolicy))).toBe(4)
  })

  it('never asks for more slots than the account holds', () => {
    expect(usedRuleSlots(policyRulesSchema.parse(fullPolicy))).toBeLessThanOrEqual(MAX_RULE_SLOTS)
  })
})

describe('OPEN_POLICY', () => {
  // The reference point must be a valid value, not a hypothesis in a comment.
  it('parses as a real policy', () => {
    expect(policyRulesSchema.parse(OPEN_POLICY)).toEqual(OPEN_POLICY)
  })

  it('still demands a status: the weakest policy is not an absent one', () => {
    expect(OPEN_POLICY.status.sources).toEqual([...STATUS_SOURCES])
    expect(OPEN_POLICY.status.minTier).toBe(0)
    expect(OPEN_POLICY.jurisdictions).toBeUndefined()
    expect(OPEN_POLICY.transferLimit).toBeUndefined()
    expect(OPEN_POLICY.periodLimit).toBeUndefined()
  })
})
