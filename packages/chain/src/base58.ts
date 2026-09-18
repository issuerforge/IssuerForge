// Base58 in the same implementation the rest of the chain code uses.
//
// The codec lives here rather than in `apps/api` for two reasons. First:
// base58 on Solana is not "some base58" but a specific alphabet, and a second
// copy of it in the repository would one day diverge from the first. Second:
// `@coral-xyz/anchor` already carries this implementation transitively, so a
// separate dependency would buy nothing but an extra line in the lockfile.
//
// **There is no key here, and none ever appears.** This is a byte codec: what
// the bytes are — a secret key, an address or a signature — this file does not
// know and must not know. `Keypair`s are built from them in
// `apps/api/src/operational.ts`, i.e. exactly the one process that is allowed
// to hold the operational key.
import { utils } from '@coral-xyz/anchor'

export function decodeBase58(value: string): Uint8Array {
  return Uint8Array.from(utils.bytes.bs58.decode(value))
}

export function encodeBase58(bytes: Uint8Array): string {
  return utils.bytes.bs58.encode(Buffer.from(bytes))
}

/**
 * How many bytes the string decodes to — or `undefined` if it is not base58.
 *
 * Exists for environment validation: the config must say "wrong key" at
 * process start, not throw from the depths of the codec on the first thaw.
 * The length itself is checked by the caller: 32 bytes is an address, 64 is
 * an ed25519 secret key, and the two must not be confused.
 */
export function base58ByteLength(value: string): number | undefined {
  try {
    return decodeBase58(value).length
  } catch {
    return undefined
  }
}
