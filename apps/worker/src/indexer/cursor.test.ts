import { createLogger } from '@forge/shared/log'
import { describe, expect, it } from 'vitest'
import { type Cursor, type CursorStore, createIndexer, type Seen } from './cursor.ts'

const logger = createLogger({ level: 'silent', service: 'test' })

function memoryStore(): CursorStore & { saved: Cursor[] } {
  const saved: Cursor[] = []
  return {
    saved,
    load: async () => saved.at(-1),
    save: async (cursor) => {
      saved.push(cursor)
    },
  }
}

const seen = (signature: string, slot: number): Seen => ({ signature, slot })

describe('createIndexer', () => {
  it('applies in arrival order, one at a time, and saves the cursor after each', async () => {
    const store = memoryStore()
    const applied: string[] = []
    let inFlight = 0
    let overlapped = false
    const indexer = createIndexer({
      store,
      initial: undefined,
      logger,
      handle: async ({ signature }) => {
        inFlight += 1
        if (inFlight > 1) overlapped = true
        await new Promise((resolve) => setTimeout(resolve, 5))
        applied.push(signature)
        inFlight -= 1
      },
    })

    indexer.push(seen('a', 1))
    indexer.push(seen('b', 2))
    await indexer.handle(seen('c', 3))
    await indexer.drain()

    expect(applied).toEqual(['a', 'b', 'c'])
    expect(overlapped).toBe(false)
    expect(store.saved).toEqual([seen('a', 1), seen('b', 2), seen('c', 3)])
    expect(indexer.cursor()).toEqual(seen('c', 3))
  })

  it('skips what is behind the cursor, including the cursor itself', async () => {
    const applied: string[] = []
    const indexer = createIndexer({
      store: memoryStore(),
      initial: seen('b', 2),
      logger,
      handle: async ({ signature }) => {
        applied.push(signature)
      },
    })

    await indexer.handle(seen('a', 1))
    await indexer.handle(seen('b', 2))
    // A sibling in the cursor's slot is new: the slot alone does not identify a transaction.
    await indexer.handle(seen('b2', 2))
    await indexer.handle(seen('c', 3))

    expect(applied).toEqual(['b2', 'c'])
  })

  it('halts on a failure rather than letting the cursor pass it', async () => {
    const store = memoryStore()
    const applied: string[] = []
    let failOnce = true
    const indexer = createIndexer({
      store,
      initial: undefined,
      logger,
      handle: async ({ signature }) => {
        if (signature === 'b' && failOnce) {
          failOnce = false
          throw new Error('database away')
        }
        applied.push(signature)
      },
    })

    await indexer.handle(seen('a', 1))
    await indexer.handle(seen('b', 2))
    // The subscription keeps delivering; nothing after the failure is applied.
    indexer.push(seen('c', 3))
    await indexer.handle(seen('d', 4))
    await indexer.drain()

    expect(indexer.halted()).toBe(true)
    expect(applied).toEqual(['a'])
    expect(indexer.cursor()).toEqual(seen('a', 1))

    // The next backfill pass resumes from the cursor and meets `b` again.
    indexer.resume()
    for (const next of [seen('b', 2), seen('c', 3), seen('d', 4)]) await indexer.handle(next)
    expect(applied).toEqual(['a', 'b', 'c', 'd'])
    expect(store.saved.at(-1)).toEqual(seen('d', 4))
  })
})
