import { ROLE } from '@forge/shared/api'
import { apiErrorSchema } from '@forge/shared/errors'
import type { IndexedEvent } from '@forge/shared/events'
import { journalLineSchema, journalManifestSchema } from '@forge/shared/journal'
import { createLogger } from '@forge/shared/log'
import { describe, expect, it, vi } from 'vitest'
import type { ChainReader } from '../chain.ts'
import type { Directory } from '../directory.ts'
import type { HolderStore } from '../holders.ts'
import type { IssuanceStore } from '../issuance.ts'
import {
  type EventCursor,
  type Frontier,
  formatCursor,
  isEmpty,
  type JournalStore,
  type SlotWindow,
} from '../journal.ts'
import type { OperationalSigner } from '../operational.ts'
import type { PrivyClient } from '../privy.ts'
import { createServer, type ServerDeps } from '../server.ts'
import { DEFAULT_BACKLOG, MAX_BACKLOG } from './journal.ts'

const ISSUER = '11111111111111111111111111111112'
const ADMIN = 'SysvarC1ock11111111111111111111111111111111'
const MINT = 'So11111111111111111111111111111111111111112'
const OTHER_MINT = 'SysvarRent111111111111111111111111111111111'
const NOW = new Date('2026-09-23T12:00:00.000Z')
const TOKEN = 'Bearer test-token'

/**
 * A signature that differs only in its last character, so sorting is visible.
 * The alphabet is base58's, which has no `0`, `O`, `I` or `l`.
 */
const signature = (n: number) => `${'5'.repeat(87)}${'ABCDEFGHJK'[n % 10]}`

const transfer = (slot: number, eventIndex = 0, n = slot % 10): IndexedEvent => ({
  kind: 'transfer',
  signature: signature(n),
  slot,
  blockTime: 1_790_000_000 + slot,
  eventIndex,
  mint: MINT,
  source: ISSUER,
  destination: ADMIN,
  sender: ISSUER,
  recipient: ADMIN,
  amount: String(slot),
})

// ─── A store that behaves like the table, without the table ──────────────────

const order = (event: IndexedEvent): string =>
  `${String(event.slot).padStart(12, '0')}:${event.signature}:${String(event.eventIndex).padStart(5, '0')}`

const after = (event: IndexedEvent, cursor: EventCursor | undefined) =>
  cursor === undefined ||
  order(event) >
    `${String(cursor.slot).padStart(12, '0')}:${cursor.signature}:${String(cursor.eventIndex).padStart(5, '0')}`

interface Fakes {
  events?: IndexedEvent[]
  frontier?: Frontier
  ownsToken?: boolean
  roles?: number
  feedPollMs?: number
  /** Called before each `page`, so a test can let the feed grow mid-stream. */
  beforePage?: () => void
}

function fakeJournal(fakes: Fakes) {
  const rows = fakes.events ?? []
  const within = (event: IndexedEvent, window: SlotWindow) =>
    event.slot >= window.fromSlot && event.slot <= window.toSlot

  const store: JournalStore = {
    frontier: async () => fakes.frontier ?? { indexedThroughSlot: 1001, horizonSlot: 1000 },
    bracket: async (_mint, from, to) => ({
      fromSlot:
        rows
          .filter((e) => e.blockTime !== null && e.blockTime >= (from ?? 0))
          .map((e) => e.slot)
          .sort((a, b) => a - b)[0] ?? null,
      toSlot:
        rows
          .filter((e) => e.blockTime !== null && e.blockTime <= (to ?? Number.MAX_SAFE_INTEGER))
          .map((e) => e.slot)
          .sort((a, b) => b - a)[0] ?? null,
    }),
    count: async (_mint, window) =>
      isEmpty(window) ? 0 : rows.filter((e) => within(e, window)).length,
    page: async (_mint, request) => {
      fakes.beforePage?.()
      if (isEmpty(request.window)) return []
      return rows
        .filter((e) => within(e, request.window) && after(e, request.after))
        .sort((a, b) => order(a).localeCompare(order(b)))
        .slice(0, request.limit)
    },
    tail: async (_mint, window, limit) =>
      isEmpty(window)
        ? []
        : rows
            .filter((e) => within(e, window))
            .sort((a, b) => order(a).localeCompare(order(b)))
            .slice(-limit),
  }
  return store
}

