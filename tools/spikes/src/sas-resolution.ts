// Спайк T057: чи виражається адреса акаунта SAS-атестації в seeds ExtraAccountMetaList,
// тобто чи може хук читати статус адреси напряму з атестації провайдера — без дзеркала
// у власний реєстр (FR-008a, docs/PLAN.md → «Ризики», рядок 3).
//
// Розкладка seeds повторює spl-tlv-account-resolution 0.10 — ту саму гілку, що тягне
// spl-token-2022 8.x. Розбирає їх клієнт (`@solana/spl-token`) і програма; обидва
// читають один і той самий 32-байтовий `address_config`, і саме його розмір є
// вузьким місцем усієї конструкції.
import type { ExtraAccountMeta } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'

export const SAS_PROGRAM_ID = new PublicKey('22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG')

/** PDA атестації: ["attestation", credential, schema, nonce] — program/src/state/attestation.rs */
export const ATTESTATION_SEED = Buffer.from('attestation')

/** Скільки байтів має `ExtraAccountMeta.address_config`. Не налаштовується. */
export const ADDRESS_CONFIG_SIZE = 32

/** discriminator == 1 означає «PDA самої hook-програми». */
const HOOK_PDA_DISCRIMINATOR = 1

/** discriminator >= 128 означає «PDA чужої програми, яка лежить у списку за індексом». */
const EXTERNAL_PDA_DISCRIMINATOR_BASE = 1 << 7

const SEED_LITERAL = 1
const SEED_ACCOUNT_KEY = 3
const SEED_ACCOUNT_DATA = 4

const U8_MAX = 255

function assertByte(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > U8_MAX) {
    throw new RangeError(`${name} має бути цілим 0…${U8_MAX}, отримано ${value}`)
  }
}

export function seedLiteral(bytes: Uint8Array): Uint8Array {
  assertByte(bytes.length, 'довжина літерала')
  return Uint8Array.from([SEED_LITERAL, bytes.length, ...bytes])
}

export function seedAccountKey(accountIndex: number): Uint8Array {
  assertByte(accountIndex, 'індекс акаунта')
  return Uint8Array.from([SEED_ACCOUNT_KEY, accountIndex])
}

export function seedAccountData(
  accountIndex: number,
  dataIndex: number,
  length: number,
): Uint8Array {
  assertByte(accountIndex, 'індекс акаунта')
  // Зсув у даних — один байт, тож поле, на яке дивиться seed, мусить лежати
  // у перших 256 байтах акаунта. Це обмеження розкладки TokenConfig, не спайка.
  assertByte(dataIndex, 'зсув у даних акаунта')
  assertByte(length, 'довжина зрізу')
  return Uint8Array.from([SEED_ACCOUNT_DATA, accountIndex, dataIndex, length])
}

export function packAddressConfig(seeds: Uint8Array[]): Uint8Array {
  const total = seeds.reduce((sum, seed) => sum + seed.length, 0)
  if (total > ADDRESS_CONFIG_SIZE) {
    throw new RangeError(
      `конфігурація адреси не вкладається у ${ADDRESS_CONFIG_SIZE} байти: потрібно ${total}`,
    )
  }
  // Нулі в хвості — не padding, а термінатор: розбір seeds спиняється на discriminator 0.
  const config = new Uint8Array(ADDRESS_CONFIG_SIZE)
  let offset = 0
  for (const seed of seeds) {
    config.set(seed, offset)
    offset += seed.length
  }
  return config
}

export interface AttestationMetaConfig {
  /** Індекс акаунта самої програми SAS у списку. */
  sasProgramIndex: number
  /** Індекс акаунта TokenConfig, з якого беруться credential і schema. */
  tokenConfigIndex: number
  credentialOffset: number
  schemaOffset: number
  /** Індекс токен-акаунта отримувача — з нього беремо гаманець. */
  destinationIndex: number
  ownerOffset: number
}

/**
 * Ключовий трюк: credential і schema беруться не літералами, а зрізами даних
 * TokenConfig. Два 32-байтові літерали самі по собі дають 68 байтів і в
 * `address_config` не вміщаються ніколи — див. `naiveAttestationAddressConfig`.
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

/** Шлях, який здається очевидним і не працює. Лишається в коді як доказ, а не як опція. */
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
