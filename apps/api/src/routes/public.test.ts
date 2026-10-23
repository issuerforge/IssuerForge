import { createLogger } from '@forge/shared/log'
import { describe, expect, it } from 'vitest'
import type { ActionReader } from '../actions.ts'
import type { ChainReader } from '../chain.ts'
import type { ComplianceReader, MintView } from '../compliance.ts'
import { publicTokenSchema } from '../contracts/public.ts'
import type { DelegationStore } from '../delegation.ts'
import type { Directory } from '../directory.ts'
import type { HolderStore } from '../holders.ts'
import type { IssuanceStore } from '../issuance.ts'
import type { JournalStore } from '../journal.ts'
import type { OperationalSigner } from '../operational.ts'
import type { PrivyClient } from '../privy.ts'
import type { ReserveTerms } from '../reserve.ts'
import { createServer } from '../server.ts'

const ATTESTOR = 'SysvarC1ock11111111111111111111111111111111'
const FORMER = 'SysvarS1otHashes111111111111111111111111111'
const MINT = 'So11111111111111111111111111111111111111112'
const UNKNOWN_MINT = 'Vote111111111111111111111111111111111111111'
const NOW = 1_800_000_000
const WEEK = 604_800
/** Past 2^53: a `number` anywhere between the chain and the response would round it. */
const SUPPLY = 2n ** 60n

const unused = <T extends object>(name: string) =>
  new Proxy({} as T, {
    get: (_, key) => () => {
      throw new Error(`${name} is not read on this path (${String(key)})`)
    },
  })

const terms = (over: Partial<ReserveTerms> = {}): ReserveTerms => ({
  issuerConfig: 'SysvarRent111111111111111111111111111111111',
  attestor: ATTESTOR,
  attestationMaxAge: WEEK,
  attestationCount: 3n,
  currency: 'NGN',
  feeBps: 12,
  latest: {
    index: 2n,
    amount: SUPPLY + 500n,
    currency: 'NGN',
    attestor: ATTESTOR,
    attestedAt: NOW - 3_600,
  },
  ...over,
})

const mintView: MintView = {
  mint: MINT,
  decimals: 6,
  supply: SUPPLY,
  paused: false,
  name: 'Naira Demo',
  symbol: 'vNGN',
}

type Fakes = { terms?: ReserveTerms; perMinute?: number; cacheMs?: number }

/** One server across requests, so the cache and the limit are what is observed. */
function app(fakes: Fakes = {}) {
  const clock = { ms: NOW * 1000 }
  const reads = { count: 0 }
  const compliance = {
    ...unused<ComplianceReader>('the compliance reader'),
    mint: async (mint: { toBase58(): string }) => (mint.toBase58() === MINT ? mintView : undefined),
  } satisfies ComplianceReader
  const server = createServer({
    logger: createLogger({ level: 'silent', service: 'test' }),
    webOrigins: ['https://console.example'],
    requestId: () => 'req-fixed',
    now: () => new Date(clock.ms),
    // A public read that touched the login would fail here, not pass quietly.
    privy: unused<PrivyClient>('the login'),
    directory: unused<Directory>('the directory'),
    chain: unused<ChainReader>('the chain reader'),
    reserve: {
      terms: async (mint) => {
        reads.count += 1
        return mint.toBase58() === MINT ? (fakes.terms ?? terms()) : undefined
      },
    },
    actions: unused<ActionReader>('the action reader'),
    compliance,
    delegations: unused<DelegationStore>('delegations'),
    issuance: unused<IssuanceStore>('issuance'),
    holders: unused<HolderStore>('the holder store'),
    journal: unused<JournalStore>('the journal'),
    operational: unused<OperationalSigner>('the operational key'),
    publicCacheMs: fakes.cacheMs ?? 5_000,
    publicPerMinute: fakes.perMinute ?? 120,
  })
  const get = (mint: string, from = '203.0.113.7') =>
    server.request(`/api/public/${mint}`, {
      headers: { 'x-forwarded-for': `${from}, 216.24.57.4` },
    })
  return { get, clock, reads, server }
}

describe('GET /api/public/:mint', () => {
  it('reads circulation, reserve, difference and the attestation’s age with no login', async () => {
    const { get } = app()
    const response = await get(MINT)
    expect(response.status).toBe(200)

    expect(publicTokenSchema.parse(await response.json())).toEqual({
      mint: MINT,
      name: 'Naira Demo',
      symbol: 'vNGN',
      decimals: 6,
      currency: 'NGN',
      circulation: SUPPLY.toString(),
      reserve: (SUPPLY + 500n).toString(),
      difference: '500',
      attestationMaxAge: WEEK,
      attestation: {
        index: '2',
        attestor: ATTESTOR,
        attestedAt: NOW - 3_600,
        expiresAt: NOW - 3_600 + WEEK,
        ageSeconds: 3_600,
      },
      expired: false,
      attestorReplaced: false,
      feeBps: 12,
      paused: false,
      asOf: NOW,
    })
  })

  /** FR-023a: the page tells the reasons apart, so the response must. */
  it('an expired attestation, an attestor since replaced and a short reserve are three separate facts', async () => {
    const { get } = app({
      terms: terms({
        latest: {
          index: 2n,
          amount: SUPPLY - 1n,
          currency: 'NGN',
          attestor: FORMER,
          attestedAt: NOW - WEEK - 1,
        },
      }),
    })
    const body = publicTokenSchema.parse(await (await get(MINT)).json())

    expect(body.expired).toBe(true)
    expect(body.attestorReplaced).toBe(true)
    expect(body.difference).toBe('-1')
  })

  it('no token at this mint is a 404, and a malformed one a 400', async () => {
    const { get } = app()
    expect((await get(UNKNOWN_MINT)).status).toBe(404)
    expect((await get('not-a-mint')).status).toBe(400)
  })
})

describe('GET /api/public/:mint — what it costs the node', () => {
  it('serves repeats from the cache, and reads again once it is stale', async () => {
    const { get, clock, reads } = app({ cacheMs: 5_000 })
    await get(MINT)
    clock.ms += 4_999
    const cached = publicTokenSchema.parse(await (await get(MINT)).json())
    expect(reads.count).toBe(1)
    // The moment of the read, not of the answer: the cache does not pretend.
    expect(cached.asOf).toBe(NOW)

    clock.ms += 1
    const fresh = publicTokenSchema.parse(await (await get(MINT)).json())
    expect(reads.count).toBe(2)
    expect(fresh.asOf).toBe(NOW + 5)
  })

  it('caches "no such token" too, so invented mints do not each cost a read', async () => {
    const { get, reads } = app()
    await get(UNKNOWN_MINT)
    expect((await get(UNKNOWN_MINT)).status).toBe(404)
    expect(reads.count).toBe(1)
  })

  it('limits one address and leaves the next alone', async () => {
    const { get } = app({ perMinute: 2 })
    expect((await get(MINT)).status).toBe(200)
    expect((await get(MINT)).status).toBe(200)

    const refused = await get(MINT)
    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).toBe('30')
    const error = (await refused.json()) as { error: { code: string } }
    expect(error.error.code).toBe('RATE_LIMITED')

    expect((await get(MINT, '198.51.100.9')).status).toBe(200)
  })
})

describe('the rest of /api', () => {
  it('still requires a login: mounting the public routes opened nothing else', async () => {
    const { server } = app()
    expect((await server.request('/api/session')).status).toBe(401)
    expect(
      (await server.request(`/api/tokens/${MINT}/attestations`, { method: 'POST' })).status,
    ).toBe(401)
  })
})
