import { journalLine } from '@forge/shared/journal'
import { describe, expect, it } from 'vitest'
import { readJournal } from './file.ts'
import {
  ALICE,
  ALICE_ATA,
  BOB,
  BOB_ATA,
  ISSUER_ID,
  key,
  MINT,
  PROGRAM,
  signature,
} from './testing/fixtures.ts'

const manifest = {
  kind: 'manifest',
  version: 1,
  issuerId: ISSUER_ID,
  mint: MINT,
  programId: PROGRAM,
  fromSlot: 100,
  toSlot: 200,
  count: 2,
  indexedThroughSlot: 201,
  exportedAt: '2026-10-03T12:00:00.000Z',
} as const

const transfer = (slot: number, sig = signature(), eventIndex = 0) =>
  ({
    kind: 'transfer',
    signature: sig,
    slot,
    blockTime: null,
    eventIndex,
    mint: MINT,
    source: ALICE_ATA,
    destination: BOB_ATA,
    sender: ALICE,
    recipient: BOB,
    amount: '1',
  }) as const

const text = (...lines: object[]) => `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`

describe('readJournal', () => {
  it('reads what the api writes', () => {
    const lines = [manifest, transfer(100), transfer(150)]
    const file = readJournal(lines.map((line) => journalLine(line)).join(''))
    expect(file.problems).toEqual([])
    expect(file.entries.map((e) => e.line)).toEqual([2, 3])
  })

  it('reports lines that are not journal lines, by number', () => {
    const file = readJournal(
      `${JSON.stringify(manifest)}\n{oops\n${JSON.stringify({ kind: 'nope' })}\n`,
    )
    expect(file.problems.slice(0, 2)).toEqual([
      'line 2: not JSON',
      expect.stringMatching(/^line 3: not a journal line/),
    ])
  })

  it('wants the manifest first and only once', () => {
    expect(readJournal(text(transfer(100), manifest)).problems).toEqual([
      'line 2: a manifest after the first line',
      'the file does not start with a manifest',
    ])
  })

  it('checks the claims each line makes against the manifest', () => {
    const sig = signature()
    const file = readJournal(
      text({ ...manifest, count: 4 }, transfer(150, sig), transfer(150, sig), transfer(120), {
        ...transfer(250),
        mint: key(),
      }),
    )
    expect(file.problems).toEqual([
      `line 3: event ${sig}:0 appears twice`,
      'line 4: out of order',
      expect.stringMatching(/^line 5: an event of mint /),
      'line 5: slot 250 is outside the window 100…200',
    ])
  })

  it('does not let the window run past what was indexed', () => {
    const file = readJournal(text({ ...manifest, count: 0, indexedThroughSlot: 150 }))
    expect(file.problems).toEqual(['the window ends at slot 200, past what was indexed (150)'])
  })
})
