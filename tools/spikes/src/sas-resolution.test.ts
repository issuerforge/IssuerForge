import { resolveExtraAccountMeta } from '@solana/spl-token'
import type { AccountInfo, Connection } from '@solana/web3.js'
import { Keypair, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import {
  ADDRESS_CONFIG_SIZE,
  attestationExtraAccountMeta,
  deriveAttestationAddress,
  naiveAttestationAddressConfig,
  packAddressConfig,
  SAS_PROGRAM_ID,
  seedAccountData,
  seedLiteral,
  tokenConfigExtraAccountMeta,
} from './sas-resolution.ts'

// Розкладка акаунтів у виклику хука: 0 source, 1 mint, 2 destination, 3 owner,
// 4 extra-account-metas, далі — розвʼязані додаткові акаунти.
const SAS_PROGRAM_INDEX = 5
const TOKEN_CONFIG_INDEX = 6
const DESTINATION_INDEX = 2

// Запропонована розкладка TokenConfig: 8 discriminator + issuer + mint, далі два ключі.
const CREDENTIAL_OFFSET = 72
const SCHEMA_OFFSET = 104
// SPL-токен-акаунт: mint(32), owner(32).
const TOKEN_ACCOUNT_OWNER_OFFSET = 32

function stubConnection(accounts: Map<string, Buffer>): Connection {
  return {
    getAccountInfo: async (pubkey: PublicKey): Promise<AccountInfo<Buffer> | null> => {
      const data = accounts.get(pubkey.toBase58())
      if (data === undefined) return null
      return { data, executable: false, lamports: 1, owner: pubkey, rentEpoch: 0 }
    },
  } as unknown as Connection
}

function meta(pubkey: PublicKey) {
  return { pubkey, isSigner: false, isWritable: false }
}

describe('резолюція акаунта SAS-атестації через seeds ExtraAccountMetaList', () => {
  const mint = Keypair.generate().publicKey
  const holder = Keypair.generate().publicKey
  const credential = Keypair.generate().publicKey
  const schema = Keypair.generate().publicKey
  const hookProgramId = Keypair.generate().publicKey
  const tokenConfig = Keypair.generate().publicKey
  const destination = Keypair.generate().publicKey

  const tokenConfigData = Buffer.alloc(200)
  tokenConfigData.set(credential.toBuffer(), CREDENTIAL_OFFSET)
  tokenConfigData.set(schema.toBuffer(), SCHEMA_OFFSET)

  const destinationData = Buffer.alloc(165)
  destinationData.set(mint.toBuffer(), 0)
  destinationData.set(holder.toBuffer(), TOKEN_ACCOUNT_OWNER_OFFSET)

  const connection = stubConnection(
    new Map([
      [tokenConfig.toBase58(), tokenConfigData],
      [destination.toBase58(), destinationData],
    ]),
  )

  const previousMetas = [
    meta(Keypair.generate().publicKey), // 0 source
    meta(mint), // 1
    meta(destination), // 2
    meta(holder), // 3 owner
    meta(Keypair.generate().publicKey), // 4 extra-account-metas
    meta(SAS_PROGRAM_ID), // 5
    meta(tokenConfig), // 6
  ]

  it('віддає ту саму адресу, що й пряме виведення PDA атестації', async () => {
    const extraMeta = attestationExtraAccountMeta({
      sasProgramIndex: SAS_PROGRAM_INDEX,
      tokenConfigIndex: TOKEN_CONFIG_INDEX,
      credentialOffset: CREDENTIAL_OFFSET,
      schemaOffset: SCHEMA_OFFSET,
      destinationIndex: DESTINATION_INDEX,
      ownerOffset: TOKEN_ACCOUNT_OWNER_OFFSET,
    })

    const resolved = await resolveExtraAccountMeta(
      connection,
      extraMeta,
      previousMetas,
      Buffer.alloc(0),
      hookProgramId,
    )

    expect(resolved.pubkey.toBase58()).toBe(
      deriveAttestationAddress(credential, schema, holder).toBase58(),
    )
  })

  it('розвʼязує TokenConfig як PDA самого хука за адресою mint', async () => {
    const extraMeta = tokenConfigExtraAccountMeta({ mintIndex: 1 })

    const resolved = await resolveExtraAccountMeta(
      connection,
      extraMeta,
      previousMetas,
      Buffer.alloc(0),
      hookProgramId,
    )

    const expected = PublicKey.findProgramAddressSync(
      [Buffer.from('token'), mint.toBuffer()],
      hookProgramId,
    )[0]

    expect(resolved.pubkey.toBase58()).toBe(expected.toBase58())
  })

  it('конфігурація адреси вкладається у 32 байти з запасом', () => {
    const packed = packAddressConfig([
      seedLiteral(Buffer.from('attestation')),
      seedAccountData(TOKEN_CONFIG_INDEX, CREDENTIAL_OFFSET, 32),
      seedAccountData(TOKEN_CONFIG_INDEX, SCHEMA_OFFSET, 32),
      seedAccountData(DESTINATION_INDEX, TOKEN_ACCOUNT_OWNER_OFFSET, 32),
    ])

    expect(packed.length).toBe(ADDRESS_CONFIG_SIZE)
    // 13 (літерал) + 4 + 4 + 4; решта — нулі, які зупиняють розбір seeds
    expect(packed.subarray(25).every((byte) => byte === 0)).toBe(true)
  })

  it('наївний шлях — credential і schema літералами — у 32 байти не вкладається', () => {
    expect(() => naiveAttestationAddressConfig(credential, schema)).toThrow(
      /34 байт|не вкладається/,
    )
  })
})
