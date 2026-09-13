// Читання з мережі — рівно те, чого не можна знати без неї.
//
// Форма та сама, що в `Directory`: інтерфейс плюс фабрика від готового
// з'єднання. Сервер збирається із залежностей і сам нічого не відкриває (T009),
// тож тест піднімає ті самі маршрути без ноди, підмінюючи лише цей об'єкт.
//
// **Підпису тут немає й не буде.** `@forge/chain` не тримає ключа, а провайдер
// зроблений без гаманця навмисно (T020): усе, що змінює ончейн-стан, виходить
// із API непідписаною транзакцією.
import {
  createForgeProgram,
  type ForgeProgram,
  holderStatusPda,
  issuerConfigPda,
} from '@forge/chain'
import type { Connection, PublicKey } from '@solana/web3.js'

/**
 * Те, що маршрутам треба знати про емітента з самого ланцюга.
 *
 * Ролі й склад беруться з бази (дзеркало `IssuerConfig.members`), а ці три поля
 * — ні: `delegation_mask` вирішує, чи має право підписати наш ключ, і читати
 * його з дзеркала означало б дозволити операцію за станом, який емітент уже
 * відкликав (FR-035b). Відкликання діє з моменту підтвердження транзакції, а не
 * з моменту, коли про нього дізнався індексатор.
 */
export interface IssuerConfigView {
  readonly tokenCount: number
  readonly operationalKey: string
  readonly delegationMask: number
}

export interface ChainReader {
  /** Клієнт програми: з нього збираються інструкції за IDL. */
  readonly program: ForgeProgram
  /**
   * Скільки токенів емітент уже випустив, тобто номер наступного.
   *
   * `undefined` — `IssuerConfig` у мережі немає: емітент існує в базі, але його
   * транзакція створення не підтверджена. Це різні відповіді, і маршрут
   * розрізняє їх, а не показує нуль замість «емітента ще немає».
   */
  tokenCount(issuerId: PublicKey): Promise<number | undefined>
  /** Той самий акаунт цілком — для делегації (T022). `undefined` — те саме. */
  issuerConfig(issuerId: PublicKey): Promise<IssuerConfigView | undefined>
  /**
   * Чи **писали** вже ончейн-запис статусу цього холдера.
   *
   * Питання не «чи існує акаунт»: `thaw_holder` створює його разом із
   * лічильником, а вирішує, писати статус чи ні, поле `updated_at` (T016).
   * Нуль означає «запису ще не було», і саме за цією межею проходить різниця
   * між першим розморожуванням (статус приходить із ним) і повторним
   * (`status: null`, інакше — `HolderStatusAlreadySet`).
   */
  holderStatusWritten(mint: PublicKey, wallet: PublicKey): Promise<boolean>
  /** Свіжий blockhash. Один на всі три транзакції випуску (рішення T021). */
  latestBlockhash(): Promise<string>
}

/**
 * Скільки чекати на відповідь RPC.
 *
 * `Connection` строку не має взагалі: завислий вузол тримав би запит консолі
 * доти, доки не здасться браузер, а процес — доти, доки не здасться сокет.
 * П'ять секунд — це два читання поспіль у бюджеті майстра (SC-001, ≤ 5 хв) з
 * величезним запасом, і водночас межа, після якої відповідь усе одно не
 * потрібна: blockhash, старший за неї, доживає до підпису вже коротшим.
 */
export const RPC_TIMEOUT_MS = 5_000

/**
 * `fetch` зі строком. Віддається `Connection` при створенні — інакше строк
 * довелося б ставити на кожен виклик окремо, і перший забутий виклик повернув
 * би поведінку без строку.
 */
export function fetchWithTimeout(timeoutMs = RPC_TIMEOUT_MS): typeof globalThis.fetch {
  return (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) })
}

export function createChainReader(connection: Connection): ChainReader {
  const program = createForgeProgram(connection)

  const readIssuerConfig = async (issuerId: PublicKey): Promise<IssuerConfigView | undefined> => {
    const config = await program.account.issuerConfig.fetchNullable(issuerConfigPda(issuerId))
    if (config === null) return undefined

    return {
      tokenCount: config.tokenCount,
      operationalKey: config.operationalKey.toBase58(),
      delegationMask: config.delegationMask,
    }
  }

  return {
    program,

    issuerConfig: readIssuerConfig,

    // Через те саме читання, а не власним запитом: два звертання до одного
    // акаунта колись розійшлися б у тому, що вважати відсутністю емітента.
    async tokenCount(issuerId) {
      return (await readIssuerConfig(issuerId))?.tokenCount
    },

    async holderStatusWritten(mint, wallet) {
      const status = await program.account.holderStatus.fetchNullable(holderStatusPda(mint, wallet))
      // `!isZero()`, а не `!== 0`: Anchor віддає i64 як `BN`, і порівняння з
      // числом було б завжди істинним (T020, той самий капкан із іншого боку).
      return status !== null && !status.updatedAt.isZero()
    },

    async latestBlockhash() {
      const { blockhash } = await connection.getLatestBlockhash()
      return blockhash
    },
  }
}
