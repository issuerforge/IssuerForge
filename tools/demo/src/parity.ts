// Симуляція проти мережі — вимір SC-008 у рантаймі.
//
// **T019 звірив модель із моделлю; тут модель звіряється з тим, що справді
// відповідає ланцюг.** Різниця істотна: диференційні тести доводять, що дві
// реалізації однакові, а цей прохід доводить, що вони обидві відповідають
// **токен-програмі й хуку в рантаймі** — з реальними акаунтами, реальним
// `Clock` і реальним лічильником вікна.
//
// Кожен сценарій виконується двічі: `simulateTransfer` у TS і справжній переказ
// у мережі. Розбіжність — це або хибна симуляція в майстрі (людина підписала б
// не те, що бачила), або зайва відмова в мережі.
import { buildTransfer, velocityCounterPda } from '@forge/chain'
import {
  type PolicyRules,
  simulateTransfer,
  type TransferContext,
  type TransferVerdict,
} from '@forge/policy'
import { refusalCodeFromAnchorError } from '@forge/shared/refusal'
import type { Keypair, PublicKey } from '@solana/web3.js'
import { chainTime, type DemoContext } from './context.ts'
import { expectRefusal, PassedThrough, submitPlan } from './send.ts'

/** Сторона переказу так, як її бачить і симуляція, і мережа. */
export interface Party {
  readonly wallet: Keypair
  readonly tier: number
  readonly jurisdiction: string
  readonly denied: boolean
  /** Рахунок заведений, але не розморожений: статусу в реєстрі немає. */
  readonly unregistered: boolean
}

export interface Scenario {
  readonly name: string
  readonly recipient: Party
  readonly amount: bigint
}

export interface ParityRow {
  readonly name: string
  readonly simulated: TransferVerdict
  readonly onChain: TransferVerdict
  readonly agrees: boolean
  /** Номер помилки, якщо мережа відмовила не нашим кодом. */
  readonly foreignCode: number | undefined
}

export interface ParityReport {
  readonly rows: readonly ParityRow[]
  readonly total: number
  readonly agreed: number
}

/**
 * Стан однієї сторони для симуляції.
 *
 * Джерело `provider` завжди `absent`: політика демо його не приймає, і
 * підставляти туди запис означало б симулювати правило, якого немає.
 */
const partyContext = (party: Party) => ({
  provider: { kind: 'absent' as const },
  register: party.unregistered
    ? { kind: 'absent' as const }
    : {
        kind: 'record' as const,
        record: {
          denied: party.denied,
          tier: party.tier,
          jurisdiction: party.jurisdiction,
          expiresAt: null,
        },
      },
})

export interface ParityInput {
  readonly mint: PublicKey
  readonly decimals: number
  readonly policy: PolicyRules
  readonly sender: Party
  readonly scenarios: readonly Scenario[]
  readonly policyVersion: number
}

export async function checkParity(context: DemoContext, input: ParityInput): Promise<ParityReport> {
  const { connection } = context
  const rows: ParityRow[] = []

  for (const scenario of input.scenarios) {
    const now = await chainTime(connection)

    // Лічильник вікна читається **з ланцюга** перед кожним сценарієм, а не
    // ведеться поруч. Інакше звірка доводила б, що модель збігається з нашим
    // же уявленням про стан, а не з тим, що бачить хук: дозволений переказ
    // рухає лічильник, і друга спроба в тому ж вікні вже інша.
    const counter = await context.program.account.velocityCounter.fetchNullable(
      velocityCounterPda(input.mint, input.sender.wallet.publicKey),
    )

    const transferContext: TransferContext = {
      sender: partyContext(input.sender),
      recipient: partyContext(scenario.recipient),
      amount: scenario.amount.toString(),
      velocity:
        counter === null
          ? undefined
          : {
              windowStart: counter.windowStart.toNumber(),
              spentInWindow: counter.spentInWindow.toString(),
            },
      mintPolicyVersion: input.policyVersion,
      policyVersion: input.policyVersion,
      now,
    }

    // Токен не на паузі й рахунок відправника розморожений; заморожений
    // рахунок отримувача — окремий стан, і саме його несе `unregistered`.
    const simulated = simulateTransfer(input.policy, transferContext, {
      paused: false,
      senderFrozen: false,
      recipientFrozen: scenario.recipient.unregistered,
    })

    const onChain = await run(context, input, scenario)

    rows.push({
      name: scenario.name,
      simulated,
      onChain: onChain.verdict,
      // Збіг — це і той самий вердикт, і той самий **код**: «відмовлено з
      // іншої причини» — це розбіжність, а не половина успіху.
      agrees: sameVerdict(simulated, onChain.verdict),
      foreignCode: onChain.foreignCode,
    })
  }

  return { rows, total: rows.length, agreed: rows.filter((row) => row.agrees).length }
}

const sameVerdict = (left: TransferVerdict, right: TransferVerdict): boolean =>
  left.allowed === right.allowed && (left.allowed || right.allowed || left.code === right.code)

/** Той самий переказ у мережі; вердикт зводиться до тієї ж форми. */
async function run(
  context: DemoContext,
  input: ParityInput,
  scenario: Scenario,
): Promise<{ verdict: TransferVerdict; foreignCode: number | undefined }> {
  const { connection } = context

  const plan = await buildTransfer(connection, {
    mint: input.mint,
    owner: input.sender.wallet.publicKey,
    recipient: scenario.recipient.wallet.publicKey,
    amount: scenario.amount,
    decimals: input.decimals,
  })

  // Дозволений переказ треба **виконати**, а не лише спробувати: інакше
  // «дозволено» доводиться відсутністю відмови, а не результатом.
  try {
    const refusal = await expectRefusal(
      connection,
      input.sender.wallet.publicKey,
      plan.instructions,
      [input.sender.wallet],
    )
    const code = refusal.code === undefined ? null : refusalCodeFromAnchorError(refusal.code)

    return code === null
      ? // Відмова не нашим кодом: рахунок заморожений (`0x11`) — це перший гейт
        // FR-008b, і в моделі йому відповідає `ACCOUNT_FROZEN`.
        {
          verdict: { allowed: false, code: 'ACCOUNT_FROZEN' },
          foreignCode: refusal.code,
        }
      : { verdict: { allowed: false, code }, foreignCode: undefined }
  } catch (error) {
    if (error instanceof PassedThrough) {
      return { verdict: { allowed: true }, foreignCode: undefined }
    }
    throw error
  }
}

/** Переказ, який справді має пройти: виконується, а не лише перевіряється. */
export async function moveOnce(
  context: DemoContext,
  mint: PublicKey,
  decimals: number,
  sender: Keypair,
  recipient: PublicKey,
  amount: bigint,
): Promise<void> {
  const plan = await buildTransfer(context.connection, {
    mint,
    owner: sender.publicKey,
    recipient,
    amount,
    decimals,
  })
  await submitPlan(context.connection, plan, [sender])
}
