// Читання з мережі — рівно те, чого не можна знати без неї.
//
// Форма та сама, що в `Directory`: інтерфейс плюс фабрика від готового
// з'єднання. Сервер збирається із залежностей і сам нічого не відкриває (T009),
// тож тест піднімає ті самі маршрути без ноди, підмінюючи лише цей об'єкт.
//
// **Підпису тут немає й не буде.** `@forge/chain` не тримає ключа, а провайдер
// зроблений без гаманця навмисно (T020): усе, що змінює ончейн-стан, виходить
// із API непідписаною транзакцією.
import { createForgeProgram, type ForgeProgram, issuerConfigPda } from '@forge/chain'
import type { Connection, PublicKey } from '@solana/web3.js'

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

  return {
    program,

    async tokenCount(issuerId) {
      const config = await program.account.issuerConfig.fetchNullable(issuerConfigPda(issuerId))
      return config?.tokenCount
    },

    async latestBlockhash() {
      const { blockhash } = await connection.getLatestBlockhash()
      return blockhash
    },
  }
}
