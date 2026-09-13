// Черга розморожування і власний реєстр статусів емітента (FR-008a, FR-008b2).
//
// **Черга живе офчейн, і це рішення T016, а не спрощення тут.** З
// `HolderStatus` навмисно прибрані поля `thawed` і `source`: стан заморозки
// авторитетно тримає сам токен-акаунт, і прапорець поруч став би брехнею тієї
// миті, коли офіцер заморозить рахунок, не торкнувшись реєстру (T026). Тому
// «хто чекає на розблокування» — питання до бази, а не до ланцюга.
//
// **Звідки в черзі беруться рядки.** Із заявки, яку емітент прийняв: маршрут
// `POST /api/tokens/:mint/holders` ставить гаманець у стан `pending` разом із
// рівнем і юрисдикцією, які йому присвоїли. Виводити чергу з ланцюга
// (заморожені ATA цього mint) не можна не тільки тому, що це робота
// індексатора з іншої віхи: у заморожених акаунтів немає ані рівня, ані
// юрисдикції, тобто офіцер бачив би перелік адрес без жодної підстави для
// рішення, а розморожування вимагає саме її.
//
// Розгалуження винесене з бази у чисті функції нижче — так само, як
// `decideReservation` у `issuance.ts` (T021): запити лишаються лінійними, а
// рішення перевіряються без Postgres.
import { type Database, holders, tokens } from '@forge/db'
import { and, asc, eq } from 'drizzle-orm'

/** `holder_state` зі схеми. Черга — це `pending`, і тільки він. */
export const HOLDER_STATES = ['pending', 'thawed', 'frozen'] as const

export type HolderState = (typeof HOLDER_STATES)[number]

/**
 * Статус у тій формі, у якій він їде через API.
 *
 * `expiresAt` — unix-секунди, як в акаунті, і `null` означає «без строку». Нуля
 * тут немає навмисно: нуль у програмі теж означає «без строку», але через JSON
 * він читався б як «протерміновано 1970 року», і два різні поняття залежали б
 * від того, хто дивиться.
 */
export interface HolderStatusFields {
  readonly tier: number
  readonly jurisdiction: string
  readonly denied: boolean
  readonly expiresAt: number | null
}

export interface HolderRow {
  readonly wallet: string
  readonly state: HolderState
  readonly tier: number | null
  readonly jurisdiction: string | null
  readonly denied: boolean
  readonly expiresAt: Date | null
  readonly requestedAt: Date
  readonly thawedAt: Date | null
}

export interface QueueRequest {
  readonly issuerId: string
  readonly mint: string
  readonly wallet: string
  readonly tier: number
  readonly jurisdiction: string
  readonly expiresAt: Date | null
  readonly at: Date
}

export interface StatusWrite {
  readonly issuerId: string
  readonly mint: string
  readonly wallet: string
  readonly status: HolderStatusFields
  readonly at: Date
}

/**
 * Чим скінчилась спроба поставити гаманець у чергу.
 *
 * `settled` — рахунок уже впущений: у черзі йому робити нічого, а змінювати
 * його статус треба окремою ручкою. Мовчазне «оновлено» тут переписало б рівень
 * впущеного холдера дією, яка називається «додати в чергу».
 */
export type Enqueued =
  | { readonly kind: 'queued'; readonly row: HolderRow }
  | { readonly kind: 'settled'; readonly row: HolderRow }

export interface HolderStore {
  /** Чи належить цей mint цьому емітенту. Ізоляція орендарів, FR-036. */
  ownsToken(issuerId: string, mint: string): Promise<boolean>
  list(issuerId: string, mint: string, state?: HolderState): Promise<HolderRow[]>
  get(issuerId: string, mint: string, wallet: string): Promise<HolderRow | undefined>
  enqueue(request: QueueRequest): Promise<Enqueued>
  /**
   * Підтверджене розморожування: рахунок виходить із черги.
   *
   * `status` відсутній, коли транзакція його не писала — тобто при повторному
   * розморожуванні (T016). Дзеркалити сюди те, чого в ланцюгу не змінювали,
   * означало б розійтися з ним на порожньому місці.
   */
  markThawed(
    write: Omit<StatusWrite, 'status'> & { readonly status?: HolderStatusFields | undefined },
  ): Promise<void>
  saveStatus(write: StatusWrite): Promise<void>
}

// ─── Чисті рішення ───────────────────────────────────────────────────────────

/**
 * Що саме несе транзакція розморожування.
 *
 * Три відповіді, і всі три — з `thaw_holder` (T016): перше розморожування несе
 * статус, повторне не несе нічого, а розбіжність між наміром і станом акаунта
 * програма відхиляє. Тому «писали вже чи ні» питається в **ланцюга**, а не в
 * бази: база — індекс, і її відставання перетворилося б на `HolderStatusRequired`
 * замість розморожування.
 */
export type ThawIntent =
  | { readonly kind: 'first'; readonly status: HolderStatusFields }
  | { readonly kind: 'repeat' }
  | { readonly kind: 'refuse'; readonly reason: 'not-queued' | 'no-status' }

