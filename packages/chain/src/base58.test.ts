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

  // Той самий алфавіт, що й у решти Solana: адреса, закодована нами, мусить
  // читатись `PublicKey`, інакше кодек у репозиторії був би другим.
  it('matches the encoding of addresses', () => {
    expect(encodeBase58(KEYPAIR.publicKey.toBytes())).toBe(KEYPAIR.publicKey.toBase58())
    expect(new PublicKey(decodeBase58(KEYPAIR.publicKey.toBase58())).toBase58()).toBe(
      KEYPAIR.publicKey.toBase58(),
    )
  })

  // Різниця, заради якої довжина взагалі міряється: 32 байти — це адреса, 64 —
  // секретний ключ, і конфіг мусить розрізняти їх на старті процесу.
  it('tells an address from a secret key by length', () => {
    expect(base58ByteLength(KEYPAIR.publicKey.toBase58())).toBe(32)
    expect(base58ByteLength(encodeBase58(KEYPAIR.secretKey))).toBe(64)
  })

  it.each(['0OIl', 'не base58', ''])('не base58 не має довжини: %s', (value) => {
    expect(base58ByteLength(value)).not.toBe(64)
  })
})
