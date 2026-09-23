// Two ways of reading the same indexed events (T031): the export the
// regulator gets (FR-018) and the feed the console watches (FR-037).
//
// **The two are deliberately one code path with two stopping rules.** The
// export walks the window to its end and closes; the feed walks it, waits and
// walks the new part. Both read `events` through `JournalStore`, both order by
// the same total order, both hand out the same `IndexedEvent` objects. What
// the officer sees live and what the auditor reads from the file are then the
// same records by construction, not by agreement — and SC-006 is a statement
// about one of them only because it is a statement about both.
//
// **Neither endpoint touches the chain.** The events are already verified
// artefacts: each one carries the signature it came from, which is what makes
// the export checkable without us (`tools/verify-journal`, T033). Re-reading
// the network here would slow the answer down and prove nothing the file does
// not already allow anyone to prove for themselves.
import { PROGRAM_ID } from '@forge/chain'
import type { IndexedEvent } from '@forge/shared/events'
import {
  JOURNAL_CONTENT_TYPE,
  JOURNAL_FORMAT_VERSION,
  type JournalManifest,
  journalLine,
} from '@forge/shared/journal'
import { addressSchema } from '@forge/shared/primitives'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { stream, streamSSE } from 'hono/streaming'
import { z } from 'zod'
import type { AppEnv } from '../env.ts'
import { invalidInput, notFound } from '../errors.ts'
import type { HolderStore } from '../holders.ts'
import {
  type Bound,
  cursorOf,
  type EventCursor,
  formatCursor,
  isEmpty,
  JOURNAL_PAGE,
  type JournalStore,
  parseBound,
  parseCursor,
  resolveWindow,
  type SlotWindow,
} from '../journal.ts'

export interface JournalRouteDeps {
  journal: JournalStore
  /** Only for `ownsToken`: tenant isolation has one implementation (FR-036). */
  holders: HolderStore
  now: () => Date
  /**
   * How long the feed waits between reads of the table.
   *
   * The feed polls rather than being pushed to, and that is a deployment
   * decision, not a shortcut: the indexer runs inside this process only when
   * `RUN_WORKER` says so (T031), and an in-memory hand-off would leave the
   * console silent in every other topology — including a second api instance,
   * where it would be silent for half the users.
   *
   * The cost is honest and bounded: one indexed read per subscriber per
   * interval, and up to an interval of lag on top of the indexer's own. The
   * clock here is the chain's anyway — an event cannot be shown before its
   * slot is final.
   */
  feedPollMs?: number
}

/** The poll interval. Below a slot time it would mostly read nothing. */
export const FEED_POLL_MS = 1500

/** Rows one poll takes at most. A backlog longer than this drains over several polls. */
export const FEED_PAGE = 200

/** Events sent on connect before following the feed. */
export const DEFAULT_BACKLOG = 50
export const MAX_BACKLOG = 500

/** Silence after which the feed writes a comment so proxies do not close it. */
export const HEARTBEAT_MS = 15_000

const boundSchema = z.string().min(1).max(40).optional()

export const journalQuerySchema = z.object({ from: boundSchema, to: boundSchema })

export const streamQuerySchema = z.object({
  /** Resume point: the `id` of the last event the client processed. */
  after: z.string().min(1).max(160).optional(),
  backlog: z.coerce.number().int().min(0).max(MAX_BACKLOG).optional(),
})

