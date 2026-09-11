// Переказ по токену з хуком (FR-002, FR-012).
//
// **Єдиний білдер, який ходить у мережу, і це не наш вибір.** Перелік акаунтів
// хука лежить ончейн, і резолвити його мусить клієнт: `ExtraAccountMetaList`
// описує адреси через seeds, серед яких є зрізи **даних інших акаунтів**
// (`TokenConfig.policy_version`, credential і schema — рішення спайка T057).
// Прочитати їх без RPC неможливо.
//
// **Складати переказ уручну — не можна, і це правило репо, а не порада.**
// Токен-програма підкладає хуку рівно ті акаунти, які виводить із переліку; на
// один невгаданий акаунт вона відхилить переказ **до** нашої перевірки, тобто
// холдер побачить помилку токен-програми замість названої причини (FR-011).
// Тому резолюцію робить `createTransferCheckedWithTransferHookInstruction`, а не
// ми.
import {
  createTransferCheckedWithTransferHookInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token'
import type { Commitment, Connection, PublicKey } from '@solana/web3.js'
import { type TxPlan, toPlan } from './plan.ts'

export type TransferArgs = {
  readonly mint: PublicKey
  readonly owner: PublicKey
  readonly recipient: PublicKey
  readonly amount: bigint
  /**
   * Точність токена. Приходить аргументом, а не читається з mint: у
   * `transferChecked` вона й існує для того, щоб клієнт **заявив**, у яких
   * одиницях сума, — і розбіжність із mint відхиляє токен-програма. Прочитати
   * її тут означало б звірити mint сам із собою.
   */
  readonly decimals: number
}

/**
 * Непідписаний переказ між асоційованими рахунками сторін.
 *
 * Обидва рахунки — ATA: інших у продукті немає, бо `thaw_holder` розморожує
 * саме їх, а статус і лічильник виводяться з власника, не з рахунку.
 */
export async function buildTransfer(
  connection: Connection,
  args: TransferArgs,
  commitment?: Commitment,
): Promise<TxPlan> {
  const source = getAssociatedTokenAddressSync(args.mint, args.owner, false, TOKEN_2022_PROGRAM_ID)
  const destination = getAssociatedTokenAddressSync(
    args.mint,
    args.recipient,
    false,
    TOKEN_2022_PROGRAM_ID,
  )

  const instruction = await createTransferCheckedWithTransferHookInstruction(
    connection,
    source,
    args.mint,
    destination,
    args.owner,
    args.amount,
    args.decimals,
    [],
    commitment,
    TOKEN_2022_PROGRAM_ID,
  )

  return toPlan('transfer', args.owner, [instruction])
}
