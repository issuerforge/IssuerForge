import { describe, expect, it } from 'vitest'
import {
  ANCHOR_ERROR_OFFSET,
  anchorErrorFor,
  hookRefusalCodes,
  REFUSAL_CODES,
  REFUSAL_TABLE,
  refusalCodeFromAnchorError,
  refusalCodeSchema,
} from './refusal.ts'

describe('refusal table', () => {
  it('describes every code exactly once', () => {
    expect(Object.keys(REFUSAL_TABLE).sort()).toEqual([...REFUSAL_CODES].sort())
  })

  it('numbers the hook codes densely from zero', () => {
    // Density is not aesthetics: Anchor numbers errors sequentially from 6000,
    // so a gap in this list shifts every following code and silently renames
    // refusal reasons in a journal already issued.
    const indexes = hookRefusalCodes().map((code) => REFUSAL_TABLE[code].hookIndex)
    expect(indexes).toEqual(indexes.map((_, i) => i))
  })

  it('gives the token-program codes no hook number', () => {
    // Pause and freeze fire in Token-2022 before the hook is called — our code
    // does not return them, and they cannot have a number in the Rust enum.
    const tokenProgram = REFUSAL_CODES.filter(
      (code) => REFUSAL_TABLE[code].source === 'token-program',
    )
    expect(tokenProgram).toEqual(['TRANSFERS_PAUSED', 'ACCOUNT_FROZEN'])
    for (const code of tokenProgram) {
      expect(REFUSAL_TABLE[code].hookIndex).toBeNull()
      expect(anchorErrorFor(code)).toBeNull()
    }
  })

  it('keeps the checks in the order the hook runs them', () => {
    // A refusal is the first check that failed. A reordered sequence yields a
    // different reason on the same transfer, and the differential tests
    // (SC-008) compare the reason itself, not the mere fact of refusal.
    expect(hookRefusalCodes()).toEqual([
      'POLICY_VERSION_MISMATCH',
      'SENDER_STATUS_MISSING',
      'RECIPIENT_STATUS_MISSING',
      'STATUS_SOURCE_NOT_ACCEPTED',
      'STATUS_SOURCE_UNAVAILABLE',
      'SENDER_DENIED',
      'RECIPIENT_DENIED',
      'RECIPIENT_TIER_TOO_LOW',
      'RECIPIENT_JURISDICTION_NOT_ALLOWED',
      'TRANSFER_LIMIT_EXCEEDED',
      'VELOCITY_COUNTER_MISSING',
      'PERIOD_LIMIT_EXCEEDED',
      // Last on purpose: an unknown rule kind makes "yes" itself impossible,
      // so a more precise reason, if there is one, is named first.
      'UNKNOWN_RULE_KIND',
    ])
  })
})

describe('anchor error round trip', () => {
  it('maps the first hook code to the anchor offset', () => {
    expect(anchorErrorFor('POLICY_VERSION_MISMATCH')).toBe(ANCHOR_ERROR_OFFSET)
  })

  it('round-trips every hook code through its anchor number', () => {
    for (const code of hookRefusalCodes()) {
      const anchorError = anchorErrorFor(code)
      expect(anchorError).not.toBeNull()
      expect(refusalCodeFromAnchorError(anchorError as number)).toBe(code)
    }
  })

  it('returns null for a number this build does not know', () => {
    // A worker older than the program is an expected state, not a failure:
    // the event must be recorded with an unparsed code, not lost.
    expect(refusalCodeFromAnchorError(ANCHOR_ERROR_OFFSET + 999)).toBeNull()
    expect(refusalCodeFromAnchorError(0)).toBeNull()
  })
})

describe('refusalCodeSchema', () => {
  it('accepts a known code and rejects an API error code', () => {
    expect(refusalCodeSchema.parse('RECIPIENT_TIER_TOO_LOW')).toBe('RECIPIENT_TIER_TOO_LOW')
    expect(refusalCodeSchema.safeParse('INVALID_INPUT').success).toBe(false)
  })
})
