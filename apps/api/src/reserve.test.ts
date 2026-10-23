import { describe, expect, it } from 'vitest'
import { decodeCurrency, type ReserveTerms, reserveStanding } from './reserve.ts'

const ATTESTOR = 'SysvarC1ock11111111111111111111111111111111'
const FORMER = 'SysvarS1otHashes111111111111111111111111111'
const NOW = 1_800_000_000
const WEEK = 604_800

const terms = (over: Partial<ReserveTerms> = {}): ReserveTerms => ({
  issuerConfig: 'SysvarRent111111111111111111111111111111111',
  attestor: ATTESTOR,
  attestationMaxAge: WEEK,
  attestationCount: 3n,
  currency: 'NGN',
  feeBps: 12,
  latest: {
    index: 2n,
    amount: 2_000n,
    currency: 'NGN',
    attestor: ATTESTOR,
    attestedAt: NOW - 3_600,
  },
  ...over,
})

const latest = (over: Partial<NonNullable<ReserveTerms['latest']>>) => ({
  ...(terms().latest as NonNullable<ReserveTerms['latest']>),
  ...over,
})

describe('the standing of a reserve', () => {
  it('reads circulation, reserve, their difference and the age of the latest attestation', () => {
    expect(reserveStanding(terms(), 1_500n, NOW)).toEqual({
      circulation: 1_500n,
      reserve: 2_000n,
      difference: 500n,
      attestation: {
        index: 2n,
        attestor: ATTESTOR,
        attestedAt: NOW - 3_600,
        expiresAt: NOW - 3_600 + WEEK,
        ageSeconds: 3_600,
      },
      expired: false,
      attestorReplaced: false,
    })
  })

  /** A later, smaller attestation leaves circulation above the reserve; that is shown, not clamped. */
  it('a reserve below circulation is a negative difference', () => {
    expect(reserveStanding(terms(), 2_500n, NOW).difference).toBe(-500n)
  })

  it('is expired exactly where the program says so: one second past the period, not at it', () => {
    const at = (attestedAt: number) =>
      reserveStanding(terms({ latest: latest({ attestedAt }) }), 0n, NOW).expired

    expect(at(NOW - WEEK)).toBe(false)
    expect(at(NOW - WEEK - 1)).toBe(true)
  })

  it('counts the period the token has now, not the one the attestation was signed under', () => {
    const shortened = terms({ attestationMaxAge: 1_800 })
    expect(reserveStanding(shortened, 0n, NOW).expired).toBe(true)
  })

  /** Expired and "reserve short" are different reasons (FR-023a); one never hides the other. */
  it('an expired attestation still reports its reserve and difference', () => {
    const old = terms({ latest: latest({ attestedAt: NOW - 2 * WEEK }) })
    const standing = reserveStanding(old, 2_500n, NOW)

    expect(standing.expired).toBe(true)
    expect(standing.difference).toBe(-500n)
  })

  it('an attestation by an attestor since replaced opens no issuance, and says so', () => {
    const replaced = terms({ latest: latest({ attestor: FORMER }) })
    expect(reserveStanding(replaced, 0n, NOW).attestorReplaced).toBe(true)
  })

  it('a clock behind the attestation reads as age zero, not negative', () => {
    expect(reserveStanding(terms(), 0n, NOW - 7_200).attestation?.ageSeconds).toBe(0)
  })

  it('without an attestation there is no reserve, and nothing is current', () => {
    expect(reserveStanding(terms({ latest: null }), 10n, NOW)).toEqual({
      circulation: 10n,
      reserve: 0n,
      difference: -10n,
      attestation: null,
      expired: true,
      attestorReplaced: false,
    })
  })
})

describe('the currency as the account holds it', () => {
  it('drops the zero padding', () => {
    expect(decodeCurrency([78, 71, 78, 0, 0, 0, 0, 0])).toBe('NGN')
  })

  it('a full eight bytes has no padding to drop', () => {
    expect(decodeCurrency([...Buffer.from('ABCDEFGH')])).toBe('ABCDEFGH')
  })
})