function app(fakes: Fakes = {}) {
  const journal = fakeJournal(fakes)

  const holders = new Proxy({} as HolderStore, {
    get: (_, key) =>
      key === 'ownsToken'
        ? async (_issuerId: string, mint: string) => (fakes.ownsToken ?? true) && mint === MINT
        : () => {
            throw new Error(`the holder database is not read here (${String(key)})`)
          },
  })

  const unreachable = (what: string) => () => {
    throw new Error(`${what} is not needed in these tests`)
  }

  const deps: ServerDeps = {
    logger: createLogger({ level: 'silent', service: 'test' }),
    webOrigins: ['https://console.example'],
    requestId: () => 'req-fixed',
    now: () => NOW,
    feedPollMs: fakes.feedPollMs ?? 1,
    privy: {
      authenticate: async () => ({ userId: 'did:privy:test', wallets: [ADMIN] }),
    } as PrivyClient,
    directory: {
      membershipsFor: async () => [
        {
          issuerId: ISSUER,
          roles: fakes.roles ?? ROLE.ADMIN,
          wallets: [ADMIN],
          syncedAt: '2026-09-01T00:00:00.000Z',
        },
      ],
      rosterFor: async () => [],
    } as Directory,
    chain: {
      program: undefined as unknown as ChainReader['program'],
      tokenCount: async () => 1,
      issuerConfig: unreachable('reading IssuerConfig'),
      holderStatusWritten: unreachable('reading HolderStatus'),
      latestBlockhash: unreachable('the network'),
    },
    issuance: { reserve: unreachable('a reservation') } as unknown as IssuanceStore,
    holders,
    journal,
    operational: {
      publicKey: undefined as unknown as OperationalSigner['publicKey'],
      submit: unreachable('signing'),
    },
  }

  return { server: createServer(deps), journal }
}

const get = (path: string, init: RequestInit = {}) =>
  new Request(`https://api.example${path}`, {
    ...init,
    headers: { authorization: TOKEN, ...init.headers },
  })

// ─── Export ──────────────────────────────────────────────────────────────────

/** Splits NDJSON into parsed lines, checking each against the shared schema. */
function readJournal(text: string) {
  const lines = text.split('\n').filter((line) => line.length > 0)
  const parsed = lines.map((line) => journalLineSchema.parse(JSON.parse(line)))
  const [head, ...rest] = parsed
  return { manifest: journalManifestSchema.parse(head), events: rest }
}

