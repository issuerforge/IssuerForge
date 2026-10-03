import type { IndexedEvent } from '@forge/shared/events'
import { type JournalManifest, journalLine } from '@forge/shared/journal'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import type { Chain } from './chain.ts'
import { readTransaction } from './decode.ts'
import {
  ADMIN,
  ALICE_ATA,
  fakeChain,
  ISSUER_CONFIG,
  ISSUER_ID,
  key,
  type Landed,
  landed,
  MINT,
  OFFICER,
  ours,
  PROGRAM,
  reason,
  signature,
  state,
  TOKEN_2022,
  TOKEN_CONFIG,
  transferChecked,
} from './testing/fixtures.ts'
import { type Report, unconfirmedShare, verifyJournal } from './verify.ts'

const PROPOSAL = key()
const SYSTEM = '11111111111111111111111111111111'
const freezeAccounts = [
  ISSUER_CONFIG,
  TOKEN_CONFIG,
  MINT,
  ALICE_ATA,
  key(),
  key(),
  OFFICER,
  TOKEN_2022,
  SYSTEM,
]
const circulation = [ISSUER_CONFIG, TOKEN_CONFIG, MINT, PROPOSAL, TOKEN_2022, OFFICER, ADMIN]

/** A short history of the token: transfers, a refusal, a freeze, a pause, a delegation change. */
const HISTORY: Landed[] = [
  landed(1000, { instructions: [transferChecked(10n)] }),
  landed(1001, {
    instructions: [transferChecked(60_000_000n)],
    err: { InstructionError: [0, { Custom: 6009 }] },
  }),
  landed(1002, {
    instructions: [ours('freezeHolder', { reason: reason(4, 'FIU-NG/2026/1') }, freezeAccounts)],
  }),
  landed(1003, {
    instructions: [ours('pauseCirculation', { reason: reason(9, 'INC-1') }, circulation)],
  }),
  landed(1004, {
    instructions: [
      ours('setDelegation', { operationalKey: new PublicKey(key()), mask: 0 }, [
        ISSUER_CONFIG,
        PROGRAM,
        ADMIN,
      ]),
    ],
  }),
  // Another token's transfer in the window: the program's, but not this mint's.
  (() => {
    const [source, destination] = [key(), key()]
    return landed(1005, {
      instructions: [transferChecked(1n, { source, destination, authority: key(), mint: key() })],
      balances: [
        [source, key()],
        [destination, key()],
      ],
    })
  })(),
]

/** What the api would export for the window: the token's events, in order. */
async function exported(history: readonly Landed[]): Promise<IndexedEvent[]> {
  const events: IndexedEvent[] = []
  for (const tx of history) {
    const reading = await readTransaction(tx.signature, tx.response, PROGRAM, state)
    events.push(...reading.events.filter((event) => event.mint === MINT))
  }
  return events
}

function manifest(events: readonly IndexedEvent[], overrides: Partial<JournalManifest> = {}) {
  return {
    kind: 'manifest',
    version: 1,
    issuerId: ISSUER_ID,
    mint: MINT,
    programId: PROGRAM,
    fromSlot: 1000,
    toSlot: 1010,
    count: events.length,
    indexedThroughSlot: 1011,
    exportedAt: '2026-10-03T12:00:00.000Z',
    ...overrides,
  } as const
}

function file(events: readonly IndexedEvent[], overrides: Partial<JournalManifest> = {}): string {
  return [manifest(events, overrides), ...events].map((line) => journalLine(line)).join('')
}

const verify = (text: string, chain: Chain = fakeChain(HISTORY)): Promise<Report> =>
  verifyJournal({ text, chain, programId: PROGRAM })

describe('an honest journal', () => {
  it('passes with every line confirmed and the delegation named aside', async () => {
    const events = await exported(HISTORY)
    expect(events.map((e) => e.kind)).toEqual(['transfer', 'refusal', 'compliance', 'compliance'])

    const report = await verify(file(events))
    expect(report.problems).toEqual([])
    expect(report).toMatchObject({ lines: 4, confirmed: 4, passed: true })
    expect(unconfirmedShare(report)).toBe(0)
    expect(report.unjournalled.map((i) => i.instruction)).toEqual(['setDelegation'])
  })

  it('passes an empty period that really was empty', async () => {
    const report = await verify(
      file([], { fromSlot: 2000, toSlot: 2010, indexedThroughSlot: 2011 }),
    )
    expect(report).toMatchObject({ lines: 0, passed: true })
  })
})

