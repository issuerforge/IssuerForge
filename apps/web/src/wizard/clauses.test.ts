import { describe, expect, it } from 'vitest'
import { buildClauses } from './clauses.ts'
import { type Draft, EMPTY_DRAFT } from './draft.ts'

const draft = (overrides: Partial<Draft> = {}): Draft => ({
  ...EMPTY_DRAFT,
  name: 'Vantara Naira',
  symbol: 'vNGN',
  decimals: '2',
  initialSupply: '25000000',
  ...overrides,
})

const textOf = (source: Draft, id: string): string =>
  buildClauses(source).find((clause) => clause.id === id)?.text ?? ''

describe('the rulebook', () => {
  it('writes the amount in token units, not the smallest ones', () => {
    expect(textOf(draft(), '1.3')).toContain('25,000,000.00 vNGN')
  })

  it('decimals 0 adds no decimal point', () => {
    expect(textOf(draft({ decimals: '0', initialSupply: '1000' }), '1.3')).toContain('1,000 vNGN')
  })

  // A policy with no status source at all refuses every transfer. That must
  // be a sentence, not an empty space: the absence of text reads as "nothing
  // special", while it means the opposite.
  it('an empty source list is spelled out, not skipped', () => {
    expect(textOf(draft({ sources: [] }), '2.1')).toContain('no account may receive this token')
  })

  it('the attestation term appears only together with the provider', () => {
    const withProvider = buildClauses(draft({ sources: ['provider', 'register'] }))
    const withoutProvider = buildClauses(draft({ sources: ['register'] }))

    expect(withProvider.some((c) => c.text.includes('counts as absent'))).toBe(true)
    expect(withoutProvider.some((c) => c.text.includes('counts as absent'))).toBe(false)
  })

  // "No limit" is a rule too, and it has to be read. A vanished line would
  // read as "there is a limit, it just was not shown".
  it('a missing limit remains a sentence', () => {
    expect(textOf(draft(), '3.1')).toContain('not capped')
    expect(textOf(draft({ transferLimit: '500000' }), '3.1')).toContain('500,000.00 vNGN')
  })

  it('an empty jurisdiction means "not checked", not "nobody"', () => {
    const clauses = buildClauses(draft({ jurisdictions: '' }))

    expect(clauses.some((c) => c.text.includes('may be resident anywhere'))).toBe(true)
  })

  it('the country list reads in human language', () => {
    const clauses = buildClauses(draft({ jurisdictions: 'NG, GH, KE' }))

    expect(clauses.some((c) => c.text.includes('NG, GH or KE'))).toBe(true)
  })

  it('hours fold into days when they divide evenly', () => {
    expect(textOf(draft({ reserveAgeHours: '48' }), '4.2')).toContain('2 days')
    expect(textOf(draft({ reserveAgeHours: '5' }), '4.2')).toContain('5 hours')
  })

  it('every sentence knows which step governs it', () => {
    for (const clause of buildClauses(draft())) {
      expect(clause.step).toBeGreaterThanOrEqual(1)
      expect(clause.step).toBeLessThanOrEqual(4)
    }
  })

  it('sentence numbers do not repeat', () => {
    const ids = buildClauses(draft()).map((clause) => clause.id)

    expect(new Set(ids).size).toBe(ids.length)
  })
})
