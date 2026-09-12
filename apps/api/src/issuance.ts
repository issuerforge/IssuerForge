// Резервація номера токена: рядок `tokens` у стані `pending`.
//
// **Навіщо взагалі замок.** `create_token` виводить seeds mint із
// `issuer_config.token_count` у самій програмі (T018), тож номер не є вибором
// клієнта: два випуски, зібрані між читанням лічильника й підтвердженням першої
// транзакції, отримають **одну й ту саму** адресу mint. Ланцюг це переживе —
// другий побачить зайнятий акаунт, а не створить токен-близнюк, — але людина
// побачить `ConstraintSeeds` замість речення. Замок робить відмову видимою там,
// де вона зрозуміла: у майстрі, до підпису.
//
// **Замком є сам первинний ключ `tokens.mint`.** Окремої таблиці оренди немає:
// стан `pending` заведений у схемі рівно під це («транзакція випуску зібрана,
// підтвердження з мережі ще немає»), а адреса mint виводиться з номера, тож
// конфлікт по ключу — це і є конфлікт по номеру.
//
// **Що вважається тим самим випуском.** Назва, символ і точність: токен
// впізнається людиною за ними, і два випуски, що збіглися в усіх трьох, — це
// повторна спроба того самого, а не другий токен. Тоді маршрут віддає той самий
// mint зі свіжим blockhash (ідемпотентність, рішення T021), і майстер переживає
// протухлий blockhash без втрати номера. Межа названа вголос: два різні випуски
// з однаковою назвою, зібрані одночасно, вважатимуться одним — і на ланцюгу
// виграє той, хто підпише першим. Ціна помилки тут — «спробуйте ще раз», бо
// нічого, крім номера, резервація не роздає.
import { type Database, tokens } from '@forge/db'
import { and, eq } from 'drizzle-orm'

/**
 * Скільки живе незакрита резервація.
 *
 * Порахована з того, що її тримає: blockhash живий ~60–90 секунд, тож майстер,
 * який підписав і відправив, укладається в хвилину. Все, що довше, — це
 * покинута вкладка, і тримати за нею номер означає, що емітент не може
 * випустити токен, доки хтось не прибере рядок руками.
 */
export const RESERVATION_TTL_MS = 5 * 60_000

/** Те, чим випуск упізнається при повторі. */
export interface IssuanceIdentity {
  readonly symbol: string
  readonly name: string
  readonly decimals: number
}

export interface ReservationRequest extends IssuanceIdentity {
  readonly issuerId: string
  readonly mint: string
  /** Час запиту. Приходить ззовні, щоб час не був прихованим входом. */
  readonly at: Date
}

/**
 * Чим скінчилась спроба зайняти номер.
 *
 * `reserved` — номер наш: або взятий уперше, або той самий випуск повторили, або
 * покинута резервація протухла. `taken` — номер тримає **інший** випуск, і
 * маршрут мусить показати, який саме.
 */
export type Reservation =
  | { readonly kind: 'reserved' }
  | { readonly kind: 'taken'; readonly holder: IssuanceIdentity; readonly since: Date }

export interface IssuanceStore {
  reserve(request: ReservationRequest): Promise<Reservation>
}

/** Рядок `tokens` у тій частині, яку читає рішення про резервацію. */
export interface ReservationRow extends IssuanceIdentity {
  readonly state: 'pending' | 'live' | 'paused'
  readonly createdAt: Date
}

/**
 * Що робити з уже зайнятим номером. Винесено з запитів до бази навмисно: це
 * єдине місце задачі, де є розгалуження, і воно перевіряється без Postgres.
 *
 * `takeover` — рядок наш, але його треба переписати під цей випуск: або це
 * повтор того самого (протухлий blockhash), або покинута резервація, чий строк
 * вийшов.
 */
export type ReservationDecision =
  | { readonly kind: 'takeover' }
  | { readonly kind: 'taken'; readonly holder: IssuanceIdentity; readonly since: Date }

const sameIssuance = (a: IssuanceIdentity, b: IssuanceIdentity): boolean =>
  a.symbol === b.symbol && a.name === b.name && a.decimals === b.decimals

export function decideReservation(
  existing: ReservationRow,
  request: ReservationRequest,
): ReservationDecision {
  const holder = { symbol: existing.symbol, name: existing.name, decimals: existing.decimals }
  const since = existing.createdAt

  // Підтверджений токен резервацію не звільняє ніколи: якщо на цьому номері
  // вже стоїть `live`, то або дзеркало відстало від лічильника, або номер
  // порахований не з того емітента — і те, й те гірше за відмову.
  if (existing.state !== 'pending') return { kind: 'taken', holder, since }

  const stale = request.at.getTime() - since.getTime() > RESERVATION_TTL_MS
  if (!sameIssuance(holder, request) && !stale) return { kind: 'taken', holder, since }

  return { kind: 'takeover' }
}

/**
 * Скільки разів пробувати, коли рядок зник між вставкою й читанням.
 *
 * Двох досить: це гонка з видаленням, а не стан. Цикл без стелі був би місцем,
 * де запит висить, поки хтось у сусідній вкладці прибирає рядки.
 */
const RESERVE_ATTEMPTS = 2

export function createIssuanceStore(db: Database): IssuanceStore {
  /** `undefined` — рядок зник між вставкою й читанням; рішення немає, треба ще раз. */
  async function attempt(request: ReservationRequest): Promise<Reservation | undefined> {
    // Вставка з `onConflictDoNothing` — одна операція замість «прочитати й
    // вставити»: два одночасні запити не можуть обидва побачити порожньо.
    const inserted = await db
      .insert(tokens)
      .values({
        mint: request.mint,
        issuerId: request.issuerId,
        symbol: request.symbol,
        name: request.name,
        decimals: request.decimals,
      })
      .onConflictDoNothing({ target: tokens.mint })
      .returning({ mint: tokens.mint })
    if (inserted.length > 0) return { kind: 'reserved' }

    const [existing] = await db.select().from(tokens).where(eq(tokens.mint, request.mint))
    if (existing === undefined) return undefined

    const decision = decideReservation(existing, request)
    if (decision.kind === 'taken') return decision

    // Перехоплення протухлої резервації переписує саме те, чим випуск
    // упізнається: далі рядок описує той випуск, під який віддані транзакції.
    await db
      .update(tokens)
      .set({ symbol: request.symbol, name: request.name, decimals: request.decimals })
      .where(and(eq(tokens.mint, request.mint), eq(tokens.state, 'pending')))

    return { kind: 'reserved' }
  }

  return {
    async reserve(request) {
      for (let left = RESERVE_ATTEMPTS; left > 1; left -= 1) {
        const reservation = await attempt(request)
        if (reservation !== undefined) return reservation
      }

      const last = await attempt(request)
      // Рядок зник і вдруге: це не «номер зайнятий», а стан, якого маршрут не
      // може пояснити, тож він і не вдає, що може.
      if (last === undefined)
        throw new Error(`issuance reservation kept vanishing: ${request.mint}`)
      return last
    },
  }
}
