import { U64_MAX } from '@forge/shared/primitives'
import { getExtraAccountMetaAddress } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import { IDL } from './idl/issuer-forge.ts'

/**
 * Адреса програми. Єдине джерело — вендорований IDL: він приходить із тієї самої
 * збірки, що й `declare_id!`, тож розійтися з програмою не може. Поки це
 * заглушка `ForgePo1icy1111…`; справжня адреса з'явиться перегенерацією IDL
 * після першого деплою, а не правкою константи.
 */
export const PROGRAM_ID = new PublicKey(IDL.address)

const utf8 = new TextEncoder()

/**
 * Мітки seeds. Мусять збігатися з `programs/issuer-forge/src/constants.rs` —
 * там сьогодні є тільки `issuer` і `token`, решта приходить зі своїми
 * інструкціями (`docs/PLAN.md` → «Модель даних»).
 */
export const SEED = {
  issuer: utf8.encode('issuer'),
  token: utf8.encode('token'),
  policy: utf8.encode('policy'),
  holder: utf8.encode('holder'),
  velocity: utf8.encode('velocity'),
  proposal: utf8.encode('proposal'),
  reserve: utf8.encode('reserve'),
  redemption: utf8.encode('redemption'),
} as const

/**
 * Числовий seed — **little-endian**, шириною рівно того типу, яким поле
 * оголошене в Rust.
 *
 * Це не стиль: `to_le_bytes()` — те, що дає Anchor у `seeds = [...]`, і
 * розбіжність тут не ламає ані збірку, ані типи. Вона просто виводить іншу
 * адресу, і виявиться це відмовою `ConstraintSeeds` на девнеті. Тести
 * `pda.test.ts` пінять саме байти, а не тільки адресу.
 */
export function u32Seed(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xff_ff_ff_ff) {
    throw new RangeError(`seed does not fit in u32: ${value}`)
  }
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, true)
  return bytes
}

/** Те саме для `u64`. Лічильники й nonce не влазять у double, тож `bigint`. */
export function u64Seed(value: bigint): Uint8Array {
  if (value < 0n || value > U64_MAX) {
    throw new RangeError(`seed does not fit in u64: ${value}`)
  }
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, value, true)
  return bytes
}

function derive(seeds: Uint8Array[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0]
}

/**
 * `IssuerConfig` — `["issuer", issuer_id]`.
 *
 * `issuer_id` не є гаманцем засновника й нічого не підписує: інакше цей гаманець
 * лишався б несучою конструкцією назавжди, навіть виключений кворумом за
 * компрометацією (`constants.rs`).
 */
export function issuerConfigPda(issuerId: PublicKey, programId = PROGRAM_ID): PublicKey {
  return derive([SEED.issuer, issuerId.toBytes()], programId)
}

/** `TokenConfig` — `["token", mint]`. */
export function tokenConfigPda(mint: PublicKey, programId = PROGRAM_ID): PublicKey {
  return derive([SEED.token, mint.toBytes()], programId)
}

/**
 * `PolicyConfig` — `["policy", mint, version]`, версія `u32`.
 *
 * Версія в seeds — це і є незмінність історії (FR-010): нова політика не
 * перезаписує акаунт, вона створює наступний, а хук читає рівно ту версію, на
 * яку налаштований mint.
 */
export function policyConfigPda(
  mint: PublicKey,
  version: number,
  programId = PROGRAM_ID,
): PublicKey {
  return derive([SEED.policy, mint.toBytes(), u32Seed(version)], programId)
}

/**
 * `HolderStatus` — `["holder", mint, wallet]`.
 *
 * `wallet` — власник токен-акаунта, а не сам токен-акаунт: хук дістає його
 * зрізом даних (offset 32) і мусить прийти до тієї самої адреси, що й клієнт.
 */
export function holderStatusPda(
  mint: PublicKey,
  wallet: PublicKey,
  programId = PROGRAM_ID,
): PublicKey {
  return derive([SEED.holder, mint.toBytes(), wallet.toBytes()], programId)
}

/** `VelocityCounter` — `["velocity", mint, wallet]`. Той самий `wallet`. */
export function velocityCounterPda(
  mint: PublicKey,
  wallet: PublicKey,
  programId = PROGRAM_ID,
): PublicKey {
  return derive([SEED.velocity, mint.toBytes(), wallet.toBytes()], programId)
}

/** `ActionProposal` — `["proposal", mint, nonce]`, nonce `u64`. */
export function actionProposalPda(
  mint: PublicKey,
  nonce: bigint,
  programId = PROGRAM_ID,
): PublicKey {
  return derive([SEED.proposal, mint.toBytes(), u64Seed(nonce)], programId)
}

/**
 * `ReserveAttestation` — `["reserve", mint, index]`, індекс `u64`.
 *
 * Індекс, а не час: акаунт append-only, і саме послідовний номер робить
 * «попередню атестацію» адресованою, а не знайденою перебором.
 */
export function reserveAttestationPda(
  mint: PublicKey,
  index: bigint,
  programId = PROGRAM_ID,
): PublicKey {
  return derive([SEED.reserve, mint.toBytes(), u64Seed(index)], programId)
}

/**
 * `RedemptionEscrow` — `["redemption", mint, request_id]`.
 *
 * `request_id` — 32 байти, згенеровані клієнтом, а не лічильник: дві заявки,
 * подані одночасно, не мають конкурувати за наступний номер. Та сама причина,
 * що й у `issuer_id`.
 */
export function redemptionEscrowPda(
  mint: PublicKey,
  requestId: PublicKey,
  programId = PROGRAM_ID,
): PublicKey {
  return derive([SEED.redemption, mint.toBytes(), requestId.toBytes()], programId)
}

/**
 * `ExtraAccountMetaList` — `["extra-account-metas", mint]` під програмою хука.
 *
 * Виводимо не самі: seeds задає `spl-tlv-account-resolution`, і повторювати їх
 * тут означало б тримати копію чужої константи. Токен-програма шукає акаунт за
 * своєю формулою — розбіжність із нею робить переказ неможливим взагалі.
 */
export function extraAccountMetaListPda(mint: PublicKey, programId = PROGRAM_ID): PublicKey {
  return getExtraAccountMetaAddress(mint, programId)
}
