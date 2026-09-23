import { describe, expect, it } from 'vitest'
import {
  type Bound,
  type Frontier,
  formatCursor,
  isEmpty,
  parseBound,
  parseCursor,
  resolveWindow,
  type TimeBracket,
} from './journal.ts'

const SIGNATURE = '5'.repeat(88)

const frontier = (horizonSlot: number, indexedThroughSlot = horizonSlot + 1): Frontier => ({
  indexedThroughSlot,
  horizonSlot,
})

const nothing: TimeBracket = { fromSlot: null, toSlot: null }

describe('parseBound', () => {
  it('reads a run of digits as a slot', () => {
    expect(parseBound('501913340', 'from')).toEqual({ kind: 'slot', slot: 501_913_340 })
  })

  it('reads an ISO instant as a time', () => {
    expect(parseBound('2026-09-01T00:00:00Z', 'from')).toEqual({
      kind: 'time',
      unix: 1_788_220_800,
    })
  })

  it('closes a bare date at the end of its day when it is the upper bound', () => {
    const from = parseBound('2026-09-30', 'from')
    const to = parseBound('2026-09-30', 'to')
    // Both name the same day; only the upper one means "all of it". Taken
    // literally, `to` would be midnight and the period would lose its last day.
    expect(to).toEqual({ kind: 'time', unix: (from as { unix: number }).unix + 86_399 })
  })

  it('leaves an instant with a time alone, even at the upper bound', () => {
    expect(parseBound('2026-09-30T12:00:00Z', 'to')).toEqual({ kind: 'time', unix: 1_790_769_600 })
  })

  it('does not read a year as a slot number by accident', () => {
    // '2026' is all digits, so it is a slot — and that is the point of the
    // rule being about shape: a bare year has no unambiguous reading, and
    // guessing one would silently export the wrong period.
    expect(parseBound('2026', 'from')).toEqual({ kind: 'slot', slot: 2026 })
  })

  it('refuses what is neither', () => {
    expect(() => parseBound('last tuesday', 'from')).toThrow(RangeError)
  })

  it('refuses a slot too large to stay exact', () => {
    expect(() => parseBound('9'.repeat(20), 'to')).toThrow(RangeError)
  })
})

describe('resolveWindow', () => {
  const slot = (n: number): Bound => ({ kind: 'slot', slot: n })
  const time = (unix: number): Bound => ({ kind: 'time', unix })

  it('without bounds covers everything up to the horizon', () => {
    expect(
      resolveWindow({ from: undefined, to: undefined, bracket: nothing, frontier: frontier(900) }),
    ).toEqual({ fromSlot: 0, toSlot: 900 })
  })

  it('never reads past the horizon, however far the upper bound reaches', () => {
    // The slots above the horizon are not empty — they are unread. An export
    // that swallowed them would report "nothing happened" for a period nobody
    // has looked at yet.
    expect(
      resolveWindow({
        from: slot(100),
        to: slot(10_000),
        bracket: nothing,
        frontier: frontier(900),
      }),
    ).toEqual({ fromSlot: 100, toSlot: 900 })
  })

  it('turns time bounds into the slots the table bracketed them with', () => {
    expect(
      resolveWindow({
        from: time(1_788_220_800),
        to: time(1_790_769_600),
        bracket: { fromSlot: 410, toSlot: 880 },
        frontier: frontier(900),
      }),
    ).toEqual({ fromSlot: 410, toSlot: 880 })
  })

  it('mixes a date with a slot, because each edge is resolved on its own', () => {
    expect(
      resolveWindow({
        from: time(1_788_220_800),
        to: slot(700),
        bracket: { fromSlot: 410, toSlot: null },
        frontier: frontier(900),
      }),
    ).toEqual({ fromSlot: 410, toSlot: 700 })
  })

  it('is empty when no event falls at or after the lower instant', () => {
    const window = resolveWindow({
      from: time(1_999_999_999),
      to: undefined,
      bracket: nothing,
      frontier: frontier(900),
    })
    expect(isEmpty(window)).toBe(true)
    // Both edges stay slots: the manifest promises slot bounds even when the
    // period it describes holds nothing.
    expect(window).toEqual({ fromSlot: 901, toSlot: 900 })
  })

  it('is empty when no event falls at or before the upper instant', () => {
    expect(
      isEmpty(
        resolveWindow({
          from: undefined,
          to: time(1),
          bracket: { fromSlot: 0, toSlot: null },
          frontier: frontier(900),
        }),
      ),
    ).toBe(true)
  })

  it('is empty when the bounds are the wrong way round', () => {
    expect(
      isEmpty(
        resolveWindow({
          from: slot(800),
          to: slot(700),
          bracket: nothing,
          frontier: frontier(900),
        }),
      ),
    ).toBe(true)
  })

  it('survives a mirror that has read nothing at all', () => {
    const window = resolveWindow({
      from: undefined,
      to: undefined,
      bracket: nothing,
      frontier: frontier(0, 0),
    })
    expect(window).toEqual({ fromSlot: 0, toSlot: 0 })
  })
})

describe('cursors', () => {
  it('round-trips', () => {
    const cursor = { slot: 501_913_340, signature: SIGNATURE, eventIndex: 3 }
    expect(parseCursor(formatCursor(cursor))).toEqual(cursor)
  })

  it('refuses a cursor that is not three parts', () => {
    expect(() => parseCursor(`900:${SIGNATURE}`)).toThrow(RangeError)
  })

  it('refuses a non-numeric slot or index', () => {
    expect(() => parseCursor(`x:${SIGNATURE}:0`)).toThrow(RangeError)
    expect(() => parseCursor(`900:${SIGNATURE}:-1`)).toThrow(RangeError)
  })
})
