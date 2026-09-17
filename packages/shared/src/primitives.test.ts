import { describe, expect, it } from 'vitest'
import {
  addressSchema,
  blockTimeSchema,
  fromU64,
  signatureSchema,
  slotSchema,
  toU64,
  U64_MAX,
  u64Schema,
  unixSecondsSchema,
} from './primitives.ts'

const ADDRESS = 'So11111111111111111111111111111111111111112'
const SIGNATURE =
  '5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia7'

describe('addressSchema', () => {
  it('accepts a base58 mint address', () => {
    expect(addressSchema.parse(ADDRESS)).toBe(ADDRESS)
  })

  it('rejects base58-illegal characters and wrong lengths', () => {
    // 0, O, I and l do not exist in base58 — a substituted string is caught on exactly those.
    expect(addressSchema.safeParse('0OIl1111111111111111111111111111111111111').success).toBe(false)
    expect(addressSchema.safeParse('abc').success).toBe(false)
  })

  it('rejects a signature: it is longer than any address', () => {
    expect(addressSchema.safeParse(SIGNATURE).success).toBe(false)
  })
})

describe('signatureSchema', () => {
  it('accepts a 64-byte base58 signature', () => {
    expect(signatureSchema.parse(SIGNATURE)).toBe(SIGNATURE)
  })

  it('rejects an address on a signature field', () => {
    expect(signatureSchema.safeParse(ADDRESS).success).toBe(false)
  })
})

describe('u64Schema', () => {
  it('accepts zero and the maximum', () => {
    expect(u64Schema.parse('0')).toBe('0')
    expect(u64Schema.parse(U64_MAX.toString(10))).toBe(U64_MAX.toString(10))
  })

  it('rejects a value one above the maximum', () => {
    expect(u64Schema.safeParse((U64_MAX + 1n).toString(10)).success).toBe(false)
  })

  it('rejects leading zeros, so one amount has one representation', () => {
    expect(u64Schema.safeParse('007').success).toBe(false)
  })

  it('rejects negatives, decimals and numbers', () => {
    expect(u64Schema.safeParse('-1').success).toBe(false)
    expect(u64Schema.safeParse('1.5').success).toBe(false)
    expect(u64Schema.safeParse(25_000_000).success).toBe(false)
  })

  it('fails a malformed value instead of throwing inside the refine', () => {
    // Zod 4 runs the refine even after a failed regex, and BigInt('1.5')
    // throws a SyntaxError — without re-checking the shape this would be a 500.
    expect(() => u64Schema.safeParse('1.5')).not.toThrow()
    expect(() => u64Schema.safeParse('nope')).not.toThrow()
  })
})

describe('toU64 / fromU64', () => {
  it('round-trips the whole range', () => {
    expect(toU64(fromU64(U64_MAX))).toBe(U64_MAX)
    expect(fromU64(toU64('25000000000'))).toBe('25000000000')
  })

  it('refuses to encode what u64 cannot hold', () => {
    expect(() => fromU64(-1n)).toThrow(RangeError)
    expect(() => fromU64(U64_MAX + 1n)).toThrow(RangeError)
  })
})

describe('slot, block time and unix seconds', () => {
  it('accepts a slot but not a fractional or negative one', () => {
    expect(slotSchema.parse(0)).toBe(0)
    expect(slotSchema.safeParse(-1).success).toBe(false)
    expect(slotSchema.safeParse(1.5).success).toBe(false)
  })

  it('allows a null block time: RPC has none for pruned blocks', () => {
    expect(blockTimeSchema.parse(null)).toBeNull()
    expect(blockTimeSchema.parse(1_772_000_000)).toBe(1_772_000_000)
  })

  it('does not allow a null timestamp where the value is on-chain', () => {
    expect(unixSecondsSchema.safeParse(null).success).toBe(false)
    expect(unixSecondsSchema.safeParse(-1).success).toBe(false)
  })
})
