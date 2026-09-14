// Онбординг холдерів: ATA, розморожування, статуси.
//
// **Підписує операційний ключ платформи, а не емітент.** Це перша делегована
// операція (FR-035b, T022): у масці делегації є `THAW_HOLDER` і
// `SET_HOLDER_STATUS`, і рівно їх ключ і використовує. Спроба вийти за маску
// перевіряється окремо, у наборі порушень.
import { buildSetHolderStatus, buildThawHolder, type HolderStatusInput } from '@forge/chain'
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token'
import type { Keypair, PublicKey } from '@solana/web3.js'
import type { DemoContext } from './context.ts'
import type { Sent } from './send.ts'
import { submit, submitPlan } from './send.ts'

export interface OnboardResult {
  readonly wallet: PublicKey
  readonly tokenAccount: PublicKey
  readonly createdAta: Sent
  readonly thawed: Sent
}

export const ataOf = (mint: PublicKey, owner: PublicKey): PublicKey =>
  getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID)

/**
 * Тільки ATA, без розморожування.
 *
 * Потрібне для виміру: рахунок, якого емітент не впускав, усе одно мусить
 * **існувати**, інакше переказ на нього не збирається на боці клієнта —
 * резолюція акаунтів хука читає дані самого рахунку (`owner`, рішення T017), і
 * без нього спроба зупиняється в браузері, а не правилом. Заморожений рахунок
 * без статусу — це і є «той, кого не впускали».
 */
export async function createAta(
  context: DemoContext,
  mint: PublicKey,
  owner: PublicKey,
): Promise<PublicKey> {
  const { connection, keys } = context
  const tokenAccount = ataOf(mint, owner)

  await submit(
    connection,
    keys.founder.publicKey,
    [
      createAssociatedTokenAccountInstruction(
        keys.founder.publicKey,
        tokenAccount,
        owner,
        mint,
        TOKEN_2022_PROGRAM_ID,
      ),
    ],
    [keys.founder],
  )

  return tokenAccount
}

/**
 * Рахунок холдера від нуля до розмороженого.
 *
 * Два кроки, і другий не є наслідком першого: свіжий ATA приходить у стан
 * `Frozen` через `DefaultAccountState` на mint (FR-008b), тож без
 * `thaw_holder` він існує й нічого не приймає. Саме це й робить розморожування
 * дією, а не формальністю.
 */
export async function onboard(
  context: DemoContext,
  mint: PublicKey,
  issuerId: PublicKey,
  holder: Keypair,
  status: HolderStatusInput,
): Promise<OnboardResult> {
  const { connection, program, keys } = context
  const tokenAccount = ataOf(mint, holder.publicKey)

  // Оренду ATA платить засновник: у холдера демо SOL немає взагалі, і це той
  // самий випадок, під який у `initialize_issuer` розділені `payer` і `founder`.
  const createdAta = await submit(
    connection,
    keys.founder.publicKey,
    [
      createAssociatedTokenAccountInstruction(
        keys.founder.publicKey,
        tokenAccount,
        holder.publicKey,
        mint,
        TOKEN_2022_PROGRAM_ID,
      ),
    ],
    [keys.founder],
  )

  const plan = await buildThawHolder(program, {
    issuerId,
    mint,
    wallet: holder.publicKey,
    // Платить засновник, санкціонує операційний ключ: у делегованій операції
    // це дві різні адреси, і програма перевіряє тільки другу.
    payer: keys.founder.publicKey,
    authority: keys.operational.publicKey,
    status,
  })

  const thawed = await submitPlan(connection, plan, [keys.founder, keys.operational])

  return { wallet: holder.publicKey, tokenAccount, createdAta, thawed }
}

/** Зміна статусу у власному реєстрі — друга делегована операція. */
export async function setStatus(
  context: DemoContext,
  mint: PublicKey,
  issuerId: PublicKey,
  wallet: PublicKey,
  status: HolderStatusInput,
): Promise<Sent> {
  const { connection, program, keys } = context

  const plan = await buildSetHolderStatus(program, {
    issuerId,
    mint,
    wallet,
    authority: keys.operational.publicKey,
    status,
  })

  return await submitPlan(connection, plan, [keys.operational])
}
