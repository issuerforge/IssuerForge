// The journal and the feed read the same table the indexer writes (T031):
// `events`, one row per indexed event, the whole event in `payload`.
//
// **Both endpoints are one query shape.** The export walks a slot window to
// its end, the feed walks the same window and waits for it to grow — so the
// paging, the ordering and the validation live here once, and the routes
// differ only in where they stop. A feed with its own query would be a second
// place where "what the issuer sees" is defined, and the console and the
// journal would drift without anything catching it.
//
// Three things are decided here rather than in the route, because all three
// are pure and none of them needs Postgres to be tested (the same split as
// `decideThaw` in `holders.ts`): how a bound is read, how bounds become a slot
// window, and what a page's last row means as a cursor.
import { PROGRAM_ID } from '@forge/chain'
import { type Database, events, indexerState } from '@forge/db'
import { type IndexedEvent, indexedEventSchema } from '@forge/shared/events'
import { and, asc, count, desc, eq, gte, lte, sql } from 'drizzle-orm'

/**
 * Rows per page.
 *
 * The export is streamed page by page rather than read whole: a year of a
 * live token is hundreds of thousands of rows, and holding them in memory to
 * then write them out is the one way this endpoint can take the process down.
 */
export const JOURNAL_PAGE = 500

// ─── Bounds ──────────────────────────────────────────────────────────────────

/**
 * A bound of the requested period, as the client wrote it.
 *
 * Two forms, and both are needed by different readers: an officer asks for
 * "September", the verifier (T033) asks for exactly the slot window it is
 * about to scan. A single form would make one of the two translate by hand —
 * and a compliance officer converting dates into slots is a mistake waiting
 * to be made.
 */
export type Bound =
  | { readonly kind: 'slot'; readonly slot: number }
  | { readonly kind: 'time'; readonly unix: number }

const DIGITS = /^\d+$/
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

const SECONDS_IN_DAY = 86_400

/**
 * Reads one bound. All digits — a slot; anything else — an instant.
 *
 * The shape decides, not a coercion attempt: `Number('2026')` is a perfectly
 * good number, and a person who wrote a year would silently get slot 2026.
 *
 * **A date without a time closes at the end of its day when it is the upper
 * bound.** "to=2026-09-30" means the thirtieth of September inclusive to
 * everyone who types it; taken literally it means midnight, and the export
 * would lose the whole last day of the period without saying so.
 */
export function parseBound(value: string, edge: 'from' | 'to'): Bound {
  if (DIGITS.test(value)) {
    const slot = Number(value)
    if (!Number.isSafeInteger(slot)) throw new RangeError(`${edge} is not a usable slot number`)
    return { kind: 'slot', slot }
  }

  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
    throw new RangeError(`${edge} must be a slot number or an ISO 8601 instant`)
  }

  const unix = Math.floor(parsed / 1000)
  const inclusive = edge === 'to' && DATE_ONLY.test(value)
  return { kind: 'time', unix: inclusive ? unix + SECONDS_IN_DAY - 1 : unix }
}

/**
 * The slots the time bounds landed on, as the table itself answers it.
 *
 * Time is translated into slots **before** the export runs, and the export
 * then filters by slot alone. The reason is `block_time`: the RPC has none
 * for a block pruned from the ledger, and a journal filtered by time would
 * drop such an event silently — a hole in exactly the file whose promise is
 * that there are none (SC-006). Filtered by slot, the event sits inside the
 * window its neighbours defined and goes into the export like the rest.
 */
export interface TimeBracket {
  /** Lowest slot of an event at or after the lower bound; `null` — there is none. */
  readonly fromSlot: number | null
  /** Highest slot of an event at or before the upper bound; `null` — there is none. */
  readonly toSlot: number | null
}

/**
 * How far the mirror has been read.
 *
 * Two numbers, and the difference between them is the point. `indexedThrough`
 * is the last slot the indexer touched; `horizon` is the last one it is
 * **finished** with. The indexer applies transactions in order and one at a
 * time (T031), so everything below its cursor is complete — but the cursor's
 * own slot may hold a second transaction still in the queue.
 *
 * The journal never reads past the horizon. That costs one slot of freshness
 * (~0.4 s) and buys the export a count that cannot change under it, and the
 * feed a cursor nothing can be inserted behind.
 */
