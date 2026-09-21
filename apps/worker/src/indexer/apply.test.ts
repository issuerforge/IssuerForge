import { eventKind } from '@forge/db'
import { indexedEventSchema } from '@forge/shared/events'
import { describe, expect, it } from 'vitest'
import { createApplier, type Stamp, type Writer } from './apply.ts'
import type { Decoded, EventRecord, MirrorChange } from './decode.ts'
import type { TransactionView } from './transaction.ts'

const view = (blockTime: number | null): TransactionView => ({
  signature: 'sig',
  slot: 500,
  blockTime,
  instructions: [],
  failure: null,
  tokenOwners: new Map(),
})

function recorder(): Writer & { calls: string[]; stamps: Stamp[] } {
  const calls: string[] = []
  const stamps: Stamp[] = []
  return {
    calls,
    stamps,
    async applyChange(change, stamp) {
      calls.push(change.kind)
      stamps.push(stamp)
    },
    async insertEvents(records) {
      calls.push(`events:${records.length}`)
    },
  }
}

const changes: MirrorChange[] = [
  { kind: 'token_created', mint: 'm', issuerId: 'i', decimals: 2, policyVersion: 1 },
  { kind: 'holder_thawed', mint: 'm', issuerId: 'i', wallet: 'w', status: null },
]
const records: EventRecord[] = [
  { issuerId: 'i', event: { kind: 'thaw' } as unknown as EventRecord['event'] },
]

describe('createApplier', () => {
  it('writes the mirror in decode order, then the events', async () => {
    const writer = recorder()
    const apply = createApplier(writer, () => new Date('2026-09-21T10:00:00Z'))
    const decoded: Decoded = { events: records, changes }

    await apply(view(1_772_600_000), decoded)

    expect(writer.calls).toEqual(['token_created', 'holder_thawed', 'events:1'])
  })

  it('stamps a fact with the block time, and with the reading time where there is none', async () => {
    const writer = recorder()
    const now = new Date('2026-09-21T10:00:00Z')
    const apply = createApplier(writer, () => now)

    await apply(view(1_772_600_000), { events: [], changes: changes.slice(0, 1) })
    await apply(view(null), { events: [], changes: changes.slice(0, 1) })

    expect(writer.stamps[0]).toEqual({
      slot: 500,
      at: new Date(1_772_600_000 * 1000),
      syncedAt: now,
    })
    expect(writer.stamps[1]).toEqual({ slot: 500, at: now, syncedAt: now })
  })

  it('does not call for an insert when a transaction produced no events', async () => {
    const writer = recorder()
    await createApplier(writer)(view(null), { events: [], changes: [] })
    expect(writer.calls).toEqual([])
  })
})

describe('the events table', () => {
  it('admits exactly the kinds the union defines', () => {
    // The database enum is a copy of the union's `kind` literals, kept apart
    // so that the db package does not import Zod. This is where the two are
    // held together.
    const kinds = indexedEventSchema.options.map((option) => option.shape.kind.value)
    expect([...eventKind.enumValues].sort()).toEqual([...kinds].sort())
  })
})
