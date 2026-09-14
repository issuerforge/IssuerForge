// Вартість переказу з правилом і без нього — вимір SC-003.
//
// **База порівняння — другий mint Token-2022 без хука.** Не класичний
// SPL-токен: різниця з ним включала б вартість самих розширень Token-2022, і
// наше правило виглядало б дорожчим, ніж воно є. Тут відрізняється рівно одна
// річ — наявність `TransferHook`, — і саме її ціна й міряється.
import {
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token'
import { Keypair, type PublicKey, SystemProgram } from '@solana/web3.js'
import type { DemoContext } from './context.ts'
import type { Sent } from './send.ts'
import { submit } from './send.ts'

export interface CostReport {
  readonly withRule: Sent
  readonly withoutRule: Sent
  /** У скільки разів дорожче в одиницях обчислення. */
  readonly computeRatio: number | undefined
  /** У скільки разів дорожче в лампортах — тобто в грошах. */
  readonly feeRatio: number | undefined
  readonly measuredAt: string
}

/**
 * Той самий токен без жодного розширення, крім потрібних для порівняння.
 *
 * Ані `TransferHook`, ані `DefaultAccountState`: рахунок відкривається вже
 * розмороженим, і переказ між двома ATA не проходить ніяких перевірок. Це і є
 * «переказ без правила» у чистому вигляді.
 */
async function plainToken(
  context: DemoContext,
  decimals: number,
  recipient: PublicKey,
): Promise<{ mint: PublicKey; transfer: Sent }> {
  const { connection, keys } = context
  const mint = Keypair.generate()
  const space = getMintLen([])
  const lamports = await connection.getMinimumBalanceForRentExemption(space)

  await submit(
    connection,
    keys.founder.publicKey,
    [
      SystemProgram.createAccount({
        fromPubkey: keys.founder.publicKey,
        newAccountPubkey: mint.publicKey,
        space,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(
        mint.publicKey,
        decimals,
        keys.founder.publicKey,
        null,
        TOKEN_2022_PROGRAM_ID,
      ),
    ],
    [keys.founder, mint],
  )

  const source = getAssociatedTokenAddressSync(
    mint.publicKey,
    keys.founder.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
  )
  const destination = getAssociatedTokenAddressSync(
    mint.publicKey,
    recipient,
    false,
    TOKEN_2022_PROGRAM_ID,
  )

  await submit(
    connection,
    keys.founder.publicKey,
    [
      createAssociatedTokenAccountInstruction(
        keys.founder.publicKey,
        source,
        keys.founder.publicKey,
        mint.publicKey,
        TOKEN_2022_PROGRAM_ID,
      ),
      createAssociatedTokenAccountInstruction(
        keys.founder.publicKey,
        destination,
        recipient,
        mint.publicKey,
        TOKEN_2022_PROGRAM_ID,
      ),
      createMintToInstruction(
        mint.publicKey,
        source,
        keys.founder.publicKey,
        1_000_000n,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    ],
    [keys.founder],
  )

  const transfer = await submit(
    connection,
    keys.founder.publicKey,
    [
      createTransferCheckedInstruction(
        source,
        mint.publicKey,
        destination,
        keys.founder.publicKey,
        10_000n,
        decimals,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    ],
    [keys.founder],
  )

  return { mint: mint.publicKey, transfer }
}

export async function measureCost(
  context: DemoContext,
  withRule: Sent,
  decimals: number,
  recipient: PublicKey,
): Promise<CostReport> {
  const plain = await plainToken(context, decimals, recipient)

  const ratio = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined || b === undefined || b === 0 ? undefined : a / b

  return {
    withRule,
    withoutRule: plain.transfer,
    computeRatio: ratio(withRule.computeUnits, plain.transfer.computeUnits),
    feeRatio: ratio(withRule.feeLamports, plain.transfer.feeLamports),
    measuredAt: new Date().toISOString(),
  }
}
