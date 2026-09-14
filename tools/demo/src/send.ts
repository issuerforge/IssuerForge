// Відправка транзакцій і те, заради чого демо взагалі існує: числа.
//
// **Кожна відправка повертає вимір.** CU і лампорти — не побічний продукт, а
// предмет SC-003, і брати їх окремим проходом означало б міряти іншу
// транзакцію, ніж та, що пройшла.
import { compileTransaction, programErrorFrom, type TxPlan, toPlan } from '@forge/chain'
import type {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js'

export interface Sent {
  readonly signature: string
  /** Спожиті одиниці обчислення. `undefined` — вузол їх не повернув. */
  readonly computeUnits: number | undefined
  /** Комісія в лампортах, як її списала мережа. */
  readonly feeLamports: number | undefined
  readonly bytes: number
}

export interface Refused {
  /** Код нашої програми або вбудований код Anchor, якщо він розібрався. */
  readonly code: number | undefined
  readonly name: string | undefined
  readonly message: string
  /** Лог симуляції: у ньому видно, хто саме відмовив — токен-програма чи хук. */
  readonly logs: readonly string[]
}

export class TransactionRefused extends Error {
  readonly detail: Refused

  constructor(detail: Refused) {
    super(detail.message)
    this.name = 'TransactionRefused'
    this.detail = detail
  }
}

function refusalOf(error: unknown): Refused {
  const program = programErrorFrom(error)
  const logs =
    typeof error === 'object' && error !== null && Array.isArray((error as { logs?: unknown }).logs)
      ? ((error as { logs: unknown[] }).logs.filter((l) => typeof l === 'string') as string[])
      : []

  return {
    code: program?.code,
    name: program?.name,
    message: program?.message ?? (error instanceof Error ? error.message : String(error)),
    logs,
  }
}

export async function sign(
  connection: Connection,
  plan: TxPlan,
  signers: readonly Keypair[],
): Promise<VersionedTransaction> {
  const { blockhash } = await connection.getLatestBlockhash()
  const transaction = compileTransaction(plan, blockhash)
  transaction.sign([...signers])
  return transaction
}

/**
 * Відправляє й чекає підтвердження; повертає вимір або кидає `TransactionRefused`.
 *
 * Preflight лишається ввімкненим: саме він приносить лог із кодом відмови **до**
 * списання комісії, а вимір SC-002 читає саме код, а не факт невдачі.
 */
export async function send(
  connection: Connection,
  transaction: VersionedTransaction,
): Promise<Sent> {
  const bytes = transaction.serialize().length

  let signature: string
  try {
    signature = await connection.sendTransaction(transaction, { preflightCommitment: 'confirmed' })
  } catch (error) {
    throw new TransactionRefused(refusalOf(error))
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
  const confirmation = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed',
  )
  if (confirmation.value.err !== null) {
    throw new TransactionRefused(refusalOf(confirmation.value.err))
  }

  // `maxSupportedTransactionVersion` обов'язковий: транзакції тут версійні (v0),
  // і без нього вузол відповідає `null` на кожну з них.
  const detail = await connection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  })

  return {
    signature,
    computeUnits: detail?.meta?.computeUnitsConsumed ?? undefined,
    feeLamports: detail?.meta?.fee ?? undefined,
    bytes,
  }
}

/** Підписати й відправити готовий план (те, що зібрали білдери T020). */
export async function submitPlan(
  connection: Connection,
  plan: TxPlan,
  signers: readonly Keypair[],
): Promise<Sent> {
  return await send(connection, await sign(connection, plan, signers))
}

/**
 * Те саме для інструкцій, яких у білдерах немає.
 *
 * Демо ходить не лише продуктовими шляхами: створення емітента, переказ повз
 * наші білдери, виклик чужої програми. Мітка кроку в `TxPlan` описує **продукт**
 * (T020), і додавати до неї назви, яких у продукті не існує, означало б
 * розширювати його словник заради інструменту виміру.
 */
export async function submit(
  connection: Connection,
  feePayer: PublicKey,
  instructions: readonly TransactionInstruction[],
  signers: readonly Keypair[],
): Promise<Sent> {
  return await submitPlan(connection, toPlan('transfer', feePayer, instructions), signers)
}

/**
 * Очікувана відмова: успіх тут — це саме відмова.
 *
 * Повертає розібрану причину, а транзакцію, яка **пройшла**, перетворює на
 * помилку. Для SC-002 це і є вимір: сто відсотків спроб мусять сюди потрапити.
 */
export async function expectRefusal(
  connection: Connection,
  feePayer: PublicKey,
  instructions: readonly TransactionInstruction[],
  signers: readonly Keypair[],
): Promise<Refused> {
  try {
    await submit(connection, feePayer, instructions, signers)
  } catch (error) {
    if (error instanceof TransactionRefused) return error.detail
    throw error
  }
  throw new PassedThrough('the transaction went through, and it was not supposed to')
}

/**
 * Спроба, яка **пройшла**. Окремий тип, а не звичайна помилка.
 *
 * Різниця не педантична: «переказ пройшов» — це провал критерію SC-002, а
 * «спробу не вдалося навіть зібрати» — поламаний вимір. Один `catch` на обидва
 * випадки перетворив би другий на перший і показав би дірку в правилі там, де
 * її немає (саме це й сталося на першому прогоні).
 */
export class PassedThrough extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PassedThrough'
  }
}
