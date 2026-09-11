// План транзакції: інструкції плюс те, чого з інструкцій не видно (FR-001).
//
// **Два рівні, і межа між ними — мережа.** Білдери випуску, розморожування й
// статусів чисті: вони складають інструкції з відомих адрес і тестуються без
// жодного мока. Усе, що потребує RPC, живе тут (`toUnsignedTransaction`) або в
// `transfer.ts`, де читання неминуче — резолюцію додаткових акаунтів хука
// робить токен-програма за переліком з ланцюга.
//
// **Пакет не тримає ключа й не підписує.** Звідси й форма: назовні виходить
// непідписана транзакція та перелік адрес, чиїх підписів їй бракує. Підпис
// ставить гаманець у браузері або кворум емітента.
import {
  type Connection,
  type PublicKey,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'

/**
 * Крок, який виконує транзакція. Не декорація: випуск токена — це **три**
 * транзакції (T018), і консоль мусить показувати, на якій із них зупинився
 * майстер, а не «щось не вдалося».
 */
export type TxStep =
  | 'create-token'
  | 'token-metadata'
  | 'hook-accounts'
  | 'thaw-holder'
  | 'set-holder-status'
  | 'transfer'

export type TxPlan = {
  readonly step: TxStep
  readonly instructions: readonly TransactionInstruction[]
  /** Хто платить за транзакцію. Він же перший підписант. */
  readonly feePayer: PublicKey
  /**
   * Адреси, чиї підписи потрібні, — **виведені з інструкцій**, а не оголошені
   * поруч із ними.
   *
   * Другий перелік розійшовся б із першим рівно тоді, коли інструкція отримає
   * нового підписанта: список забули б оновити, консоль не попросила б підпису,
   * і транзакція впала б у мережі замість того, щоб не зібратися тут.
   */
  readonly signers: readonly PublicKey[]
  /**
   * Чи мусить попередній крок **підтвердитися** до відправки цього.
   *
   * Для випуску це так: `set_token_metadata` і
   * `initialize_extra_account_meta_list` читають `TokenConfig`, якого до
   * підтвердження `create_token` не існує. Адреси при цьому відомі наперед
   * (mint — PDA), тож зібрати всі три можна одразу; відправити — ні.
   */
  readonly dependsOnPrevious: boolean
}

/**
 * Підписанти в порядку «платник, далі решта за появою».
 *
 * Порядок значущий для людини, а не для мережі: консоль питає підписи по черзі,
 * і платник перший, бо саме він відкриває транзакцію.
 */
function requiredSigners(
  instructions: readonly TransactionInstruction[],
  feePayer: PublicKey,
): PublicKey[] {
  const seen = new Set<string>([feePayer.toBase58()])
  const signers = [feePayer]

  for (const instruction of instructions) {
    for (const key of instruction.keys) {
      if (!key.isSigner) continue
      const address = key.pubkey.toBase58()
      if (seen.has(address)) continue
      seen.add(address)
      signers.push(key.pubkey)
    }
  }

  return signers
}

export function toPlan(
  step: TxStep,
  feePayer: PublicKey,
  instructions: readonly TransactionInstruction[],
  dependsOnPrevious = false,
): TxPlan {
  return {
    step,
    instructions,
    feePayer,
    signers: requiredSigners(instructions, feePayer),
    dependsOnPrevious,
  }
}

/** Непідписана транзакція в тій формі, у якій вона їде до браузера. */
export type UnsignedTransaction = {
  readonly step: TxStep
  readonly transaction: VersionedTransaction
  /** Транспортна форма: те, що кладеться в JSON відповіді API. */
  readonly base64: string
  readonly signers: readonly PublicKey[]
  readonly dependsOnPrevious: boolean
}

/**
 * План + blockhash → непідписана транзакція.
 *
 * Чиста функція, і це не косметика: розмір транзакції видно тільки після
 * компіляції, а бюджет випуску (1232 байти) — найтісніше обмеження проєкту.
 * Мати цей крок без мережі означає мати тест на бюджет, який не залежить від
 * ноди.
 *
 * **Транзакція версійна (v0) з порожнім переліком таблиць адрес.** Два зайві
 * байти купують те, що таблицю можна додати, не змінюючи ані контракту API, ані
 * коду консолі: якщо кворум на випуску таки знадобиться (відкритий борг T018),
 * місце під нього береться саме звідти.
 */
export function compileTransaction(plan: TxPlan, blockhash: string): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: plan.feePayer,
    recentBlockhash: blockhash,
    instructions: [...plan.instructions],
  }).compileToV0Message()

  return new VersionedTransaction(message)
}

/** Найбільший розмір транзакції, який приймає мережа. */
export const MAX_TRANSACTION_BYTES = 1232

/**
 * Скільки байтів займе транзакція **з усіма підписами**.
 *
 * `serialize()` на непідписаній транзакції записує порожні (нульові) підписи
 * рівно того ж розміру, що й справжні, тож число не зміниться після підписання.
 * Саме тому бюджет можна міряти тут, а не в мережі.
 */
export function transactionBytes(transaction: VersionedTransaction): number {
  return transaction.serialize().length
}

/**
 * План → непідписана транзакція зі свіжим blockhash.
 *
 * Єдине місце шляху випуску, що ходить у мережу. Обидва підписанти
 * `create_token` підписують **одну й ту саму** серіалізовану транзакцію по
 * черзі, тож blockhash мусить бути один — брати його окремо для кожного підпису
 * означало б дві різні транзакції.
 */
export async function toUnsignedTransaction(
  connection: Connection,
  plan: TxPlan,
): Promise<UnsignedTransaction> {
  const { blockhash } = await connection.getLatestBlockhash()
  const transaction = compileTransaction(plan, blockhash)

  return {
    step: plan.step,
    transaction,
    base64: Buffer.from(transaction.serialize()).toString('base64'),
    signers: plan.signers,
    dependsOnPrevious: plan.dependsOnPrevious,
  }
}

/**
 * Розбір транспортної форми назад.
 *
 * Пара до `base64`, і потрібна вона саме через два підписи `create_token`:
 * гаманець засновника підписує, віддає рядок, гаманець атестатора розбирає його
 * й дописує свій підпис. Зібрати транзакцію вдруге тут не можна — підпис
 * стосується конкретних байтів.
 */
export function fromBase64(base64: string): VersionedTransaction {
  return VersionedTransaction.deserialize(Buffer.from(base64, 'base64'))
}