describe('GET /api/tokens/:mint/journal', () => {
  it('writes a manifest and then every event of the window, in chain order', async () => {
    const { server } = app({ events: [transfer(300), transfer(100), transfer(200)] })
    const response = await server.request(get(`/api/tokens/${MINT}/journal`))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/x-ndjson')

    const { manifest, events } = readJournal(await response.text())
    expect(manifest).toMatchObject({ mint: MINT, issuerId: ISSUER, fromSlot: 0, toSlot: 1000 })
    expect(manifest.count).toBe(3)
    expect(events.map((event) => 'slot' in event && event.slot)).toEqual([100, 200, 300])
  })

  it('declares the count before the lines, so a truncated file is visible', async () => {
    const { server } = app({ events: [transfer(100), transfer(200)] })
    const { manifest, events } = readJournal(
      await (await server.request(get(`/api/tokens/${MINT}/journal`))).text(),
    )
    expect(manifest.count).toBe(events.length)
  })

  it('offers the export as a file named after the token and the window', async () => {
    const { server } = app({ events: [transfer(100)] })
    const response = await server.request(get(`/api/tokens/${MINT}/journal?from=50&to=150`))
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="journal-${MINT}-50-150.ndjson"`,
    )
  })

  it('stops at the horizon even when asked for more', async () => {
    const { server } = app({
      events: [transfer(100), transfer(1500)],
      frontier: { indexedThroughSlot: 1001, horizonSlot: 1000 },
    })
    const { manifest, events } = readJournal(
      await (await server.request(get(`/api/tokens/${MINT}/journal?to=99999`))).text(),
    )
    expect(manifest.toSlot).toBe(1000)
    // The event above the horizon is not in the file, and the manifest says
    // where the mirror stopped rather than pretending the period was empty.
    expect(manifest.indexedThroughSlot).toBe(1001)
    expect(events).toHaveLength(1)
  })

  it('resolves dates into slots, so an event without a block time is not lost', async () => {
    const timeless: IndexedEvent = { ...transfer(150), blockTime: null }
    const { server } = app({ events: [transfer(100), timeless, transfer(200)] })

    const { manifest, events } = readJournal(
      await (await server.request(get(`/api/tokens/${MINT}/journal?from=2020-01-01`))).text(),
    )
    expect(manifest.fromSlot).toBe(100)
    // Filtered by time this row would vanish: it has none. Filtered by the
    // slot window its neighbours defined, it is in the file like the rest.
    expect(events).toHaveLength(3)
  })

  it('returns an empty journal, not an error, for a period with nothing in it', async () => {
    const { server } = app({ events: [transfer(100)] })
    const { manifest, events } = readJournal(
      await (await server.request(get(`/api/tokens/${MINT}/journal?from=500&to=600`))).text(),
    )
    expect(manifest.count).toBe(0)
    expect(events).toEqual([])
  })

  it('pages through an export longer than one page', async () => {
    // Two pages plus a remainder, so both the "keep going" and the "stop"
    // branches of the walk run.
    const events = Array.from({ length: 1101 }, (_, i) => transfer(i + 1, 0, i % 10))
    const { server } = app({ events, frontier: { indexedThroughSlot: 2000, horizonSlot: 1999 } })
    const { manifest, events: written } = readJournal(
      await (await server.request(get(`/api/tokens/${MINT}/journal`))).text(),
    )
    expect(manifest.count).toBe(1101)
    expect(written).toHaveLength(1101)
  })

  it('refuses a bound that is neither a slot nor a date', async () => {
    const { server } = app()
    const response = await server.request(get(`/api/tokens/${MINT}/journal?from=yesterday`))
    expect(response.status).toBe(400)
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe('INVALID_INPUT')
  })

  it("does not admit that another issuer's token exists", async () => {
    const { server } = app()
    const response = await server.request(get(`/api/tokens/${OTHER_MINT}/journal`))
    expect(response.status).toBe(404)
  })

  it('needs a session like every other route under /api', async () => {
    const { server } = app()
    const response = await server.request(
      new Request(`https://api.example/api/tokens/${MINT}/journal`),
    )
    expect(response.status).toBe(401)
  })
})

// ─── Feed ────────────────────────────────────────────────────────────────────