export interface Frontier {
  readonly indexedThroughSlot: number
  readonly horizonSlot: number
}

/** An inclusive slot window. `fromSlot > toSlot` is a legitimately empty period. */
export interface SlotWindow {
  readonly fromSlot: number
  readonly toSlot: number
}

/** The position of an event in the total order `(slot, signature, eventIndex)`. */
export interface EventCursor {
  readonly slot: number
  readonly signature: string
  readonly eventIndex: number
}

export function cursorOf(event: IndexedEvent): EventCursor {
  return { slot: event.slot, signature: event.signature, eventIndex: event.eventIndex }
}

/** The cursor as it travels in an SSE `id:` and comes back as `?after=`. */
export function formatCursor(cursor: EventCursor): string {
  return `${cursor.slot}:${cursor.signature}:${cursor.eventIndex}`
}

export function parseCursor(value: string): EventCursor {
  const parts = value.split(':')
  const [slot, signature, eventIndex] = parts
  if (
    parts.length !== 3 ||
    slot === undefined ||
    signature === undefined ||
    eventIndex === undefined
  ) {
    throw new RangeError('expected a cursor of the form <slot>:<signature>:<eventIndex>')
  }
  if (!DIGITS.test(slot) || !DIGITS.test(eventIndex)) {
    throw new RangeError('cursor slot and event index must be non-negative integers')
  }
  return { slot: Number(slot), signature, eventIndex: Number(eventIndex) }
}

/**
 * Bounds + what the table knows → the window the export actually covers.
 *
 * An absent bound is not "no limit": the upper edge is always the horizon,
 * because beyond it the answer is "we have not read that far", not "nothing
 * happened". The manifest carries both numbers so the reader can tell those
 * two apart (`docs/SPEC.md` → FR-018).
 */
export function resolveWindow(args: {
  readonly from: Bound | undefined
  readonly to: Bound | undefined
  readonly bracket: TimeBracket
  readonly frontier: Frontier
}): SlotWindow {
  const horizon = args.frontier.horizonSlot
  // An empty window is written as the pair just past the horizon rather than
  // as negative numbers: `fromSlot > toSlot` already says "nothing", and both
  // fields stay slots, which is what the manifest promises.
  const empty: SlotWindow = { fromSlot: horizon + 1, toSlot: horizon }

  const lower = edgeSlot(args.from, args.bracket.fromSlot, 0)
  if (lower === null) return empty

  const upper = edgeSlot(args.to, args.bracket.toSlot, horizon)
  if (upper === null) return empty

  return { fromSlot: lower, toSlot: Math.min(upper, horizon) }
}

/** A bound's slot: given directly, looked up for an instant, or the default. */
function edgeSlot(bound: Bound | undefined, bracketed: number | null, fallback: number) {
  if (bound === undefined) return fallback
  return bound.kind === 'slot' ? bound.slot : bracketed
}

export function isEmpty(window: SlotWindow): boolean {
  return window.fromSlot > window.toSlot
}

// ─── The store ───────────────────────────────────────────────────────────────

export interface PageRequest {
  /** Exclusive lower bound in the total order; absent — from the window's start. */
  readonly after: EventCursor | undefined
  readonly window: SlotWindow
  readonly limit: number
}

export interface JournalStore {
  frontier(mint: string): Promise<Frontier>
  /** Both edges in one round trip; a bound that is not an instant is ignored. */
  bracket(mint: string, from: number | undefined, to: number | undefined): Promise<TimeBracket>
  count(mint: string, window: SlotWindow): Promise<number>
  /** A page in ascending order. Fewer rows than `limit` means the end — for now. */
  page(mint: string, request: PageRequest): Promise<IndexedEvent[]>
  /** The newest `limit` events of the window, still in ascending order. */
  tail(mint: string, window: SlotWindow, limit: number): Promise<IndexedEvent[]>
}

/**
 * `payload` is validated on the way out, not trusted.
 *
 * The column is `jsonb`, so nothing in the database enforces its shape, and a
 * worker one deploy older than the schema writes a row no reader here can
 * make sense of. A bad row **throws**: dropping it would take a record out of
 * a compliance journal quietly, which is the one failure this file exists to
 * prevent. The export dies mid-file instead, and the manifest's `count` makes
 * the truncation visible (`@forge/shared/journal`).
 */
