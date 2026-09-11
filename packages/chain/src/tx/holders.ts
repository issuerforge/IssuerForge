// Онбординг холдера й оновлення його статусу (FR-008b, FR-008b1).
//
// **Розморожування дозволом на переказ не є.** Воно знімає
// `DefaultAccountState = Frozen` і заводить два акаунти, без яких хук відмовляє;
// правила політики перевіряються далі на кожному переказі окремо. Тому пара
// інструкцій тут, а не одна: `set_holder_status` міняє статус, не чіпаючи
// заморозки, і саме вона робить FR-008b1 виконуваним.
import { BN } from '@coral-xyz/anchor'
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import type { PublicKey } from '@solana/web3.js'
import { holderStatusPda, issuerConfigPda, tokenConfigPda, velocityCounterPda } from '../pda.ts'
import type { ForgeProgram } from '../program.ts'
import type { HolderStatusInput } from './issue.ts'
import { type TxPlan, toPlan } from './plan.ts'

const jurisdictionBytes = (code: string): number[] => {
  const bytes = new TextEncoder().encode(code)
  if (bytes.length !== 2) throw new RangeError(`jurisdiction must be an alpha-2 code: ${code}`)
  return [...bytes]
}

const toStatusInput = (status: HolderStatusInput) => ({
  tier: status.tier,
  jurisdiction: jurisdictionBytes(status.jurisdiction),
  denied: status.denied,
  // Те саме перетворення, що в `issue.ts`: `bigint` на межі, `BN` усередині.
  expiresAt: new BN(status.expiresAt.toString()),
})

export type ThawHolderArgs = {
  readonly issuerId: PublicKey
  readonly mint: PublicKey
  /** Власник рахунку. Статус лягає за адресою, виведеною саме з нього. */
  readonly wallet: PublicKey
  readonly payer: PublicKey
  /** Операційний ключ платформи в межах делегації або уповноважений складу. */
  readonly authority: PublicKey
  /**
   * Статус — тільки для **першого** розморожування.
   *
   * `null` означає «запис уже є, я його не чіпаю»: так виглядає повторне
   * розморожування після заморозки офіцером. Розбіжність між наміром і станом
   * акаунта програма відхиляє, а не тлумачить.
   */
  readonly status: HolderStatusInput | null
}

export async function buildThawHolder(
  program: ForgeProgram,
  args: ThawHolderArgs,
): Promise<TxPlan> {
  const instruction = await program.methods
    .thawHolder({
      wallet: args.wallet,
      status: args.status === null ? null : toStatusInput(args.status),
    })
    .accountsPartial({
      issuerConfig: issuerConfigPda(args.issuerId),
      tokenConfig: tokenConfigPda(args.mint),
      mint: args.mint,
      tokenAccount: getAssociatedTokenAddressSync(
        args.mint,
        args.wallet,
        false,
        TOKEN_2022_PROGRAM_ID,
      ),
      holderStatus: holderStatusPda(args.mint, args.wallet),
      velocityCounter: velocityCounterPda(args.mint, args.wallet),
      payer: args.payer,
      authority: args.authority,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .instruction()

  return toPlan('thaw-holder', args.payer, [instruction])
}

export type SetHolderStatusArgs = {
  readonly issuerId: PublicKey
  readonly mint: PublicKey
  readonly wallet: PublicKey
  readonly authority: PublicKey
  readonly status: HolderStatusInput
}

/**
 * Оновлення статусу у власному реєстрі емітента.
 *
 * Токен-акаунта тут немає навмисно: зміна статусу нічого не морозить. Рахунок
 * лишається розмороженим, а переказ із нього перестає проходити тієї ж миті —
 * бо статус читається на кожному переказі, а не при розморожуванні.
 *
 * Платника окремо немає: акаунт уже існує, оренди ця дія не потребує, тож
 * платить той, хто санкціонує.
 */
export async function buildSetHolderStatus(
  program: ForgeProgram,
  args: SetHolderStatusArgs,
): Promise<TxPlan> {
  const instruction = await program.methods
    .setHolderStatus({ wallet: args.wallet, status: toStatusInput(args.status) })
    .accountsPartial({
      issuerConfig: issuerConfigPda(args.issuerId),
      tokenConfig: tokenConfigPda(args.mint),
      holderStatus: holderStatusPda(args.mint, args.wallet),
      authority: args.authority,
    })
    .instruction()

  return toPlan('set-holder-status', args.authority, [instruction])
}