export function createJournalRoutes(deps: JournalRouteDeps) {
  const app = new Hono<AppEnv>()

  const query = <S extends z.ZodType>(schema: S) =>
    zValidator('query', schema, (result) => {
      if (!result.success) throw result.error
    })

  /** Same rule as everywhere: someone else's mint does not exist for this session. */
  const requireToken = async (issuerId: string, mint: string) => {
    if (!(await deps.holders.ownsToken(issuerId, mint))) {
      throw notFound('this issuer has no such token')
    }
  }

  /**
   * The window this request covers.
   *
   * The frontier is read first and the bounds are resolved against it, so the
   * window is fixed before a single row is read. Everything after this point
   * reads a range that cannot grow: the indexer only ever inserts at or above
   * its cursor, and the horizon is below it.
   */
  const windowFor = async (mint: string, from: Bound | undefined, to: Bound | undefined) => {
    const frontier = await deps.journal.frontier(mint)
    const needsBracket = from?.kind === 'time' || to?.kind === 'time'
    const bracket = needsBracket
      ? await deps.journal.bracket(
          mint,
          from?.kind === 'time' ? from.unix : undefined,
          to?.kind === 'time' ? to.unix : undefined,
        )
      : { fromSlot: null, toSlot: null }

    return { frontier, window: resolveWindow({ from, to, bracket, frontier }) }
  }

  // ─── Export ────────────────────────────────────────────────────────────────

  /**
   * The journal for a period, NDJSON (FR-018).
   *
   * A read, so no role is required — membership is enough, exactly as for the
   * holder queue. Whether an observer may export the journal is a question for
   * the issuer's own rules, and answering it here by hiding history from a
   * role that is allowed to look would be the console inventing policy.
   */
  app.get('/tokens/:mint/journal', query(journalQuerySchema), async (c) => {
    const session = c.get('session')
    const mint = addressParam(c.req.param('mint'), 'mint')
    await requireToken(session.issuerId, mint)

    const asked = c.req.valid('query')
    const from = bound(asked.from, 'from')
    const to = bound(asked.to, 'to')
    const { frontier, window } = await windowFor(mint, from, to)

    // The count is taken before the first line goes out, because it is the
    // first line: a reader must be able to tell a short file from a complete
    // one without asking us again (`@forge/shared/journal`).
    const manifest: JournalManifest = {
      kind: 'manifest',
      version: JOURNAL_FORMAT_VERSION,
      issuerId: session.issuerId,
      mint,
      programId: PROGRAM_ID.toBase58(),
      fromSlot: window.fromSlot,
      toSlot: window.toSlot,
      count: await deps.journal.count(mint, window),
      indexedThroughSlot: frontier.indexedThroughSlot,
      exportedAt: deps.now().toISOString(),
    }

    c.header('Content-Type', JOURNAL_CONTENT_TYPE)
    c.header('Content-Disposition', `attachment; filename="${filename(mint, window)}"`)
    // The export is produced as it is read, so its length is not known when the
    // headers go out; saying so keeps proxies from buffering the whole file.
    c.header('Cache-Control', 'no-store')

    const log = c.get('log')
    return stream(
      c,
      async (out) => {
        await out.write(journalLine(manifest))

        let after: EventCursor | undefined
        let written = 0
        while (!out.aborted) {
          const page = await deps.journal.page(mint, {
            after,
            window,
            limit: JOURNAL_PAGE,
          })
          for (const event of page) await out.write(journalLine(event))

          written += page.length
          const last = page.at(-1)
          if (last === undefined || page.length < JOURNAL_PAGE) break
          after = cursorOf(last)
        }

        log.info({ mint, ...window, declared: manifest.count, written }, 'journal exported')
      },
      async (error) => {
        // The status and the manifest are already on the wire, so this cannot
        // become a 500. The file ends short of its declared count, which is
        // exactly how a reader is meant to notice (SC-006).
        log.error({ err: error, mint, ...window }, 'journal export failed mid-stream')
      },
    )
  })

  // ─── Feed ──────────────────────────────────────────────────────────────────

  /**
   * The live feed, SSE (FR-037).
   *
   * Authentication is the ordinary session on the ordinary header: the console
   * reads this with `fetch`, not with `EventSource`, precisely so that it can
   * send one. A token in the query string would be a second way into the
   * session, and it would end up in the host's access log — a durable copy of
   * a live credential, written by us, in the product whose subject is who saw
   * what.
   *
   * Each message's `id` is the cursor, so a client that dropped resumes with
   * `?after=<id>` and loses nothing in between.
   */
  app.get('/tokens/:mint/stream', query(streamQuerySchema), async (c) => {
    const session = c.get('session')
    const mint = addressParam(c.req.param('mint'), 'mint')
    await requireToken(session.issuerId, mint)

    const asked = c.req.valid('query')
    // `Last-Event-ID` is the SSE protocol's own resume header; `?after=` is the
    // same value for a client that reads the stream with `fetch` and therefore
    // never gets the header behaviour for free. The explicit parameter wins.
    const resume = asked.after ?? c.req.header('last-event-id')
    const after = resume === undefined ? undefined : cursorParam(resume)
    const backlog = after === undefined ? (asked.backlog ?? DEFAULT_BACKLOG) : 0

    const log = c.get('log')
    const pollMs = deps.feedPollMs ?? FEED_POLL_MS

    // nginx and most reverse proxies buffer a response body by default, which
    // for SSE means the console receives nothing until the connection ends.
    // `Cache-Control` is set by `streamSSE` itself.
    c.header('X-Accel-Buffering', 'no')

    return streamSSE(c, async (out) => {
      try {
        let cursor = after
        let lastWrite = Date.now()

        const send = async (event: IndexedEvent) => {
          await out.writeSSE({ data: JSON.stringify(event), id: formatCursor(cursorOf(event)) })
          cursor = cursorOf(event)
          lastWrite = Date.now()
        }

        if (after === undefined) {
          const { window } = await windowFor(mint, undefined, undefined)
          // One query serves both readings of "where do I start". With a
          // backlog the recent events are the answer; without one only their
          // last cursor is, and the feed opens silent — otherwise `backlog=0`
          // would replay the whole table, which is the opposite of what it
          // asks for.
          const recent = await deps.journal.tail(mint, window, Math.max(backlog, 1))
          if (backlog > 0) {
            for (const event of recent) await send(event)
          } else {
            const last = recent.at(-1)
            if (last !== undefined) cursor = cursorOf(last)
          }
        }

        while (!out.aborted) {
          // The window is re-read every pass: its upper edge is the indexer's
          // horizon, and waiting for the feed is waiting for that edge to move.
          const { window } = await windowFor(mint, undefined, undefined)
          const page = isEmpty(window)
            ? []
            : await deps.journal.page(mint, { after: cursor, window, limit: FEED_PAGE })
          for (const event of page) await send(event)

          if (out.aborted) break
          // A full page means there is more behind it; draining without a pause
          // is how a client that was away for an hour catches up in seconds.
          if (page.length === FEED_PAGE) continue

          if (Date.now() - lastWrite >= HEARTBEAT_MS) {
            // A comment, not an event: it keeps the connection alive through
            // idle timeouts without the client having to know about it.
            await out.write(': keep-alive\n\n')
            lastWrite = Date.now()
          }
          await out.sleep(pollMs)
        }

        log.info({ mint }, 'feed closed')
      } catch (error) {
        // Caught here rather than handed to `streamSSE`: its own handler puts
        // the exception's message on the wire, and that message is a database
        // driver's text. The rule from `errors.ts` holds on this connection
        // too — the client gets a code, the log gets the cause.
        log.error({ err: error, mint }, 'feed failed')
        // Without a line the console would see the stream simply stop, which
        // is indistinguishable from "nothing is happening" — the one thing a
        // compliance feed must never be mistaken for.
        await out.writeSSE({ event: 'error', data: JSON.stringify({ code: 'INTERNAL' }) })
      }
    })
  })

  return app
}

