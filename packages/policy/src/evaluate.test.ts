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

/** A fixed block time: the evaluator's result must not depend on the clock. */
const NOW = 1_800_000_000

const bothSources: PolicyRules['status'] = {
  sources: ['provider', 'register'],
  minTier: 0,
  maxAttestationAgeSeconds: 30 * 24 * 3600,
}

const policy = (over: Partial<PolicyRules> = {}): PolicyRules =>
  policyRulesSchema.parse({ status: bothSources, ...over })

/** A policy that accepts a status only from the issuer's own registry. */
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

/** By default a party has a current record in the registry and nothing at the provider. */
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

/** The refusal code, or `null` on an allow — so verdicts read as one column. */
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
  // The list of checks does not live in the evaluator: it walks
  // `REFUSAL_CODES`. This test catches the reverse — a refusal code declared
  // as the hook's with no check for it, and a check left without a declared
  // code.
  it('implements the hook codes its input is able to express', () => {
    // The hook returns `UNKNOWN_RULE_KIND`, this evaluator does not: it takes
    // the parsed model, and an unknown rule kind cannot be expressed by it. The
    // test demands not a match but a **named reason** for every divergence.
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

  // Every code must be reachable: a check that no transfer triggers is either
  // dead code or a redundant refusal code in the shared table.
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

  // The order is significant in itself: two implementations that rejected the
  // same transfer for different reasons have diverged, even if both said "no".
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
  // FR-008a1: `sources` names the sources that may ALLOW. A denial applies
  // from any source regardless of the list.
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

  // A disagreement on the tier resolves to the stricter value: the second
  // source can only narrow the circle allowed by the first.
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

  // FR-013: source unavailability does not weaken the policy — even when the
  // second source has already given a current allow.
  it('refuses an unavailable source even when the other one allows', () => {
    const ctx = context({ recipient: party({ provider: UNAVAILABLE, register: fromRegister() }) })
    expect(verdict(policy(), ctx)).toBe('STATUS_SOURCE_UNAVAILABLE')
  })
})

describe('an attestation that is no longer current', () => {
  const shortLived = policyRulesSchema.parse({
    status: { sources: ['provider'], minTier: 0, maxAttestationAgeSeconds: 3600 },
  })

  /** The policy accepts only the attestation, so the registry must be removed from the parties. */
  const onlyProvider = (over: Partial<ProviderStatus> = {}): PartyContext => ({
    provider: fromProvider(over),
    register: ABSENT,
  })

  const providerContext = (senderRecord: Partial<ProviderStatus> = {}): TransferContext =>
    context({ sender: onlyProvider(senderRecord), recipient: onlyProvider() })

  // FR-008a2: an expired attestation is treated as absent, so the decision is
  // made by the same status rule — the outcome is `*_STATUS_MISSING`, not a
  // separate "expired" code. There is deliberately no such code.
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

  // A consequence of the same rule that is easy to lose: dropping out of the
  // current records, an expired attestation takes its denial with it.
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

  // The registry expiry is the record's own field; the policy does not bound it by age.
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

  // The counter resets at the window boundary, and the hook does that in the
  // same instruction. Reading the spent amount without comparing against the
  // window start would mean counting the week before last into the current
  // limit.
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

  // The hook creates no accounts: the counter appears at `thaw_holder`, and
  // its absence is a refusal, not a skipped check (FR-013).
  it('refuses when the period rule has no counter to read', () => {
    expect(verdict(periodRules, context())).toBe('VELOCITY_COUNTER_MISSING')
  })

  // "No rule = no check": without the rule the counter is simply not read.
  it('ignores a missing counter when no period rule asks for one', () => {
    expect(verdict(policy(), context())).toBeNull()
  })
})

