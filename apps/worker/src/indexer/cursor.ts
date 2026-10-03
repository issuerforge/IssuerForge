// Where the indexer is, and the one-at-a-time queue that moves it.
//
// The cursor is the last transaction applied: `(slot, signature)`, persisted
// after every transaction so that a restart resumes rather than replays the
// program's whole history. Within one slot the chain has an order the cursor
// cannot express, so a short memory of signatures at the cursor's slot tells
// a duplicate from a sibling.
import type { Logger } from '@forge/shared/log'

export interface Cursor {
  readonly signature: string
  readonly slot: number
}

/** A transaction the indexer has been told about, not yet fetched. */
export interface Seen {
  readonly signature: string
  readonly slot: number
}

export interface CursorStore {
  load(): Promise<Cursor | undefined>
  save(cursor: Cursor): Promise<void>
}

export type TransactionHandler = (seen: Seen) => Promise<void>

export interface IndexerOptions {
  readonly store: CursorStore
  readonly initial: Cursor | undefined
  readonly handle: TransactionHandler
  readonly logger: Logger
}

export interface Indexer {
  /**
   * Awaited, from a pass over the signature index (`follow.ts`) — the only
   * caller. The subscription does not apply anything itself: a transaction it
   * names past one the socket dropped would move the cursor over the gap.
   */
  handle(seen: Seen): Promise<void>
  cursor(): Cursor | undefined
  /**
   * Whether a transaction failed to apply since the last resume. Nothing
   * after the failed transaction is applied while halted; the next pass
   * resumes from the cursor and meets the failed transaction again.
   */
  halted(): boolean
  resume(): void
  drain(): Promise<void>
}

const RECENT_SIGNATURES = 256

/**
 * One transaction at a time, in arrival order: the mirror upserts must not
 * interleave.
 *
 * A failure does not advance the cursor and halts the queue: the
 * alternative — carry on with the next transaction — would let the cursor
 * pass the failed one, and the index would be missing a transaction with
 * nothing to say so. Halted, the index is late; it is never wrong.
 */
export function createIndexer(options: IndexerOptions): Indexer {
  let cursor = options.initial
  let halted = false
  const recent: string[] = cursor === undefined ? [] : [cursor.signature]
  let queue: Promise<void> = Promise.resolve()

  function isBehind(seen: Seen): boolean {
    if (cursor === undefined) return false
    if (seen.slot < cursor.slot) return true
    return seen.slot === cursor.slot && recent.includes(seen.signature)
  }

  async function process(seen: Seen): Promise<void> {
    if (halted || isBehind(seen)) return
    try {
      await options.handle(seen)
    } catch (error) {
      halted = true
      options.logger.error(
        { err: error, signature: seen.signature, slot: seen.slot },
        'apply failed; halted until the next backfill pass',
      )
      return
    }
    cursor = { signature: seen.signature, slot: seen.slot }
    recent.push(seen.signature)
    if (recent.length > RECENT_SIGNATURES) recent.shift()
    await options.store.save(cursor)
  }

  function handle(seen: Seen): Promise<void> {
    const next = queue.then(() => process(seen))
    queue = next.catch(() => undefined)
    return next
  }

  return {
    handle,
    cursor: () => cursor,
    halted: () => halted,
    resume: () => {
      halted = false
    },
    drain: () => queue,
  }
}