// ─── Parameters ──────────────────────────────────────────────────────────────

/**
 * A malformed bound is a 400 with the reason, not a 500 from a parser.
 *
 * `parseBound` throws a plain `RangeError` on purpose: it is a pure function
 * shared with tests that know nothing about HTTP, and the translation into an
 * API error belongs at the edge, which is here.
 */
function bound(value: string | undefined, edge: 'from' | 'to'): Bound | undefined {
  if (value === undefined) return undefined
  try {
    return parseBound(value, edge)
  } catch (error) {
    throw invalidInput(error instanceof RangeError ? error.message : `${edge} is not a valid bound`)
  }
}

function cursorParam(value: string): EventCursor {
  try {
    return parseCursor(value)
  } catch (error) {
    throw invalidInput(error instanceof RangeError ? error.message : 'after is not a valid cursor')
  }
}

/** The name the officer's browser saves the export under: the token and the window. */
function filename(mint: string, window: SlotWindow): string {
  return `journal-${mint}-${window.fromSlot}-${window.toSlot}.ndjson`
}

/** As in the holder routes: an address from the path is checked before web3.js sees it. */
function addressParam(value: string | undefined, label: string): string {
  const parsed = addressSchema.safeParse(value)
  if (!parsed.success) throw invalidInput(`${label} is not a base58 address`)
  return parsed.data
}
