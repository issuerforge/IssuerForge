// Шлях від зібраних транзакцій до підтверджених — у чистій частині.
//
// **Чому підпис узагалі в браузері.** API ключів емітента не тримає й тримати
// не буде: назовні з нього виходять непідписані транзакції (`docs/PLAN.md` →
// «API-контракти»). Виняток один — операційний ключ платформи, і він підписує
// рутину, а не випуск (T022).
//
// **Чому підписів три, а не один.** Випуск — це три транзакції (T018), і перша
// з них вимагає двох підписів: засновника-адміністратора й атестатора резерву.
// Екран, який показує «підписати» одну кнопку, бреше про те, що зараз
// станеться, — і саме це записано боргом у блоці T020.
import type { UnsignedTransactionView } from '@forge/api/contracts'

/** Адреса, чийого підпису бракує, і чи є вона серед під'єднаних гаманців. */
export interface SignerNeed {
  readonly address: string
  readonly connected: boolean
}

export interface SigningPlan {
  readonly step: UnsignedTransactionView['step']
  readonly base64: string
  readonly bytes: number
  readonly dependsOnPrevious: boolean
  /** У порядку, який назвав api: платник перший (T020). */
  readonly signers: readonly SignerNeed[]
}

/**
 * Що саме доведеться підписати й чим.
 *
 * Порядок транзакцій і порядок підписантів усередині них не переставляються:
 * перший — платник, а `dependsOnPrevious` каже, що наступну не можна навіть
 * відправити, доки попередня не підтвердилась. Консоль показує це людині тим
 * самим списком, у якому виконуватиме.
 */
export function planSignatures(
  transactions: readonly UnsignedTransactionView[],
  connected: readonly string[],
): SigningPlan[] {
  const wallets = new Set(connected)

  return transactions.map((transaction) => ({
    step: transaction.step,
    base64: transaction.base64,
    bytes: transaction.bytes,
    dependsOnPrevious: transaction.dependsOnPrevious,
    signers: transaction.signers.map((address) => ({
      address,
      connected: wallets.has(address),
    })),
  }))
}

/**
 * Адреси, яких у цій сесії немає, — по одному разу й у порядку появи.
 *
 * Найчастіший випадок не помилка, а робота: атестатор резерву стоїть у складі
 * окремим гаманцем і в консоль не входить (FR-024 не дає йому інших
 * повноважень). Тоді транзакцію треба передати йому рядком, а не вимагати від
 * засновника підпису, якого він поставити не може.
 */
export function absentSigners(plans: readonly SigningPlan[]): string[] {
  const absent: string[] = []
  for (const plan of plans) {
    for (const signer of plan.signers) {
      if (!signer.connected && !absent.includes(signer.address)) absent.push(signer.address)
    }
  }
  return absent
}

/** Скільки підписів збере ця сесія — число, яке показує кнопка. */
export function signatureCount(plans: readonly SigningPlan[]): number {
  return plans.reduce((total, plan) => total + plan.signers.length, 0)
}

// ─── Підтвердження ───────────────────────────────────────────────────────────

/** Рівно те, що потрібно від `Connection`, щоб дочекатись підтвердження. */
export interface SignatureReader {
  getSignatureStatuses(signatures: string[]): Promise<{
    value: ({ confirmationStatus?: string | null; err: unknown } | null)[]
  }>
}

export class ConfirmationError extends Error {
  constructor(
    message: string,
    readonly signature: string,
  ) {
    super(message)
    this.name = 'ConfirmationError'
  }
}

/** Скільки чекати підтвердження: 60 спроб по 500 мс — тридцять секунд. */
export const CONFIRM_ATTEMPTS = 60
export const CONFIRM_DELAY_MS = 500

/**
 * Чекає, доки транзакція стане `confirmed`.
 *
 * Опитуванням, а не `connection.confirmTransaction`: та перевантажена версія,
 * яку прийняв би наш виклик, вимагає `lastValidBlockHeight`, а api віддає лише
 * blockhash — і вигадувати висоту блоку, щоб задовольнити підпис функції,
 * означало б чекати не того, чого треба.
 *
 * Строк тут не декоративний: наступна транзакція випуску читає `TokenConfig`,
 * якого до підтвердження першої не існує, тож «не дочекались» і «можна далі» —
 * різні стани, і сплутати їх не можна.
 */
export async function waitForConfirmation(
  reader: SignatureReader,
  signature: string,
  options: {
    attempts?: number
    delayMs?: number
    sleep?: (ms: number) => Promise<void>
  } = {},
): Promise<void> {
  const attempts = options.attempts ?? CONFIRM_ATTEMPTS
  const delayMs = options.delayMs ?? CONFIRM_DELAY_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { value } = await reader.getSignatureStatuses([signature])
    const status = value[0]

    if (status != null) {
      if (status.err != null) {
        throw new ConfirmationError('the network refused this transaction', signature)
      }
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        return
      }
    }

    await sleep(delayMs)
  }

  // Не «не вдалося»: транзакція могла пройти й після строку. Різниця важлива —
  // повторна відправка тієї самої випускної транзакції отримає «акаунт уже
  // існує», і людині треба сказати саме це, а не «спробуйте ще раз».
  throw new ConfirmationError(
    'the network did not confirm this transaction in time; it may still land',
    signature,
  )
}
