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
    // Щільність — не естетика: Anchor нумерує помилки послідовно від 6000, тож
    // дірка в цьому переліку зсуває всі наступні коди й тихо перейменовує
    // причини відмов у вже виданому журналі.
    const indexes = hookRefusalCodes().map((code) => REFUSAL_TABLE[code].hookIndex)
    expect(indexes).toEqual(indexes.map((_, i) => i))
  })

  it('gives the token-program codes no hook number', () => {
    // Пауза й заморозка спрацьовують у Token-2022 до виклику хука — наш код їх
    // не повертає, і мати номер у Rust-переліку вони не можуть.
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
    // Відмова — це перша перевірка, що не пройшла. Переставлений порядок дає
    // іншу причину на тому самому переказі, і диференційні тести (SC-008)
    // порівнюють саме причину, а не сам факт відмови.
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
    // Воркер старший за програму — очікуваний стан, а не збій: подія має
    // записатися з нерозібраним кодом, а не загубитися.
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
