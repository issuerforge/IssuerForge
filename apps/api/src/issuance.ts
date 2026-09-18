// Reserving a token number: a `tokens` row in the `pending` state.
//
// **Why a lock at all.** `create_token` derives the mint seeds from
// `issuer_config.token_count` inside the program (T018), so the number is not
// the client's choice: two issuances assembled between reading the counter
// and confirming the first transaction get **the same** mint address. The
// chain survives that — the second sees an occupied account rather than
// creating a twin token — but the person sees `ConstraintSeeds` instead of a
// sentence. The lock makes the refusal visible where it is understandable: in
// the wizard, before signing.
//
// **The lock is the primary key `tokens.mint` itself.** There is no separate
// lease table: the `pending` state exists in the schema exactly for this
// ("the issuance transaction is assembled, no confirmation from the network
// yet"), and the mint address is derived from the number, so a key conflict
// is a number conflict.
//
// **What counts as the same issuance.** Name, symbol and decimals: a person
// recognises a token by them, and two issuances that match on all three are a
// retry of the same thing, not a second token. Then the route returns the
// same mint with a fresh blockhash (idempotency, decision T021), and the
// wizard survives a stale blockhash without losing the number. The boundary
// is stated out loud: two different issuances with the same name, assembled
// at the same time, will count as one — and on chain whoever signs first
// wins. The cost of a mistake here is "try again", because the reservation
// hands out nothing but the number.
import { type Database, tokens } from '@forge/db'
import { and, eq } from 'drizzle-orm'

/**
 * How long an unclosed reservation lives.
 *
 * Computed from what holds it: a blockhash lives ~60–90 seconds, so a wizard
 * that signed and sent fits within a minute. Anything longer is an abandoned
 * tab, and holding the number for it means the issuer cannot issue a token
 * until someone removes the row by hand.
 */
export const RESERVATION_TTL_MS = 5 * 60_000

/** What an issuance is recognised by on a retry. */
export interface IssuanceIdentity {
  readonly symbol: string
  readonly name: string
  readonly decimals: number
}

export interface ReservationRequest extends IssuanceIdentity {
  readonly issuerId: string
  readonly mint: string
  /** The request time. Comes from outside so that time is not a hidden input. */
  readonly at: Date
}

/**
 * How the attempt to take the number ended.
 *
 * `reserved` — the number is ours: taken for the first time, or the same
 * issuance retried, or an abandoned reservation went stale. `taken` — the
 * number is held by **another** issuance, and the route must show which one.
 */
export type Reservation =
  | { readonly kind: 'reserved' }
  | { readonly kind: 'taken'; readonly holder: IssuanceIdentity; readonly since: Date }

export interface IssuanceStore {
  reserve(request: ReservationRequest): Promise<Reservation>
}

/** The `tokens` row, in the part the reservation decision reads. */
export interface ReservationRow extends IssuanceIdentity {
  readonly state: 'pending' | 'live' | 'paused'
  readonly createdAt: Date
}

/**
 * What to do with an already taken number. Deliberately lifted out of the
 * database queries: it is the only place in the task with branching, and it
 * is tested without Postgres.
 *
 * `takeover` — the row is ours, but it has to be rewritten for this issuance:
 * either a retry of the same one (stale blockhash), or an abandoned
 * reservation whose time ran out.
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

  // A confirmed token never releases the reservation: if this number already
  // holds a `live` one, then either the mirror lagged behind the counter or
  // the number was computed from the wrong issuer — and both are worse than a
  // refusal.
  if (existing.state !== 'pending') return { kind: 'taken', holder, since }

  const stale = request.at.getTime() - since.getTime() > RESERVATION_TTL_MS
  if (!sameIssuance(holder, request) && !stale) return { kind: 'taken', holder, since }

  return { kind: 'takeover' }
}

/**
 * How many times to try when the row vanished between insert and read.
 *
 * Two is enough: it is a race with a deletion, not a state. A loop without a
 * ceiling would be a place where a request hangs while someone in the next
 * tab removes rows.
 */
const RESERVE_ATTEMPTS = 2

export function createIssuanceStore(db: Database): IssuanceStore {
  /** `undefined` — the row vanished between insert and read; no decision, try again. */
  async function attempt(request: ReservationRequest): Promise<Reservation | undefined> {
    // An insert with `onConflictDoNothing` is one operation instead of "read
    // then insert": two concurrent requests cannot both see empty.
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

    // Taking over a stale reservation rewrites exactly what the issuance is
    // recognised by: from here on the row describes the issuance the
    // transactions were handed out for.
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
      // The row vanished a second time: that is not "the number is taken" but
      // a state the route cannot explain, so it does not pretend it can.
      if (last === undefined)
        throw new Error(`issuance reservation kept vanishing: ${request.mint}`)
      return last
    },
  }
}