describe('the token-program layer', () => {
  it('answers exactly like the evaluator when nothing blocks the transfer', () => {
    expect(simulateTransfer(policy(), context())).toEqual(evaluateTransfer(policy(), context()))
  })

  // Pause and freeze fire before the hook is called, so they override any
  // rule refusal — even though they come last in `REFUSAL_CODES`.
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
  // A context that could not have happened on the network would give the
  // wizard an answer the chain will not give — so it is rejected, not
  // interpreted.
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

// ─── Differential fixtures (SC-008, T019) ────────────────────────────────────

/**
 * The shared fixtures in `fixtures/rules/`. This file is **one of the two**
 * sides of the comparison; the other is `programs/issuer-forge/tests/rules.rs`,
 * and it reads the same files.
 *
 * **The expected verdict in a fixture is written by hand from the
 * requirement, not taken from the implementation.** Because of that the test
 * catches not only a divergence between the two implementations but also
 * both agreeing on the wrong thing: the fixture is a specification of the
 * model, not a snapshot of its behaviour. The price is that every new
 * scenario has to be thought through, not generated.
 *
 * The policy sits in the fixture **twice**: as a structure (so it can be read
 * by eye) and as the canonical 384 bytes (because that is what Rust reads).
 * The test below checks that they are the same thing, so `layout` falls under
 * the same comparison for free.
 */
const FIXTURE_DIR = new URL('../../../fixtures/rules/', import.meta.url)

const fixtureSchema = z.object({
  name: z.string(),
  why: z.string().min(1),
  /** Absent from a fixture the TS model cannot express — see `tsDecodeThrows`. */
  policy: z.unknown().optional(),
  rules: z.string().regex(/^[0-9a-f]+$/),
  context: z.unknown(),
  expect: z.union([z.literal('ALLOWED'), refusalCodeSchema]),
  /**
   * Bytes that `decodeRules` rejects. Such fixtures exist: the hook returns
   * `UNKNOWN_RULE_KIND`, while the TS model cannot express an unknown rule
   * kind at all. The flag is not an exemption from the check — it **changes**
   * it: instead of a verdict, the TS half asserts that decoding throws.
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
    // The file name and the `name` field are the same thing: otherwise the
    // test message would point at the wrong file, and that is the costliest
    // trifle in a differential test.
    expect(`${parsed.name}.json`).toBe(file)
    return parsed
  })
}

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16))

const FIXTURES = loadFixtures()

describe('differential fixtures', () => {
  it('there are enough of them, and each is named once', () => {
    // SC-008 asks for ≥15 scenarios. The number here is a floor, not a ceiling.
    expect(FIXTURES.length).toBeGreaterThanOrEqual(15)
    expect(new Set(FIXTURES.map((f) => f.name)).size).toBe(FIXTURES.length)
  })

  /**
   * The set is complete when every code this module **can** return has its
   * own scenario. The list is taken from the table of checks, not from a
   * second list here: a code added to the model without a fixture fails this
   * test.
   */
  it('cover every refusal code the evaluator can return', () => {
    const covered = new Set(FIXTURES.map((f) => f.expect))
    expect(implementedRefusalCodes().filter((code) => !covered.has(code))).toEqual([])
    // An allow is a verdict too, and without it the set would consist of nothing but refusals.
    expect(covered.has('ALLOWED')).toBe(true)
    // A code TS cannot express must be covered too — from the other side.
    expect(FIXTURES.some((f) => f.expect === 'UNKNOWN_RULE_KIND' && f.tsDecodeThrows)).toBe(true)
  })

  it.each(FIXTURES.map((f): [string, Fixture] => [f.name, f]))(
    '%s — the policy bytes match its structure',
    (_name, fixture) => {
      if (fixture.tsDecodeThrows) {
        // What is checked here is precisely that the model does not accept these
        // bytes: without this line the fixture would be in the set but prove
        // nothing.
        expect(() => decodeRules(fromHex(fixture.rules))).toThrow(PolicyLayoutError)
        return
      }
      const structured = policyRulesSchema.parse(fixture.policy)
      expect(toHex(encodeRules(structured))).toBe(fixture.rules)
      // The circle closes in both directions: the bytes Rust reads yield the
      // same policy a person read.
      expect(decodeRules(fromHex(fixture.rules))).toEqual(structured)
    },
  )

  it.each(FIXTURES.filter((f) => !f.tsDecodeThrows).map((f): [string, Fixture] => [f.name, f]))(
    '%s — the verdict matches what is written in the fixture',
    (_name, fixture) => {
      const rules = decodeRules(fromHex(fixture.rules))
      const ctx = transferContextSchema.parse(fixture.context)
      const result = evaluateTransfer(rules, ctx)
      expect(result.allowed ? 'ALLOWED' : result.code).toBe(fixture.expect)
    },
  )
})
