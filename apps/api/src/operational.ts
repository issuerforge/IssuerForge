// Операційний ключ платформи: єдине місце всього проєкту, де API щось підписує.
//
// **Чому виняток узагалі є.** Кожна ручка, що змінює ончейн-стан, віддає
// непідписану транзакцію (`docs/PLAN.md` → «API-контракти»). Три рутинні
// операції з `OperationalDelegation` — виняток, названий у тому ж документі:
// розморожування рахунку не є дією з коштами, а онбординг, який щоразу вимагає
// гаманця емітента, — це не онбординг (FR-035).
//
// **Чому це безпечно, і де саме проходить межа.** Повноваження ключа обмежені
// ончейн: `authority::require_routine` звіряє кожну інструкцію з
// `delegation_mask`, а в самій масці немає й не може бути повноваження, що
// рухає кошти (FR-035a). Тут стоїть **другий** бар'єр, дешевий і власний:
// підписати можна лише план, якому не бракує жодного чужого підпису. План із
// другим підписантом — це дія з кворумом, і вона не має доходити навіть до
// мережі, щоб отримати там відмову.

import type { TxPlan } from '@forge/chain'
import { compileTransaction, decodeBase58, type ProgramError, programErrorFrom } from '@forge/chain'
import { type Connection, Keypair, type PublicKey } from '@solana/web3.js'

export interface OperationalSigner {
  /** Адреса ключа. Емітент вносить саме її в `IssuerConfig.operational_key`. */
  readonly publicKey: PublicKey
  /**
   * Підписати план, відправити, дочекатися підтвердження. Повертає підпис.
   *
   * Блокхеш береться тут і на кожну транзакцію свій. Пачка розморожувань
   * виконується послідовно, і один блокхеш на всі означав би, що останні
   * рахунки пачки підписуються вікном, яке доживає останні секунди, — відмова
   * тим імовірніша, чим довша черга.
   */
  submit(plan: TxPlan): Promise<string>
}

/**
 * Невдача делегованої операції.
 *
 * `program` заповнений, коли відмовила **програма**: тоді це відповідь про стан
 * ланцюга («повноваження не делеговане», «токен ще не створений»), і людині
 * треба показати саме її. Порожній `program` означає мережу — обрив, строк,
 * зламаний RPC, — і це вже збій API, а не відповідь.
 */
export class SubmitError extends Error {
  readonly program: ProgramError | undefined

  constructor(message: string, program: ProgramError | undefined, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SubmitError'
    this.program = program
  }
}

export function createOperationalSigner(
  connection: Connection,
  secretKey: string,
): OperationalSigner {
  // Розбір не обгорнутий у try: конфіг уже перевірив довжину на старті, і друга
  // м'яка обробка тут означала б процес, який піднявся без ключа й мовчить про це.
  const keypair = Keypair.fromSecretKey(decodeBase58(secretKey))

  return {
    publicKey: keypair.publicKey,

    async submit(plan) {
      const foreign = plan.signers.filter((signer) => !signer.equals(keypair.publicKey))
      if (foreign.length > 0) {
        throw new SubmitError(
          `${plan.step} needs signatures the operational key must not give`,
          undefined,
        )
      }

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
      const transaction = compileTransaction(plan, blockhash)
      transaction.sign([keypair])

      let signature: string
      try {
        // Preflight лишається ввімкненим навмисно: саме він приносить лог із
        // номером відмови програми **до** списання комісії, і без нього
        // `PowerNotDelegated` виглядав би як «транзакція не пройшла».
        signature = await connection.sendTransaction(transaction, {
          preflightCommitment: 'confirmed',
        })
      } catch (error) {
        throw new SubmitError(`${plan.step} was refused`, programErrorFrom(error), { cause: error })
      }

      const confirmation = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed',
      )
      if (confirmation.value.err !== null) {
        throw new SubmitError(
          `${plan.step} failed on chain`,
          programErrorFrom(confirmation.value.err),
          { cause: confirmation.value.err },
        )
      }

      return signature
    },
  }
}