describe('a journal that was tampered with', () => {
  it('names the field when a line was edited', async () => {
    const events = await exported(HISTORY)
    const edited = events.map((e) => (e.kind === 'transfer' ? { ...e, amount: '11' } : e))
    const report = await verify(file(edited))

    expect(report.passed).toBe(false)
    expect(report.mismatched).toEqual([
      {
        line: 2,
        key: `${HISTORY[0]?.signature}:0`,
        fields: [{ field: 'amount', journal: '11', chain: '10' }],
      },
    ])
    expect(unconfirmedShare(report)).toBe(0.25)
  })

  it('does not confirm a line the chain never saw', async () => {
    const events = await exported(HISTORY)
    const invented = { ...(events[0] as IndexedEvent), signature: signature(), slot: 1006 }
    const report = await verify(file([...events, invented]))

    expect(report.passed).toBe(false)
    expect(report.unconfirmed).toHaveLength(1)
    expect(report.unconfirmed[0]).toMatchObject({ line: 6 })
  })

  it('does not confirm a refusal relabelled as a transfer', async () => {
    const events = await exported(HISTORY)
    const refusal = events[1] as Extract<IndexedEvent, { kind: 'refusal' }>
    const { code: _c, programError: _p, ruleSlot: _r, ...rest } = refusal
    const relabelled = events.map((e) =>
      e === refusal ? { ...rest, kind: 'transfer' as const } : e,
    )
    const report = await verify(file(relabelled))
    expect(report.mismatched[0]?.fields.map((f) => f.field)).toEqual(
      expect.arrayContaining(['kind', 'code', 'programError', 'ruleSlot']),
    )
  })

  it('finds a line removed with the count lowered to match', async () => {
    const events = await exported(HISTORY)
    const withoutFreeze = events.filter((e) => !(e.kind === 'compliance' && e.action === 'freeze'))
    const report = await verify(file(withoutFreeze))

    expect(report.problems).toEqual([])
    expect(report.confirmed).toBe(3)
    expect(report.missing.map((e) => e.kind)).toEqual(['compliance'])
    expect(report.passed).toBe(false)
  })

  it('sees a truncated file by the manifest alone', async () => {
    const events = await exported(HISTORY)
    const report = await verify(file(events).split('\n').slice(0, 3).join('\n'))
    expect(report.problems).toContain('the manifest counts 4 events, the file holds 2')
    expect(report.passed).toBe(false)
  })

  it("does not take the file's word for whose token it is", async () => {
    const events = await exported(HISTORY)
    const report = await verify(file(events, { issuerId: key() }))
    expect(report.problems[0]).toMatch(/^the token belongs to issuer /)
  })

  it('refuses to vouch for a window the chain has not finalized', async () => {
    const events = await exported(HISTORY)
    const report = await verify(file(events), fakeChain(HISTORY, 1005))
    expect(report.problems[0]).toMatch(/has finalized 1005/)
    expect(report.passed).toBe(false)
  })

  it('cannot vouch for a window with a transaction it could not read', async () => {
    const events = await exported(HISTORY)
    const chain = fakeChain(HISTORY)
    const broken: Chain = {
      ...chain,
      transaction: async (sig) => {
        if (sig === HISTORY[3]?.signature) throw new Error('429 Too Many Requests')
        return chain.transaction(sig)
      },
    }
    const report = await verify(file(events), broken)
    expect(report.unreadable).toEqual([
      { signature: HISTORY[3]?.signature, why: '429 Too Many Requests' },
    ])
    expect(report.unconfirmed).toHaveLength(1)
    expect(report.passed).toBe(false)
  })

  it('stops at a file without a manifest', async () => {
    const events = await exported(HISTORY)
    const text = events.map((e) => journalLine(e)).join('')
    const report = await verify(text)
    expect(report.problems).toEqual(['the file does not start with a manifest'])
    expect(report.passed).toBe(false)
  })
})