export function decideThaw(row: HolderRow | undefined, writtenOnChain: boolean): ThawIntent {
  // Повторне розморожування не потребує ані рядка черги, ані його повноти:
  // статус уже в ланцюгу, і ця транзакція його не чіпає.
  if (writtenOnChain) return { kind: 'repeat' }
  if (row === undefined) return { kind: 'refuse', reason: 'not-queued' }

  // Рівень і юрисдикція обов'язкові при зарахуванні в чергу, тож порожніми вони
  // бувають лише в рядка, який завела не ця ручка. Розморозити його наосліп
  // означало б присвоїти холдеру рівень, якого йому ніхто не давав.
  if (row.tier === null || row.jurisdiction === null) {
    return { kind: 'refuse', reason: 'no-status' }
  }

  return {
    kind: 'first',
    status: {
      tier: row.tier,
      jurisdiction: row.jurisdiction,
      denied: row.denied,
      expiresAt: row.expiresAt === null ? null : toUnixSeconds(row.expiresAt),
    },
  }
}

export function toUnixSeconds(at: Date): number {
  return Math.floor(at.getTime() / 1000)
}

/** `null` → «без строку», тобто нуль в акаунті (T016, `HolderStatus.expires_at`). */
export function toExpiryDate(seconds: number | null | undefined): Date | null {
  return seconds === null || seconds === undefined || seconds === 0
    ? null
    : new Date(seconds * 1000)
}

// ─── Сховище ─────────────────────────────────────────────────────────────────

const COLUMNS = {
  wallet: holders.wallet,
  state: holders.state,
  tier: holders.tier,
  jurisdiction: holders.jurisdiction,
  denied: holders.denied,
  expiresAt: holders.expiresAt,
  requestedAt: holders.requestedAt,
  thawedAt: holders.thawedAt,
}

export function createHolderStore(db: Database): HolderStore {
  const scope = (issuerId: string, mint: string) =>
    and(eq(holders.issuerId, issuerId), eq(holders.mint, mint))

  const one = async (
    issuerId: string,
    mint: string,
    wallet: string,
  ): Promise<HolderRow | undefined> => {
    const [row] = await db
      .select(COLUMNS)
      .from(holders)
      .where(and(scope(issuerId, mint), eq(holders.wallet, wallet)))
      .limit(1)
    return row
  }

  return {
    async ownsToken(issuerId, mint) {
      // Питання до `holders` тут поставити не можна: у токена без жодного
      // холдера рядків немає, і «немає холдерів» прочиталося б як «чужий mint».
      const [row] = await db
        .select({ mint: tokens.mint })
        .from(tokens)
        .where(and(eq(tokens.mint, mint), eq(tokens.issuerId, issuerId)))
        .limit(1)
      return row !== undefined
    },

    async list(issuerId, mint, state) {
      const where =
        state === undefined
          ? scope(issuerId, mint)
          : and(scope(issuerId, mint), eq(holders.state, state))

      return await db
        .select(COLUMNS)
        .from(holders)
        .where(where)
        // Порядок черги — той, у якому ставали: офіцер розглядає заявки згори,
        // і будь-який інший порядок зробив би «згори» випадковим.
        .orderBy(asc(holders.requestedAt), asc(holders.wallet))
    },

    async get(issuerId, mint, wallet) {
      return await one(issuerId, mint, wallet)
    },

    async enqueue(request) {
      const values = {
        mint: request.mint,
        wallet: request.wallet,
        issuerId: request.issuerId,
        state: 'pending' as const,
        tier: request.tier,
        jurisdiction: request.jurisdiction,
        expiresAt: request.expiresAt,
        requestedAt: request.at,
      }

      // `setWhere` — це і є правило «впущеного не чіпаємо»: рядок у стані
      // `thawed` чи `frozen` не оновлюється взагалі, і `returning` віддає
      // порожньо саме тоді, коли рахунок уже за межами черги.
      const [row] = await db
        .insert(holders)
        .values(values)
        .onConflictDoUpdate({
          target: [holders.mint, holders.wallet],
          set: {
            tier: values.tier,
            jurisdiction: values.jurisdiction,
            expiresAt: values.expiresAt,
          },
          setWhere: eq(holders.state, 'pending'),
        })
        .returning(COLUMNS)

      if (row !== undefined) return { kind: 'queued', row }

      const settled = await one(request.issuerId, request.mint, request.wallet)
      if (settled === undefined) {
        // Рядок був і зник між двома запитами — це не стан, це гонка з
        // видаленням токена. Друга спроба відповість правильно.
        throw new Error(`holder ${request.wallet} vanished while being queued`)
      }
      return { kind: 'settled', row: settled }
    },

    async markThawed(write) {
      const status =
        write.status === undefined
          ? {}
          : {
              tier: write.status.tier,
              jurisdiction: write.status.jurisdiction,
              denied: write.status.denied,
              expiresAt: toExpiryDate(write.status.expiresAt),
              statusSource: 'issuer' as const,
            }

      await db
        .update(holders)
        .set({ ...status, state: 'thawed', thawedAt: write.at, syncedAt: write.at })
        .where(and(scope(write.issuerId, write.mint), eq(holders.wallet, write.wallet)))
    },

    async saveStatus(write) {
      // Стану не торкаємось: зміна статусу нічого не морозить і нічого не
      // впускає — рахунок лишається там, де був, а переказ із нього перестає
      // проходити тієї ж миті (FR-008b1).
      await db
        .update(holders)
        .set({
          tier: write.status.tier,
          jurisdiction: write.status.jurisdiction,
          denied: write.status.denied,
          expiresAt: toExpiryDate(write.status.expiresAt),
          statusSource: 'issuer',
          syncedAt: write.at,
        })
        .where(and(scope(write.issuerId, write.mint), eq(holders.wallet, write.wallet)))
    },
  }
}