function toEvent(payload: unknown, at: string): IndexedEvent {
  const parsed = indexedEventSchema.safeParse(payload)
  if (!parsed.success) {
    throw new Error(`indexed event ${at} does not match the current event schema`)
  }
  return parsed.data
}

/** int8 comes back from the driver as a string; `count()` is already cast to int. */
function toSlotNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const slot = Number(value)
  return Number.isFinite(slot) ? slot : null
}

/** The instant used when a bound is absent: the filter then matches every row. */
const NO_LOWER_BOUND = 0
const NO_UPPER_BOUND = Number.MAX_SAFE_INTEGER

export function createJournalStore(db: Database): JournalStore {
  const programId = PROGRAM_ID.toBase58()

  const within = (mint: string, window: SlotWindow) =>
    and(eq(events.mint, mint), gte(events.slot, window.fromSlot), lte(events.slot, window.toSlot))

  return {
    async frontier(mint) {
      const [cursor] = await db
        .select({ slot: indexerState.lastSlot })
        .from(indexerState)
        .where(eq(indexerState.programId, programId))

      if (cursor !== undefined) {
        return { indexedThroughSlot: cursor.slot, horizonSlot: Math.max(0, cursor.slot - 1) }
      }

      // No cursor means the indexer has never run against this database. Then
      // nothing is moving, and the newest row is as complete as it will get —
      // so the horizon is that row rather than "one slot short of it".
      const [top] = await db
        .select({ slot: sql<string | null>`max(${events.slot})` })
        .from(events)
        .where(eq(events.mint, mint))

      const slot = toSlotNumber(top?.slot) ?? 0
      return { indexedThroughSlot: slot, horizonSlot: slot }
    },

    async bracket(mint, from, to) {
      const [row] = await db
        .select({
          fromSlot: sql<
            string | null
          >`min(${events.slot}) filter (where ${events.blockTime} >= ${from ?? NO_LOWER_BOUND})`,
          toSlot: sql<
            string | null
          >`max(${events.slot}) filter (where ${events.blockTime} <= ${to ?? NO_UPPER_BOUND})`,
        })
        .from(events)
        .where(eq(events.mint, mint))

      return {
        fromSlot: toSlotNumber(row?.fromSlot),
        toSlot: toSlotNumber(row?.toSlot),
      }
    },

    async count(mint, window) {
      if (isEmpty(window)) return 0
      const [row] = await db.select({ total: count() }).from(events).where(within(mint, window))
      return row?.total ?? 0
    },

    async page(mint, request) {
      if (isEmpty(request.window)) return []
      const rows = await db
        .select({
          signature: events.signature,
          eventIndex: events.eventIndex,
          payload: events.payload,
        })
        .from(events)
        .where(and(within(mint, request.window), afterCursor(request.after)))
        .orderBy(asc(events.slot), asc(events.signature), asc(events.eventIndex))
        .limit(request.limit)

      return rows.map((row) => toEvent(row.payload, `${row.signature}:${row.eventIndex}`))
    },

    async tail(mint, window, limit) {
      if (isEmpty(window)) return []
      const rows = await db
        .select({
          signature: events.signature,
          eventIndex: events.eventIndex,
          payload: events.payload,
        })
        .from(events)
        .where(within(mint, window))
        .orderBy(desc(events.slot), desc(events.signature), desc(events.eventIndex))
        .limit(limit)

      // Read newest-first so the limit takes the newest, handed over
      // oldest-first so the feed reads in chain order like everything else.
      return rows.reverse().map((row) => toEvent(row.payload, `${row.signature}:${row.eventIndex}`))
    },
  }
}

/**
 * The keyset predicate — a row comparison, not three chained `or`s.
 *
 * The types are spelled out because the parameters sit inside a row
 * constructor, where Postgres has nothing else to infer them from and refuses
 * the statement rather than guessing. The column order is the one
 * `events_mint_slot_idx` is built in, so the walk stays an index scan at any
 * depth of the export.
 */
function afterCursor(cursor: EventCursor | undefined) {
  if (cursor === undefined) return undefined
  return sql`(${events.slot}, ${events.signature}, ${events.eventIndex}) > (${cursor.slot}::bigint, ${cursor.signature}::text, ${cursor.eventIndex}::smallint)`
}
