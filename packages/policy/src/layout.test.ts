import { describe, expect, it } from 'vitest'
import {
  decodeRules,
  encodeRules,
  hashEncodedRules,
  PolicyLayoutError,
  RULES_BYTES,
  rulesHash,
  toHex,
} from './layout.ts'
import {
  MAX_RULE_SLOTS,
  OPEN_POLICY,
  type PolicyRules,
  policyRulesSchema,
  RULE_KIND,
  RULE_SLOT_BYTES,
  STATUS_SOURCE,
} from './model.ts'

const status = {
  sources: ['provider', 'register'] as const,
  minTier: 2,
  maxAttestationAgeSeconds: 30 * 24 * 3600,
}

const full: PolicyRules = policyRulesSchema.parse({
  status,
  jurisdictions: ['NG', 'GH', 'KE'],
  transferLimit: '50000000',
  periodLimit: { amount: '200000000', windowSeconds: 86_400 },
})

const slotAt = (bytes: Uint8Array, index: number): Uint8Array =>
  bytes.subarray(index * RULE_SLOT_BYTES, (index + 1) * RULE_SLOT_BYTES)

/** Копія з однією зміненою позицією — щоб псувати байти, не псуючи оригінал. */
const mutate = (bytes: Uint8Array, at: number, value: number): Uint8Array => {
  const copy = Uint8Array.from(bytes)
  copy[at] = value
  return copy
}

const failure = (bytes: Uint8Array): string => {
  try {
    decodeRules(bytes)
  } catch (error) {
    if (error instanceof PolicyLayoutError) return error.message
    throw error
  }
  return ''
}

describe('encoding', () => {
  it('always fills the whole rules field', () => {
    expect(encodeRules(OPEN_POLICY)).toHaveLength(RULES_BYTES)
    expect(encodeRules(full)).toHaveLength(RULES_BYTES)
    expect(RULES_BYTES).toBe(MAX_RULE_SLOTS * RULE_SLOT_BYTES)
  })

  it('writes the status rule byte for byte', () => {
    const slot = slotAt(encodeRules(full), 0)
    expect(slot[0]).toBe(RULE_KIND.STATUS)
    expect(slot[1]).toBe(0)
    expect(slot[2]).toBe(STATUS_SOURCE.provider | STATUS_SOURCE.register)
    expect(slot[3]).toBe(2)
    // u32 little-endian, як seeds у T007: одна домовленість на весь проєкт.
    expect(new DataView(slot.buffer, slot.byteOffset).getUint32(4, true)).toBe(30 * 24 * 3600)
  })

  it('writes jurisdictions as ASCII pairs, already sorted by the model', () => {
    const slot = slotAt(encodeRules(full), 1)
    expect(slot[0]).toBe(RULE_KIND.JURISDICTIONS)
    expect(String.fromCharCode(...slot.subarray(2, 8))).toBe('GHKENG')
    expect(Array.from(slot.subarray(8))).toEqual(Array.from<number>({ length: 16 }).fill(0))
  })

  it('writes amounts as u64 little-endian', () => {
    const slot = slotAt(encodeRules(full), 2)
    expect(slot[0]).toBe(RULE_KIND.TRANSFER_LIMIT)
    expect(new DataView(slot.buffer, slot.byteOffset).getBigUint64(2, true)).toBe(50_000_000n)
  })

  it('orders slots by rule kind, and leaves the tail zeroed', () => {
    const bytes = encodeRules(full)
    expect(Array.from({ length: 4 }, (_, i) => slotAt(bytes, i)[0])).toEqual([
      RULE_KIND.STATUS,
      RULE_KIND.JURISDICTIONS,
      RULE_KIND.TRANSFER_LIMIT,
      RULE_KIND.PERIOD_LIMIT,
    ])
    expect(bytes.subarray(4 * RULE_SLOT_BYTES).every((byte) => byte === 0)).toBe(true)
  })

  it('puts an omitted rule nowhere, rather than in a zeroed slot of its own', () => {
    const bytes = encodeRules(OPEN_POLICY)
    expect(slotAt(bytes, 0)[0]).toBe(RULE_KIND.STATUS)
    expect(bytes.subarray(RULE_SLOT_BYTES).every((byte) => byte === 0)).toBe(true)
  })

  it('refuses to encode a policy the model would refuse', () => {
    expect(() => encodeRules({ status, transferLimit: '0' } as unknown as PolicyRules)).toThrow()
  })
})

describe('the round trip', () => {
  it('returns the same policy', () => {
    expect(decodeRules(encodeRules(full))).toEqual(full)
    expect(decodeRules(encodeRules(OPEN_POLICY))).toEqual(OPEN_POLICY)
  })

  it('keeps an absent expiry absent, rather than turning it into zero', () => {
    const registerOnly = policyRulesSchema.parse({
      status: { sources: ['register'], minTier: 0 },
    })
    const back = decodeRules(encodeRules(registerOnly))
    expect(back.status.maxAttestationAgeSeconds).toBeUndefined()
    expect(back).toEqual(registerOnly)
  })

  it('carries the largest u64 without losing the low bits', () => {
    const big = policyRulesSchema.parse({ status, transferLimit: '18446744073709551615' })
    expect(decodeRules(encodeRules(big)).transferLimit).toBe('18446744073709551615')
  })

  it('carries a full slot of jurisdictions', () => {
    const codes = Array.from({ length: 11 }, (_, i) => `A${String.fromCharCode(65 + i)}`)
    const wide = policyRulesSchema.parse({ status, jurisdictions: codes })
    expect(decodeRules(encodeRules(wide)).jurisdictions).toEqual(codes)
  })

  // Канонічність: у прийнятих байтів рівно одне прочитання й одне записування.
  it('re-encodes accepted bytes into exactly the same bytes', () => {
    for (const policy of [OPEN_POLICY, full]) {
      const bytes = encodeRules(policy)
      expect(encodeRules(decodeRules(bytes))).toEqual(bytes)
    }
  })
})

