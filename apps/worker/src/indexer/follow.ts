// How the indexer keeps up: every transaction comes from the signature index,
// walked forward from the cursor. The subscription only says "look now".
//
// It used to apply what it was notified of directly. That moved the cursor
// past whatever the socket had dropped in between — on a public node a 429
// on the socket is routine — and the backfill, which starts from the cursor,
// then had nothing to find. Seven of a token's fourteen events went missing
// that way in the T033 run, and only the journal verifier noticed. With one
// source of order there is no gap to step over: a dropped notification costs
// a few seconds, the next one or the timer covers it.
import type { Logger } from '@forge/shared/log'
import type { Indexer, Seen } from './cursor.ts'

/** Every signature newer than the given one, oldest first. */
export type ListSince = (since: string | undefined) => Promise<Seen[]>

export interface FollowerOptions {
  readonly indexer: Indexer
  readonly list: ListSince
  readonly logger: Logger
  /** How long a wake waits for more notifications before the pass, so a burst costs one listing. */
  readonly settleMs: number
}

export interface Follower {
  /** One pass from the cursor to the tip. Concurrent calls share the running pass. */
  pass(): Promise<void>
  /** From the subscription: a pass soon, never more than one waiting. */
  wake(): void
  /** Resolves once no pass is running or scheduled. */
  idle(): Promise<void>
  stop(): void
}

export function createFollower({ indexer, list, logger, settleMs }: FollowerOptions): Follower {
  let running: Promise<void> | undefined
  /** A wake arrived while a pass was running: the pass may have listed before it. */
  let again = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  async function walk(): Promise<void> {
    try {
      indexer.resume()
      const since = indexer.cursor()?.signature
      const pending = await list(since)
      for (const seen of pending) {
        await indexer.handle(seen)
        if (indexer.halted()) break
      }
      logger.info(
        {
          since: since ?? null,
          found: pending.length,
          cursor: indexer.cursor()?.signature ?? null,
        },
        'backfill pass',
      )
    } catch (error) {
      logger.warn({ err: error }, 'backfill failed')
    }
  }

  function pass(): Promise<void> {
    if (running !== undefined) return running
    running = walk().finally(() => {
      running = undefined
      if (again && !stopped) {
        again = false
        schedule()
      }
    })
    return running
  }

  function schedule(): void {
    if (timer !== undefined || stopped) return
    timer = setTimeout(() => {
      timer = undefined
      void pass()
    }, settleMs)
  }

  return {
    pass,
    wake() {
      if (running !== undefined) again = true
      else schedule()
    },
    async idle() {
      while (running !== undefined || timer !== undefined) {
        await (running ?? new Promise((resolve) => setTimeout(resolve, settleMs)))
      }
    },
    stop() {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}
