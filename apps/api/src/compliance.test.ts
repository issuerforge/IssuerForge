import { describe, expect, it } from 'vitest'
import { readNameAndSymbol } from './compliance.ts'

/** The `TokenMetadata` extension as Token-2022 writes it: two addresses, then length-prefixed strings. */
function metadata(name: string, symbol: string, uri = 'https://example.org/t.json'): Buffer {
  const field = (value: string) => {
    const bytes = Buffer.from(value, 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32LE(bytes.length)
    return Buffer.concat([length, bytes])
  }
  return Buffer.concat([Buffer.alloc(64, 7), field(name), field(symbol), field(uri)])
}

describe('reading a name and symbol from the metadata extension', () => {
  it('reads both strings past the two addresses', () => {
    expect(readNameAndSymbol(metadata('Naira Demo', 'vNGN'))).toEqual({
      name: 'Naira Demo',
      symbol: 'vNGN',
    })
  })

  it('reads UTF-8 by bytes, not characters', () => {
    expect(readNameAndSymbol(metadata('Córdoba Ñ', '€'))).toEqual({
      name: 'Córdoba Ñ',
      symbol: '€',
    })
  })

  it('a missing or cut extension is "no metadata yet", not a throw', () => {
    expect(readNameAndSymbol(null)).toBeNull()
    expect(readNameAndSymbol(metadata('Naira Demo', 'vNGN').subarray(0, 70))).toBeNull()
  })
})
