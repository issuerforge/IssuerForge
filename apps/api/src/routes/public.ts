// The public read of a token: circulation, reserve, their difference and the
// age of the latest attestation (FR-021, FR-023a, FR-025). No login — the
// holder and the regulator read it as they are.
//
// **Two guards, for two different costs.** Every answer is two RPC reads, and
// the node is metered. A short cache per mint bounds what the node pays no
// matter how many read: one pair of reads per mint per `cacheMs`. The limit
// per address bounds what a single caller can make the cache miss on, by
// asking for mints that do not exist — which is why "no such token" is cached
// too.
//
// Mounted **before** the session middleware in `server.ts`; that is the whole
// of "no login", so a route added to this file is public by being here.
import { addressSchema, fromU64 } from '@forge/shared/primitives'
import { PublicKey } from '@solana/web3.js'
import { Hono } from 'hono'
import type { ComplianceReader } from '../compliance.ts'
import type { PublicToken } from '../contracts/public.ts'
import type { AppEnv } from '../env.ts'
import { invalidInput, notFound } from '../errors.ts'
import { limitPerAddress } from '../ratelimit.ts'
import { type ReserveReader, reserveStanding } from '../reserve.ts'

/** Short enough that a page reload after an attestation lands shows it. */
export const PUBLIC_CACHE_MS = 5_000

/**
 * Per address. Generous on purpose: the transparency page renders on its own
 * server (T041), so every reader of the page arrives from one address.
 */
export const PUBLIC_PER_MINUTE = 120

/** Mints remembered at once; the keys come from callers, so the map has a ceiling. */
export const PUBLIC_CACHE_ENTRIES = 1_000

export interface PublicRouteDeps {
  reserve: ReserveReader
  compliance: ComplianceReader
  now: () => Date
  cacheMs?: number
  perMinute?: number
}

type Cached = { readonly at: number; readonly token: PublicToken | undefined }

export function createPublicRoutes(deps: PublicRouteDeps) {
  const app = new Hono<AppEnv>()
  const cacheMs = deps.cacheMs ?? PUBLIC_CACHE_MS
  const cache = new Map<string, Cached>()
  const clock = () => deps.now().getTime()

  const read = async (mint: string, at: number): Promise<PublicToken | undefined> => {
    const key = new PublicKey(mint)
    const [terms, view] = await Promise.all([deps.reserve.terms(key), deps.compliance.mint(key)])
    if (terms === undefined || view === undefined) return undefined

    const asOf = Math.floor(at / 1000)
    const standing = reserveStanding(terms, view.supply, asOf)
    return {
      mint,
      name: view.name,
      symbol: view.symbol,
      decimals: view.decimals,
      currency: terms.currency,
      circulation: fromU64(standing.circulation),
      reserve: fromU64(standing.reserve),
      difference: standing.difference.toString(),
      attestationMaxAge: terms.attestationMaxAge,
      attestation:
        standing.attestation === null
          ? null
          : { ...standing.attestation, index: fromU64(standing.attestation.index) },
      expired: standing.expired,
      attestorReplaced: standing.attestorReplaced,
      feeBps: terms.feeBps,
      paused: view.paused,
      asOf,
    }
  }

  const remember = (mint: string, entry: Cached) => {
    if (cache.size >= PUBLIC_CACHE_ENTRIES) {
      for (const [key, old] of cache) {
        if (entry.at - old.at >= cacheMs) cache.delete(key)
      }
      // Every entry still fresh: the oldest goes, and its next reader pays a read.
      const oldest = cache.keys().next()
      if (cache.size >= PUBLIC_CACHE_ENTRIES && !oldest.done) cache.delete(oldest.value)
    }
    cache.set(mint, entry)
  }

  app.use(
    '/public/*',
    limitPerAddress({ perMinute: deps.perMinute ?? PUBLIC_PER_MINUTE, now: clock }),
  )

  app.get('/public/:mint', async (c) => {
    const parsed = addressSchema.safeParse(c.req.param('mint'))
    if (!parsed.success) throw invalidInput('mint is not a base58 address')
    const mint = parsed.data

    const at = clock()
    let entry = cache.get(mint)
    if (entry === undefined || at - entry.at >= cacheMs) {
      entry = { at, token: await read(mint, at) }
      remember(mint, entry)
    }

    if (entry.token === undefined) throw notFound('no token at this mint')
    return c.json(entry.token)
  })

  return app
}
