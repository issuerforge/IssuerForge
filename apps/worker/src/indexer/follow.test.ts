import { createLogger } from '@forge/shared/log'
import { describe, expect, it } from 'vitest'
import { type Cursor, createIndexer, type Seen } from './cursor.ts'
import { createFollower, type ListSince } from './follow.ts'

const logger = createLogger({ level: 'silent', service: 'test' })
const seen = (signature: string, slot: number): Seen => ({ signature, slot })

/** A chain whose signature index can grow while the test runs. */
function chain(initial: Seen[]) {
  const landed = [...initial]
  let listings = 0
  const list: ListSince = async (since) => {
    listings += 1
    const from = since === undefined ? 0 : landed.findIndex((s) => s.signature === since) + 1
    return landed.slice(from)
  }
  return { landed, list, listings: () => listings }
}

function setup(initial: Seen[], cursor: Cursor | undefined) {
  const applied: string[] = []
  const indexer = createIndexer({
    store: { load: async () => cursor, save: async () => undefined },
    initial: cursor,
    logger,
    handle: async ({ signature }) => {
      applied.push(signature)
    },
  })
  const network = chain(initial)
  const follower = createFollower({ indexer, list: network.list, logger, settleMs: 5 })
  return { applied, indexer, network, follower }
}

describe('createFollower', () => {
  it('does not step over a transaction the socket dropped', async () => {
    // The cursor is at `a`; `b` and `c` land; the socket delivers only `c`.
    const { applied, indexer, network, follower } = setup([seen('a', 1)], seen('a', 1))
    network.landed.push(seen('b', 2), seen('c', 3))

    follower.wake() // the notification for `c` — nothing names `b`
    await follower.idle()

    expect(applied).toEqual(['b', 'c'])
    expect(indexer.cursor()).toEqual(seen('c', 3))
  })

  it('answers a burst of notifications with one listing', async () => {
    const { applied, network, follower } = setup([], undefined)
    network.landed.push(seen('a', 1), seen('b', 2), seen('c', 3))

    for (let i = 0; i < 3; i += 1) follower.wake()
    await follower.idle()

    expect(network.listings()).toBe(1)
    expect(applied).toEqual(['a', 'b', 'c'])
  })

  it('passes again when woken during a pass that may have listed too early', async () => {
    const { applied, network, follower } = setup([seen('a', 1)], undefined)
    const first = follower.pass()
    // `b` lands after the running pass listed, and its notification arrives now.
    network.landed.push(seen('b', 2))
    follower.wake()
    await first
    await follower.idle()

    expect(applied).toEqual(['a', 'b'])
    expect(network.listings()).toBe(2)
  })

  it('stops at a failed transaction and meets it again on the next pass', async () => {
    let failOnce = true
    const applied: string[] = []
    const indexer = createIndexer({
      store: { load: async () => undefined, save: async () => undefined },
      initial: undefined,
      logger,
      handle: async ({ signature }) => {
        if (signature === 'b' && failOnce) {
          failOnce = false
          throw new Error('429')
        }
        applied.push(signature)
      },
    })
    const network = chain([seen('a', 1), seen('b', 2), seen('c', 3)])
    const follower = createFollower({ indexer, list: network.list, logger, settleMs: 5 })

    await follower.pass()
    expect(applied).toEqual(['a'])
    await follower.pass()
    expect(applied).toEqual(['a', 'b', 'c'])
  })
})
