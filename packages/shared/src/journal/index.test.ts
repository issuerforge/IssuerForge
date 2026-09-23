import { describe, expect, it } from 'vitest'
import type { TransferEvent } from '../events/index.ts'
import {
  JOURNAL_FORMAT_VERSION,
  type JournalManifest,
  journalLine,
  journalLineSchema,
  journalManifestSchema,
} from './index.ts'

const MINT = 'So11111111111111111111111111111111111111112'
const ISSUER = '11111111111111111111111111111112'
const PROGRAM = 'SysvarC1ock11111111111111111111111111111111'
const SIGNATURE = '5'.repeat(88)

const manifest = (overrides: Partial<JournalManifest> = {}): JournalManifest => ({
  kind: 'manifest',
  version: JOURNAL_FORMAT_VERSION,
  issuerId: ISSUER,
  mint: MINT,
  programId: PROGRAM,
  fromSlot: 500,
  toSlot: 900,
  count: 2,
  indexedThroughSlot: 950,
  exportedAt: '2026-09-23T10:00:00.000Z',
  ...overrides,
})

const transfer: TransferEvent = {
  kind: 'transfer',
  signature: SIGNATURE,
  slot: 700,
  blockTime: 1_790_000_000,
  eventIndex: 0,
  mint: MINT,
  source: ISSUER,
  destination: PROGRAM,
  sender: ISSUER,
  recipient: PROGRAM,
  amount: '1000',
}

describe('journalManifestSchema', () => {
  it('accepts a manifest', () => {
    expect(journalManifestSchema.parse(manifest())).toEqual(manifest())
  })

  it('accepts an empty export, where the window is inverted', () => {
    // An export of a period in which nothing happened is not an error, and the
    // bounds still say which period was asked for.
    expect(
      journalManifestSchema.safeParse(manifest({ fromSlot: 901, toSlot: 900, count: 0 })).success,
    ).toBe(true)
  })

  it('rejects a version it cannot claim to understand', () => {
    expect(journalManifestSchema.safeParse(manifest({ version: 2 as 1 })).success).toBe(false)
  })
})

describe('journalLineSchema', () => {
  it('reads both a manifest and an event through one discriminator', () => {
    expect(journalLineSchema.parse(manifest()).kind).toBe('manifest')
    expect(journalLineSchema.parse(transfer).kind).toBe('transfer')
  })

  it('rejects a kind that is neither', () => {
    expect(journalLineSchema.safeParse({ ...transfer, kind: 'proposal' }).success).toBe(false)
  })
})

describe('journalLine', () => {
  it('ends every line, so the last one is not glued to the next file', () => {
    const line = journalLine(transfer)
    expect(line.endsWith('\n')).toBe(true)
    expect(journalLineSchema.parse(JSON.parse(line))).toEqual(transfer)
  })
})
