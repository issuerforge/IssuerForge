// Spike T057: can the address of a SAS attestation account be expressed in the
// ExtraAccountMetaList seeds — i.e. can the hook read an address's status
// straight from the provider's attestation, with no mirror into the issuer's
// own registry (FR-008a, docs/PLAN.md → "Risks", row 3).
//
// The seed layout follows spl-tlv-account-resolution 0.10 — the same branch
// that spl-token-2022 8.x pulls in. Both the client (`@solana/spl-token`) and
// the program parse them; both read one and the same 32-byte
// `address_config`, and its size is the bottleneck of the whole construction.
import type { ExtraAccountMeta } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'

export const SAS_PROGRAM_ID = new PublicKey('22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG')

/** The attestation PDA: ["attestation", credential, schema, nonce] — program/src/state/attestation.rs */
export const ATTESTATION_SEED = Buffer.from('attestation')

/** How many bytes `ExtraAccountMeta.address_config` has. Not configurable. */
export const ADDRESS_CONFIG_SIZE = 32

/** discriminator == 1 means "a PDA of the hook program itself". */
const HOOK_PDA_DISCRIMINATOR = 1

/** discriminator >= 128 means "a PDA of another program that sits in the list at an index". */
const EXTERNAL_PDA_DISCRIMINATOR_BASE = 1 << 7

const SEED_LITERAL = 1
const SEED_ACCOUNT_KEY = 3
const SEED_ACCOUNT_DATA = 4

const U8_MAX = 255

function assertByte(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > U8_MAX) {
    throw new RangeError(`${name} must be an integer 0…${U8_MAX}, got ${value}`)
  }
}

export function seedLiteral(bytes: Uint8Array): Uint8Array {
  assertByte(bytes.length, 'literal length')
  return Uint8Array.from([SEED_LITERAL, bytes.length, ...bytes])
}

export function seedAccountKey(accountIndex: number): Uint8Array {
  assertByte(accountIndex, 'account index')
  return Uint8Array.from([SEED_ACCOUNT_KEY, accountIndex])
}

export function seedAccountData(
  accountIndex: number,
  dataIndex: number,
  length: number,
): Uint8Array {
  assertByte(accountIndex, 'account index')
  // The data offset is one byte, so the field a seed looks at must lie within
  // the first 256 bytes of the account. That is a constraint on the
  // TokenConfig layout, not on the spike.
  assertByte(dataIndex, 'account data offset')
  assertByte(length, 'slice length')
  return Uint8Array.from([SEED_ACCOUNT_DATA, accountIndex, dataIndex, length])
}

export function packAddressConfig(seeds: Uint8Array[]): Uint8Array {
  const total = seeds.reduce((sum, seed) => sum + seed.length, 0)
  if (total > ADDRESS_CONFIG_SIZE) {
    throw new RangeError(
      `address config does not fit in ${ADDRESS_CONFIG_SIZE} bytes: ${total} needed`,
    )
  }
  // The trailing zeros are not padding but a terminator: seed parsing stops at discriminator 0.
  const config = new Uint8Array(ADDRESS_CONFIG_SIZE)
  let offset = 0
  for (const seed of seeds) {
    config.set(seed, offset)
    offset += seed.length
  }
  return config
}

export interface AttestationMetaConfig {
  /** The index of the SAS program account itself in the list. */
  sasProgramIndex: number
  /** The index of the TokenConfig account the credential and schema are taken from. */
  tokenConfigIndex: number
  credentialOffset: number
  schemaOffset: number
  /** The index of the recipient's token account — the wallet is taken from it. */
  destinationIndex: number
  ownerOffset: number
}

/**
 * The key trick: the credential and the schema are taken not as literals but
 * as slices of TokenConfig data. Two 32-byte literals alone make 68 bytes and
 * never fit in `address_config` — see `naiveAttestationAddressConfig`.
 */
export function attestationExtraAccountMeta(config: AttestationMetaConfig): ExtraAccountMeta {
  const addressConfig = packAddressConfig([
    seedLiteral(ATTESTATION_SEED),
    seedAccountData(config.tokenConfigIndex, config.credentialOffset, 32),
    seedAccountData(config.tokenConfigIndex, config.schemaOffset, 32),
    seedAccountData(config.destinationIndex, config.ownerOffset, 32),
  ])

  return {
    discriminator: EXTERNAL_PDA_DISCRIMINATOR_BASE + config.sasProgramIndex,
    addressConfig,
    isSigner: false,
    isWritable: false,
  }
}

export function tokenConfigExtraAccountMeta({
  mintIndex,
}: {
  mintIndex: number
}): ExtraAccountMeta {
  return {
    discriminator: HOOK_PDA_DISCRIMINATOR,
    addressConfig: packAddressConfig([
      seedLiteral(Buffer.from('token')),
      seedAccountKey(mintIndex),
    ]),
    isSigner: false,
    isWritable: false,
  }
}

export function deriveAttestationAddress(
  credential: PublicKey,
  schema: PublicKey,
  nonce: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [ATTESTATION_SEED, credential.toBuffer(), schema.toBuffer(), nonce.toBuffer()],
    SAS_PROGRAM_ID,
  )[0]
}

/** The path that looks obvious and does not work. Kept in the code as proof, not as an option. */
export function naiveAttestationAddressConfig(
  credential: PublicKey,
  schema: PublicKey,
): Uint8Array {
  return packAddressConfig([
    seedLiteral(ATTESTATION_SEED),
    seedLiteral(credential.toBuffer()),
    seedLiteral(schema.toBuffer()),
    seedAccountData(2, 32, 32),
  ])
}