describe('decoding refuses what encoding could not have produced', () => {
  it('a field of the wrong size', () => {
    expect(failure(new Uint8Array(RULES_BYTES - 1))).toContain('expected 384 bytes')
    expect(failure(new Uint8Array(RULES_BYTES + 1))).toContain('expected 384 bytes')
  })

  // Байт мав би лишатись нулем; будь-що інше змінює `rules_hash`, не змінюючи
  // змісту, і саме тому воно не проходить.
  it('a non-zero reserved byte', () => {
    expect(failure(mutate(encodeRules(full), 1, 7))).toContain('reserved byte')
  })

  // Політика, яку читач не розуміє повністю, не стає слабшою мовчки.
  it('an unknown rule kind', () => {
    expect(failure(mutate(encodeRules(full), 3 * RULE_SLOT_BYTES, 99))).toContain(
      'unknown rule kind 99',
    )
  })

  it('an unknown status source bit', () => {
    expect(failure(mutate(encodeRules(full), 2, 0b1000))).toContain('no known source')
  })

  it('a status rule that names no source at all', () => {
    expect(failure(mutate(encodeRules(full), 2, 0))).toContain('no known source')
  })

  it('slots out of ascending order', () => {
    const bytes = encodeRules(full)
    const swapped = Uint8Array.from(bytes)
    swapped.set(slotAt(bytes, 1), 0)
    swapped.set(slotAt(bytes, 0), RULE_SLOT_BYTES)
    expect(failure(swapped)).toContain('ascending order')
  })

  it('the same rule kind twice', () => {
    const bytes = encodeRules(full)
    const doubled = Uint8Array.from(bytes)
    doubled.set(slotAt(bytes, 2), 3 * RULE_SLOT_BYTES)
    // Дубль називається дублем, а не порушенням порядку: причина точніша, і
    // саме вона піде в повідомлення, яке прочитає людина.
    expect(failure(doubled)).toContain('appears twice')
  })

  // Дірка дала б два кодування однієї політики, тобто два різні хеші.
  it('a rule after an empty slot', () => {
    const bytes = encodeRules(full)
    const holed = Uint8Array.from(bytes)
    holed.fill(0, RULE_SLOT_BYTES, 2 * RULE_SLOT_BYTES)
    expect(failure(holed)).toContain('follows an empty slot')
  })

  it('rubbish in the tail that no rule reads', () => {
    const bytes = encodeRules(full)
    expect(failure(mutate(bytes, RULES_BYTES - 1, 1))).toContain('empty but not zeroed')
  })

  it('a policy with no status rule', () => {
    const bytes = new Uint8Array(RULES_BYTES)
    bytes[0] = RULE_KIND.TRANSFER_LIMIT
    new DataView(bytes.buffer).setBigUint64(2, 500n, true)
    expect(failure(bytes)).toContain('status')
  })

  it('a limit of zero, which the model refuses', () => {
    const bytes = encodeRules(full)
    const zeroed = Uint8Array.from(bytes)
    zeroed.fill(0, 2 * RULE_SLOT_BYTES + 2, 2 * RULE_SLOT_BYTES + 10)
    expect(failure(zeroed)).toContain('transferLimit')
  })
})

describe('rules_hash', () => {
  it('is a 32-byte sha256 over the whole field', () => {
    const hash = rulesHash(full)
    expect(hash).toHaveLength(32)
    expect(hash).toEqual(hashEncodedRules(encodeRules(full)))
  })

  it('is stable for the same policy', () => {
    expect(toHex(rulesHash(full))).toBe(toHex(rulesHash(full)))
  })

  // Це і є розрахунок за нормалізацію множин у моделі: та сама політика,
  // набрана в іншому порядку, не має читатись як зміна політики.
  it('does not change when a set is given in another order', () => {
    const one = policyRulesSchema.parse({ status, jurisdictions: ['KE', 'NG', 'GH'] })
    const two = policyRulesSchema.parse({
      status: { ...status, sources: ['register', 'provider'] },
      jurisdictions: ['GH', 'KE', 'NG'],
    })
    expect(toHex(rulesHash(one))).toBe(toHex(rulesHash(two)))
  })

  it('changes when any parameter changes', () => {
    const stricter = policyRulesSchema.parse({ ...full, transferLimit: '49999999' })
    expect(toHex(rulesHash(stricter))).not.toBe(toHex(rulesHash(full)))
  })

  it('changes when a rule is dropped', () => {
    const { jurisdictions: _dropped, ...rest } = full
    expect(toHex(rulesHash(policyRulesSchema.parse(rest)))).not.toBe(toHex(rulesHash(full)))
  })

  // Верифікатор журналу (SC-006) бере зріз даних акаунта й хешує його, нічого
  // не знаючи про те, скільки слотів заповнено.
  it('is computable from the raw account slice alone', () => {
    const account = new Uint8Array(8 + RULES_BYTES + 32)
    account.set(encodeRules(full), 8)
    expect(toHex(hashEncodedRules(account.subarray(8, 8 + RULES_BYTES)))).toBe(
      toHex(rulesHash(full)),
    )
  })

  it('refuses to hash anything that is not the rules field', () => {
    expect(() => hashEncodedRules(new Uint8Array(32))).toThrow(PolicyLayoutError)
  })
})
