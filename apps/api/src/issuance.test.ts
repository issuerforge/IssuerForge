import { describe, expect, it } from 'vitest'
import {
  decideReservation,
  RESERVATION_TTL_MS,
  type ReservationRequest,
  type ReservationRow,
} from './issuance.ts'

const NOW = new Date('2026-08-21T12:00:00.000Z')
const MINT = 'SysvarC1ock11111111111111111111111111111111'

const request = (overrides: Partial<ReservationRequest> = {}): ReservationRequest => ({
  issuerId: '11111111111111111111111111111112',
  mint: MINT,
  symbol: 'NGNX',
  name: 'Naira Stable',
  decimals: 2,
  at: NOW,
  ...overrides,
})

const row = (overrides: Partial<ReservationRow> = {}): ReservationRow => ({
  symbol: 'NGNX',
  name: 'Naira Stable',
  decimals: 2,
  state: 'pending',
  createdAt: new Date(NOW.getTime() - 30_000),
  ...overrides,
})

describe('the same issuance', () => {
  it('a repeat with the same name, symbol and decimals takes the number for itself', () => {
    expect(decideReservation(row(), request())).toEqual({ kind: 'takeover' })
  })

  it.each([
    ['a different symbol', { symbol: 'USDX' }],
    ['a different name', { name: 'Dollar Stable' }],
    ['different decimals', { decimals: 6 }],
  ])('%s — the number is held by another issuance', (_case, difference) => {
    const decision = decideReservation(row(difference), request())

    expect(decision.kind).toBe('taken')
  })

  it('the refusal names who holds the number and since when', () => {
    const createdAt = new Date(NOW.getTime() - 60_000)
    const decision = decideReservation(
      row({ symbol: 'USDX', name: 'Dollar Stable', decimals: 6, createdAt }),
      request(),
    )

    expect(decision).toEqual({
      kind: 'taken',
      holder: { symbol: 'USDX', name: 'Dollar Stable', decimals: 6 },
      since: createdAt,
    })
  })
})

describe('reservation lifetime', () => {
  it('an abandoned reservation releases the number after the TTL', () => {
    const createdAt = new Date(NOW.getTime() - RESERVATION_TTL_MS - 1)
    const decision = decideReservation(row({ symbol: 'USDX', createdAt }), request())

    expect(decision).toEqual({ kind: 'takeover' })
  })

  it('exactly at the TTL the number is still held', () => {
    const createdAt = new Date(NOW.getTime() - RESERVATION_TTL_MS)
    const decision = decideReservation(row({ symbol: 'USDX', createdAt }), request())

    expect(decision.kind).toBe('taken')
  })
})

describe('a confirmed token', () => {
  it.each(['live', 'paused'] as const)(
    'state %s does not release the number even when stale and even for the same issuance',
    (state) => {
      const createdAt = new Date(NOW.getTime() - RESERVATION_TTL_MS - 60_000)
      const decision = decideReservation(row({ state, createdAt }), request())

      expect(decision.kind).toBe('taken')
    },
  )
})
