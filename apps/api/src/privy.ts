// Console login: Privy token verification and the set of verified wallets
// (FR-034).
//
// Two steps, and they differ in nature:
//
// 1. **The token signature is verified locally** — ES256 against the public
//    key from the environment. There is no network here at all, so an
//    unavailable login provider does not make every request slow, and an
//    expired token is cut off cheaply.
// 2. **The wallet addresses have to be asked for.** A Privy token never has
//    them: the claims are `sub` (DID), `sid`, `iss`, `aud`, `iat`, `exp`. A
//    role, however, is bound to an address, not to the login account
//    (FR-034a), so without the DID → wallets step the session has nothing to
//    look up powers by.
//
// The client does not take the address from the request body as a matter of
// principle: a value the browser sends proves only that the browser can print
// it.
import { addressSchema } from '@forge/shared/primitives'
import { importSPKI, type JWTPayload, jwtVerify, type KeyObject } from 'jose'
import { z } from 'zod'
import { internal, unauthorized } from './errors.ts'

/** Privy signs access tokens with ES256 and nothing else. */
const ALGORITHM = 'ES256'
const ISSUER = 'privy.io'

/**
 * How long the set of wallets lives in the cache.
 *
 * A minute is the window in which a wallet unlinked in Privy still counts as
 * verified. It is deliberate: a wallet by itself allows nothing, because
 * powers are granted by a row in the issuer's membership, which is read from
 * the database **on every request** and is not cached. Without the cache,
 * every call to the console would be a request to a third-party service on
 * the response path.
 */
const CACHE_TTL_MS = 60_000

/** The cache ceiling: past it the earliest inserted entry is evicted. */
const CACHE_MAX_ENTRIES = 1_000

export interface PrivyUser {
  /** DID: `did:privy:...`. Carries no roles — it is a login identifier. */
  userId: string
  /** The account's verified Solana addresses: the embedded wallet and external ones. */
  wallets: string[]
}

export interface PrivyClient {
  authenticate(token: string): Promise<PrivyUser>
}

export interface PrivyClientOptions {
  appId: string
  appSecret: string
  /** PEM SPKI of the app's public key. */
  verificationKey: string
  apiUrl: string
  /** Swapped in tests — they have no network. */
  fetch?: typeof globalThis.fetch
  now?: () => number
  cacheTtlMs?: number
}

/**
 * The Privy response is read with `looseObject`: the service adds fields to
 * linked accounts between releases, and a strict schema would turn any new
 * field into a login refusal. We take exactly what we read and do not object
 * to the rest.
 */
const linkedAccountSchema = z.looseObject({
  type: z.string(),
  address: z.string().optional(),
  chain_type: z.string().optional(),
})

const privyUserSchema = z.looseObject({
  id: z.string().min(1),
  linked_accounts: z.array(linkedAccountSchema).default([]),
})

interface CacheEntry {
  wallets: string[]
  expiresAt: number
}

export function createPrivyClient(options: PrivyClientOptions): PrivyClient {
  const doFetch = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now
  const ttl = options.cacheTtlMs ?? CACHE_TTL_MS
  const cache = new Map<string, CacheEntry>()

  // The key is imported once and lazily: parsing the PEM costs noticeably more
  // than the signature check itself, and failing on a broken key is better at
  // the first login than at the start of a process that serves nothing yet.
  let keyPromise: Promise<CryptoKey | KeyObject> | undefined
  const key = () => {
    keyPromise ??= importSPKI(options.verificationKey, ALGORITHM)
    return keyPromise
  }

  const authorization = `Basic ${Buffer.from(`${options.appId}:${options.appSecret}`).toString('base64')}`

  async function verify(token: string): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(token, await key(), {
        issuer: ISSUER,
        audience: options.appId,
        algorithms: [ALGORITHM],
      })
      return payload
    } catch {
      // The reason for the refusal does not go out: "expired" versus "foreign
      // signature" is a hint to whoever is guessing tokens, and to nobody else.
      throw unauthorized('invalid or expired access token')
    }
  }

  async function fetchWallets(userId: string): Promise<string[]> {
    let response: Response
    try {
      response = await doFetch(`${options.apiUrl}/api/v1/users/${encodeURIComponent(userId)}`, {
        headers: {
          authorization,
          'privy-app-id': options.appId,
          accept: 'application/json',
        },
      })
    } catch (cause) {
      throw internal('login provider is unreachable', { cause: String(cause) })
    }

    // The token is signed by our app, but the user no longer exists — a login
    // that leads nowhere, not a server failure.
    if (response.status === 404) throw unauthorized('login account no longer exists')
    if (!response.ok) {
      throw internal('login provider returned an error', { status: response.status })
    }

    const parsed = privyUserSchema.safeParse(await response.json())
    if (!parsed.success) throw internal('login provider returned an unexpected payload')

    const wallets = parsed.data.linked_accounts
      .filter((a) => a.type === 'wallet' && a.chain_type === 'solana')
      .map((a) => a.address)
      // An address of another network or an empty string is not a provider
      // error here — an account legitimately holds wallets of several chains.
      // We care about those that can be in an issuer's membership at all.
      .filter((a): a is string => addressSchema.safeParse(a).success)

    return [...new Set(wallets)]
  }

  async function wallets(userId: string): Promise<string[]> {
    const cached = cache.get(userId)
    if (cached && cached.expiresAt > now()) return cached.wallets

    const fresh = await fetchWallets(userId)
    if (cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next()
      if (!oldest.done) cache.delete(oldest.value)
    }
    cache.set(userId, { wallets: fresh, expiresAt: now() + ttl })
    return fresh
  }

  return {
    async authenticate(token: string): Promise<PrivyUser> {
      const payload = await verify(token)
      const userId = payload.sub
      if (!userId) throw unauthorized('access token has no subject')
      return { userId, wallets: await wallets(userId) }
    },
  }
}
