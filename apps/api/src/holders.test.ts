import { describe, expect, it } from 'vitest'
import { decideThaw, type HolderRow, toExpiryDate, toUnixSeconds } from './holders.ts'

const REQUESTED_AT = new Date('2026-08-21T10:00:00.000Z')
const EXPIRES_AT = new Date('2027-01-01T00:00:00.000Z')

const row = (overrides: Partial<HolderRow> = {}): HolderRow => ({
  wallet: 'SysvarC1ock11111111111111111111111111111111',
  state: 'pending',
  tier: 2,
  jurisdiction: 'UA',
  denied: false,
  expiresAt: null,
  requestedAt: REQUESTED_AT,
  thawedAt: null,
  ...overrides,
})

describe('the thaw decision', () => {
  it('the first thaw carries the status from the queue row', () => {
    expect(decideThaw(row({ expiresAt: EXPIRES_AT }), false)).toEqual({
      kind: 'first',
      status: { tier: 2, jurisdiction: 'UA', denied: false, expiresAt: toUnixSeconds(EXPIRES_AT) },
    })
  })

  it('no expiry is exactly `null` — not zero and not "now"', () => {
    const intent = decideThaw(row(), false)

    expect(intent).toEqual({ kind: 'first', status: expect.objectContaining({ expiresAt: null }) })
  })

  /**
   * A repeat thaw does not write the status: `thaw_holder` would reject
   * `status: Some(..)` on a filled record as `HolderStatusAlreadySet` (T016).
   */
  it('a repeated thaw carries no status', () => {
    expect(decideThaw(row(), true)).toEqual({ kind: 'repeat' })
  })

  // An account thawed yesterday and frozen by an officer today is not in the
  // queue — yet it has to be thawed. The on-chain record already exists, and
  // that is enough.
  it('a repeated thaw needs no queue row at all', () => {
    expect(decideThaw(undefined, true)).toEqual({ kind: 'repeat' })
  })

  it('without a queue row the first thaw is impossible', () => {
    expect(decideThaw(undefined, false)).toEqual({ kind: 'refuse', reason: 'not-queued' })
  })

  // The tier and the jurisdiction are set by joining the queue, so they are
  // empty only in a row this handler did not create. A tier must not be
  // assigned blindly.
  it.each([
    ['no tier', { tier: null }],
    ['no jurisdiction', { jurisdiction: null }],
  ])('%s — a refusal, not a guess', (_name, overrides) => {
    expect(decideThaw(row(overrides), false)).toEqual({ kind: 'refuse', reason: 'no-status' })
  })

  it('a denial from the queue row goes into the status as is', () => {
    const intent = decideThaw(row({ denied: true }), false)

    expect(intent).toEqual({ kind: 'first', status: expect.objectContaining({ denied: true }) })
  })
})

describe('expiry', () => {
  // Zero in the program means "no expiry" (T016), so a client that read the
  // on-chain record and sent it back must not create a row dated 1970.
  it.each([
    ['zero', 0],
    ['null', null],
    ['absent', undefined],
  ])('%s means "no expiry"', (_name, value) => {
    expect(toExpiryDate(value)).toBeNull()
  })

  it('seconds become a date and come back as the same number', () => {
    const seconds = toUnixSeconds(EXPIRES_AT)

    expect(toExpiryDate(seconds)).toEqual(EXPIRES_AT)
  })
})
