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
   * Повторне розморожування статусу не пише: `thaw_holder` відхилив би
   * `status: Some(..)` на заповненому записі як `HolderStatusAlreadySet` (T016).
   */
  it('a repeated thaw carries no status', () => {
    expect(decideThaw(row(), true)).toEqual({ kind: 'repeat' })
  })

  // Рахунок, розморожений учора й заморожений офіцером сьогодні, у черзі не
  // стоїть — а розморозити його треба. Ончейн-запис уже є, і цього досить.
  it('a repeated thaw needs no queue row at all', () => {
    expect(decideThaw(undefined, true)).toEqual({ kind: 'repeat' })
  })

  it('without a queue row the first thaw is impossible', () => {
    expect(decideThaw(undefined, false)).toEqual({ kind: 'refuse', reason: 'not-queued' })
  })

  // Рівень і юрисдикцію ставить зарахування в чергу, тож порожніми вони бувають
  // лише в рядка, який завела не ця ручка. Присвоїти рівень наосліп не можна.
  it.each([
    ['без рівня', { tier: null }],
    ['без юрисдикції', { jurisdiction: null }],
  ])('%s — відмова, а не здогад', (_name, overrides) => {
    expect(decideThaw(row(overrides), false)).toEqual({ kind: 'refuse', reason: 'no-status' })
  })

  it('a denial from the queue row goes into the status as is', () => {
    const intent = decideThaw(row({ denied: true }), false)

    expect(intent).toEqual({ kind: 'first', status: expect.objectContaining({ denied: true }) })
  })
})

describe('expiry', () => {
  // Нуль у програмі означає «без строку» (T016), тож клієнт, який прочитав
  // ончейн-запис і надіслав його назад, не має завести рядок із 1970 роком.
  it.each([
    ['нуль', 0],
    ['null', null],
    ['відсутнє', undefined],
  ])('%s означає «без строку»', (_name, value) => {
    expect(toExpiryDate(value)).toBeNull()
  })

  it('seconds become a date and come back as the same number', () => {
    const seconds = toUnixSeconds(EXPIRES_AT)

    expect(toExpiryDate(seconds)).toEqual(EXPIRES_AT)
  })
})