/** Reads an SSE stream until `wanted` `data:` lines have arrived, then cancels. */
async function readFeed(response: Response, wanted: number, budgetMs = 2000) {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('the feed has no body')

  const decoder = new TextDecoder()
  const deadline = Date.now() + budgetMs
  let text = ''
  try {
    while (countData(text) < wanted && Date.now() < deadline) {
      // Raced against the clock, not merely checked after it: a feed with
      // nothing to say never resolves `read()`, which is the normal state of
      // a live feed and must not be a hung test.
      const chunk = await Promise.race([
        reader.read(),
        new Promise<'idle'>((resolve) => setTimeout(() => resolve('idle'), deadline - Date.now())),
      ])
      if (chunk === 'idle') break
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    await reader.cancel()
  }
  return text
}

const countData = (text: string) => text.split('\n').filter((l) => l.startsWith('data: ')).length

function parseFeed(text: string) {
  return text
    .split('\n\n')
    .filter((block) => block.includes('data: '))
    .map((block) => {
      const lines = block.split('\n')
      const data = lines.find((l) => l.startsWith('data: '))?.slice(6) ?? ''
      const id = lines.find((l) => l.startsWith('id: '))?.slice(4)
      const event = lines.find((l) => l.startsWith('event: '))?.slice(7)
      return { id, event, data: JSON.parse(data) as Record<string, unknown> }
    })
}

describe('GET /api/tokens/:mint/stream', () => {
  it('sends the recent events on connect and tags each with its cursor', async () => {
    const { server } = app({ events: [transfer(100), transfer(200)] })
    const response = await server.request(get(`/api/tokens/${MINT}/stream`))

    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const messages = parseFeed(await readFeed(response, 2))
    expect(messages.map((m) => m.data.slot)).toEqual([100, 200])
    expect(messages[1]?.id).toBe(
      formatCursor({ slot: 200, signature: signature(0), eventIndex: 0 }),
    )
  })

  it('resumes after a cursor without repeating what was already sent', async () => {
    const { server } = app({ events: [transfer(100), transfer(200), transfer(300)] })
    const resume = formatCursor({ slot: 100, signature: signature(0), eventIndex: 0 })
    const response = await server.request(get(`/api/tokens/${MINT}/stream?after=${resume}`))

    const messages = parseFeed(await readFeed(response, 2))
    expect(messages.map((m) => m.data.slot)).toEqual([200, 300])
  })

  it('accepts the same cursor from Last-Event-ID, which is what SSE reconnects send', async () => {
    const { server } = app({ events: [transfer(100), transfer(200)] })
    const resume = formatCursor({ slot: 100, signature: signature(0), eventIndex: 0 })
    const response = await server.request(
      get(`/api/tokens/${MINT}/stream`, { headers: { 'last-event-id': resume } }),
    )

    const messages = parseFeed(await readFeed(response, 1))
    expect(messages.map((m) => m.data.slot)).toEqual([200])
  })

  it('keeps following: an event indexed after the connection opened arrives too', async () => {
    const events = [transfer(100)]
    const { server } = app({
      events,
      // The feed polls, so the table is allowed to grow between polls — which
      // is exactly what the indexer does to it in production.
      beforePage: () => {
        if (events.length === 1) events.push(transfer(200))
      },
    })

    const messages = parseFeed(
      await readFeed(await server.request(get(`/api/tokens/${MINT}/stream`)), 2),
    )
    expect(messages.map((m) => m.data.slot)).toEqual([100, 200])
  })

  it('sends no history when the client asks for none', async () => {
    const { server } = app({ events: [transfer(100)], beforePage: () => {} })
    const response = await server.request(get(`/api/tokens/${MINT}/stream?backlog=0`))
    // Nothing new arrives, so the read ends on its budget rather than on data.
    // The event already in the table is history, and history was declined.
    expect(parseFeed(await readFeed(response, 1, 120))).toEqual([])
  })

  it('refuses a backlog larger than the ceiling', async () => {
    const { server } = app()
    const response = await server.request(
      get(`/api/tokens/${MINT}/stream?backlog=${MAX_BACKLOG + 1}`),
    )
    expect(response.status).toBe(400)
  })

  it('caps the history it sends on connect', async () => {
    const events = Array.from({ length: DEFAULT_BACKLOG + 20 }, (_, i) =>
      transfer(i + 1, 0, i % 10),
    )
    const { server, journal } = app({ events })
    const tail = vi.spyOn(journal, 'tail')

    await readFeed(await server.request(get(`/api/tokens/${MINT}/stream`)), DEFAULT_BACKLOG)
    expect(tail).toHaveBeenCalledWith(MINT, expect.anything(), DEFAULT_BACKLOG)
  })

  it('refuses a malformed resume cursor', async () => {
    const { server } = app()
    const response = await server.request(get(`/api/tokens/${MINT}/stream?after=nonsense`))
    expect(response.status).toBe(400)
  })

  it("does not admit that another issuer's token exists", async () => {
    const { server } = app()
    expect((await server.request(get(`/api/tokens/${OTHER_MINT}/stream`))).status).toBe(404)
  })

  it('reports a failure as a code, not as the database driver’s text', async () => {
    const { server, journal } = app({ events: [transfer(100)] })
    vi.spyOn(journal, 'tail').mockRejectedValue(
      new Error('connection to server at "db.internal" failed'),
    )

    const text = await readFeed(await server.request(get(`/api/tokens/${MINT}/stream`)), 1)
    const [message] = parseFeed(text)
    expect(message?.event).toBe('error')
    expect(message?.data).toEqual({ code: 'INTERNAL' })
    expect(text).not.toContain('db.internal')
  })
})
