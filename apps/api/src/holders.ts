// The thaw queue and the issuer's own status registry (FR-008a, FR-008b2).
//
// **The queue lives off-chain, and that is decision T016, not a shortcut
// here.** The `thawed` and `source` fields were deliberately removed from
// `HolderStatus`: the freeze state is held authoritatively by the token
// account itself, and a flag next to it would become a lie the moment an
// officer freezes the account without touching the registry (T026). So "who
// is waiting to be unblocked" is a question for the database, not the chain.
//
// **Where the queue rows come from.** From an application the issuer
// accepted: the route `POST /api/tokens/:mint/holders` puts the wallet into
// the `pending` state together with the tier and jurisdiction assigned to it.
// Deriving the queue from the chain (the frozen ATAs of this mint) is not an
// option, and not only because that is the indexer's job from another
// milestone: frozen accounts have neither a tier nor a jurisdiction, so the
// officer would see a list of addresses with no basis for a decision, and a
// thaw requires exactly that.
//
// The branching is lifted out of the database into the pure functions below —
// just like `decideReservation` in `issuance.ts` (T021): the queries stay
// linear, and the decisions are tested without Postgres.
import { type Database, holders, tokens } from '@forge/db'
import { and, asc, eq } from 'drizzle-orm'

/** `holder_state` from the schema. The queue is `pending`, and only that. */
export const HOLDER_STATES = ['pending', 'thawed', 'frozen'] as const

export type HolderState = (typeof HOLDER_STATES)[number]

/**
 * The status in the shape it travels through the API in.
 *
 * `expiresAt` is unix seconds, as in the account, and `null` means "no
 * expiry". There is deliberately no zero here: zero in the program also means
 * "no expiry", but through JSON it would read as "expired in 1970", and two
 * different notions would depend on who is looking.
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
 * How the attempt to queue a wallet ended.
 *
 * `settled` — the account has already been let in: it has no business in the
 * queue, and its status must be changed through a separate handler. A silent
 * "updated" here would overwrite the tier of an admitted holder with an
 * action called "add to queue".
 */
export type Enqueued =
  | { readonly kind: 'queued'; readonly row: HolderRow }
  | { readonly kind: 'settled'; readonly row: HolderRow }

export interface HolderStore {
  /** Whether this mint belongs to this issuer. Tenant isolation, FR-036. */
  ownsToken(issuerId: string, mint: string): Promise<boolean>
  list(issuerId: string, mint: string, state?: HolderState): Promise<HolderRow[]>
  get(issuerId: string, mint: string, wallet: string): Promise<HolderRow | undefined>
  enqueue(request: QueueRequest): Promise<Enqueued>
  /**
   * A confirmed thaw: the account leaves the queue.
   *
   * `status` is absent when the transaction did not write it — i.e. on a
   * repeat thaw (T016). Mirroring here what was not changed on chain would
   * mean diverging from it for no reason.
   */
  markThawed(
    write: Omit<StatusWrite, 'status'> & { readonly status?: HolderStatusFields | undefined },
  ): Promise<void>
  saveStatus(write: StatusWrite): Promise<void>
}

// ─── Pure decisions ──────────────────────────────────────────────────────────

/**
 * What exactly the thaw transaction carries.
 *
 * Three answers, and all three come from `thaw_holder` (T016): the first
 * thaw carries the status, a repeat one carries nothing, and a mismatch
 * between the intent and the account state is rejected by the program. So
 * "was it written already or not" is asked of the **chain**, not the
 * database: the database is an index, and its lag would turn into
 * `HolderStatusRequired` instead of a thaw.
 */
export type ThawIntent =
  | { readonly kind: 'first'; readonly status: HolderStatusFields }
  | { readonly kind: 'repeat' }
  | { readonly kind: 'refuse'; readonly reason: 'not-queued' | 'no-status' }

export function decideThaw(row: HolderRow | undefined, writtenOnChain: boolean): ThawIntent {
  // A repeat thaw needs neither a queue row nor its completeness: the status
  // is already on chain, and this transaction does not touch it.
  if (writtenOnChain) return { kind: 'repeat' }
  if (row === undefined) return { kind: 'refuse', reason: 'not-queued' }

  // The tier and the jurisdiction are mandatory when joining the queue, so
  // they are empty only in a row this handler did not create. Thawing it
  // blindly would mean assigning the holder a tier nobody gave them.
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

/** `null` → "no expiry", i.e. zero in the account (T016, `HolderStatus.expires_at`). */
export function toExpiryDate(seconds: number | null | undefined): Date | null {
  return seconds === null || seconds === undefined || seconds === 0
    ? null
    : new Date(seconds * 1000)
}

// ─── Store ───────────────────────────────────────────────────────────────────

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
      // The question cannot be asked of `holders` here: a token with no holders
      // at all has no rows, and "no holders" would read as "someone else's
      // mint".
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
        // The queue order is the order of joining: the officer reviews
        // applications from the top, and any other order would make "the top"
        // random.
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

      // `setWhere` is the rule "do not touch the admitted": a row in the
      // `thawed` or `frozen` state is not updated at all, and `returning`
      // comes back empty exactly when the account is already beyond the queue.
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
        // The row existed and vanished between two queries — that is not a
        // state, it is a race with a token deletion. A second attempt will
        // answer correctly.
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
      // The state is not touched: a status change freezes nothing and admits
      // nothing — the account stays where it was, and a transfer from it stops
      // passing that very moment (FR-008b1).
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
