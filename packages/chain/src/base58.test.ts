import { Keypair, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { base58ByteLength, decodeBase58, encodeBase58 } from './base58.ts'

const KEYPAIR = Keypair.fromSeed(new Uint8Array(32).fill(3))

describe('base58', () => {
  it('round-trips without loss', () => {
    const encoded = encodeBase58(KEYPAIR.secretKey)

    expect(decodeBase58(encoded)).toEqual(KEYPAIR.secretKey)
    expect(Keypair.fromSecretKey(decodeBase58(encoded)).publicKey).toEqual(KEYPAIR.publicKey)
  })

  // The same alphabet as the rest of Solana: an address we encode must be
  // readable by `PublicKey`, otherwise the codec in the repository would be a
  // second one.
  it('matches the encoding of addresses', () => {
    expect(encodeBase58(KEYPAIR.publicKey.toBytes())).toBe(KEYPAIR.publicKey.toBase58())
    expect(new PublicKey(decodeBase58(KEYPAIR.publicKey.toBase58())).toBase58()).toBe(
      KEYPAIR.publicKey.toBase58(),
    )
  })

  // The difference the length is measured for at all: 32 bytes is an address,
  // 64 is a secret key, and the config must tell them apart at process start.
  it('tells an address from a secret key by length', () => {
    expect(base58ByteLength(KEYPAIR.publicKey.toBase58())).toBe(32)
    expect(base58ByteLength(encodeBase58(KEYPAIR.secretKey))).toBe(64)
  })

  it.each(['0OIl', 'not base58', ''])('non-base58 has no length: %s', (value) => {
    expect(base58ByteLength(value)).not.toBe(64)
  })
})
