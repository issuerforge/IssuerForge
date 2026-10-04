import { describe, expect, it } from 'vitest'
import { REASON_CODES, reasonCodeEntry, reasonCodeLabel } from './reasons.ts'

describe('the reason code catalog', () => {
  it('names each code once, every one a non-zero u16', () => {
    const codes = REASON_CODES.map((entry) => entry.code)
    expect(new Set(codes).size).toBe(codes.length)
    // Zero is "not stated" in `ComplianceReason`, and the program refuses it:
    // a catalog entry for it would be a name for a refusal.
    expect(codes.every((code) => Number.isInteger(code) && code >= 1 && code <= 0xffff)).toBe(true)
  })

  it('numbers from one with no gaps, so a new code goes at the end', () => {
    expect(REASON_CODES.map((entry) => entry.code)).toEqual(
      REASON_CODES.map((_, index) => index + 1),
    )
  })

  it('keeps the numbers the devnet journal was written with', () => {
    // `tools/demo/src/journal.ts` raised its actions with these codes on
    // 2026-10-03, and those rows are on chain for good: renaming one here
    // would change what they say.
    expect(reasonCodeEntry(4)?.label).toBe('Financial intelligence request')
    expect(reasonCodeEntry(9)?.label).toBe('Order lifted')
    expect(reasonCodeEntry(12)?.label).toBe('Policy review')
  })

  it('shows the number beside the name, and the number alone outside the catalog', () => {
    expect(reasonCodeLabel(1)).toBe('Sanctions match (1)')
    expect(reasonCodeLabel(4242)).toBe('code 4242')
  })
})
