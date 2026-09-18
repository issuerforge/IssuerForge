import { exportSPKI, generateKeyPair, type JWTPayload, SignJWT } from 'jose'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { ApiProblem } from './errors.ts'
import { createPrivyClient } from './privy.ts'

const APP_ID = 'app-id'
const DID = 'did:privy:cktest'
const EMBEDDED = '11111111111111111111111111111112'
const EXTERNAL = 'So11111111111111111111111111111111111111112'

let privateKey: CryptoKey
let verificationKey: string
let foreignKey: CryptoKey

beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true })
  privateKey = pair.privateKey
  verificationKey = await exportSPKI(pair.publicKey)
  foreignKey = (await generateKeyPair('ES256', { extractable: true })).privateKey
})

async function token(
  claims: JWTPayload = {},
  options: { key?: CryptoKey; issuer?: string; audience?: string; expires?: string } = {},
) {
  return new SignJWT({ sid: 'session-id', ...claims })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(options.issuer ?? 'privy.io')
    .setAudience(options.audience ?? APP_ID)
    .setSubject(claims.sub === undefined ? DID : String(claims.sub))
    .setIssuedAt()
    .setExpirationTime(options.expires ?? '1h')
    .sign(options.key ?? privateKey)
}

function userResponse(accounts: unknown[]) {
  return new Response(JSON.stringify({ id: DID, linked_accounts: accounts }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const solanaWallets = [
  { type: 'wallet', address: EMBEDDED, chain_type: 'solana', wallet_client_type: 'privy' },
  { type: 'wallet', address: EXTERNAL, chain_type: 'solana', wallet_client_type: 'phantom' },
]

function client(
  fetchImpl: typeof globalThis.fetch,
  options: { now?: () => number; cacheTtlMs?: number } = {},
) {
  return createPrivyClient({
    appId: APP_ID,
    appSecret: 'app-secret',
    verificationKey,
    apiUrl: 'https://auth.privy.io',
    fetch: fetchImpl,
    ...options,
  })
}

async function problem(promise: Promise<unknown>): Promise<ApiProblem> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ApiProblem) return error
    throw error
  }
  throw new Error('expected the call to reject')
}

describe('token verification', () => {
  it('returns the DID and the verified Solana addresses', async () => {
    const fetchImpl = vi.fn(async () => userResponse(solanaWallets))
    const user = await client(fetchImpl as unknown as typeof fetch).authenticate(await token())

    expect(user.userId).toBe(DID)
    expect(user.wallets).toEqual([EMBEDDED, EXTERNAL])
  })

  it("sends the app's Basic authorization and privy-app-id", async () => {
    const fetchImpl = vi.fn(async () => userResponse(solanaWallets))
    await client(fetchImpl as unknown as typeof fetch).authenticate(await token())

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`https://auth.privy.io/api/v1/users/${encodeURIComponent(DID)}`)
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from(`${APP_ID}:app-secret`).toString('base64')}`,
    )
    expect(headers['privy-app-id']).toBe(APP_ID)
  })

  it.each([
    ['a foreign signature', async () => token({}, { key: foreignKey })],
    ['a foreign token issuer', async () => token({}, { issuer: 'evil.example' })],
    ['a token of another app', async () => token({}, { audience: 'another-app' })],
    ['an expired token', async () => token({}, { expires: '-1h' })],
    ['not a token at all', async () => 'not-a-jwt'],
  ])('rejects %s', async (_name, make) => {
    const fetchImpl = vi.fn(async () => userResponse(solanaWallets))
    const error = await problem(
      client(fetchImpl as unknown as typeof fetch).authenticate(await make()),
    )

    expect(error.code).toBe('UNAUTHORIZED')
    // It never got as far as the login provider: the signature is checked locally.
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not name the reason for the refusal', async () => {
    const error = await problem(
      client(vi.fn() as unknown as typeof fetch).authenticate(await token({}, { expires: '-1h' })),
    )

    // "Expired" versus "foreign signature" is a hint to whoever is guessing tokens.
    expect(error.message).toBe('invalid or expired access token')
  })
})

describe('wallet set', () => {
  it('takes Solana addresses only, and wallets only', async () => {
    const fetchImpl = vi.fn(async () =>
      userResponse([
        { type: 'email', address: 'officer@example.com' },
        {
          type: 'wallet',
          address: '0x1234567890abcdef1234567890abcdef12345678',
          chain_type: 'ethereum',
        },
        { type: 'wallet', address: 'not-base58!!', chain_type: 'solana' },
        ...solanaWallets,
      ]),
    )
    const user = await client(fetchImpl as unknown as typeof fetch).authenticate(await token())

    expect(user.wallets).toEqual([EMBEDDED, EXTERNAL])
  })

  it('accepts an account with no Solana wallet at all', async () => {
    const fetchImpl = vi.fn(async () => userResponse([{ type: 'email', address: 'a@b.c' }]))
    const user = await client(fetchImpl as unknown as typeof fetch).authenticate(await token())

    // Not a login error: the person is logged in, they are just not in any issuer's membership.
    expect(user.wallets).toEqual([])
  })

  it('does not break on unknown fields in the response', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: DID,
            created_at: 1,
            some_new_field: { nested: true },
            linked_accounts: [{ ...solanaWallets[0], future_flag: 'x' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    const user = await client(fetchImpl as unknown as typeof fetch).authenticate(await token())

    expect(user.wallets).toEqual([EMBEDDED])
  })

  it('a 404 from Privy is a login refusal, not a failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 }))
    const error = await problem(
      client(fetchImpl as unknown as typeof fetch).authenticate(await token()),
    )

    expect(error.code).toBe('UNAUTHORIZED')
  })

  it.each([500, 502, 429])('%d from Privy is a failure, not a login refusal', async (status) => {
    const fetchImpl = vi.fn(async () => new Response('', { status }))
    const error = await problem(
      client(fetchImpl as unknown as typeof fetch).authenticate(await token()),
    )

    // Otherwise a provider failure would look to the console like "you were kicked out".
    expect(error.code).toBe('INTERNAL')
  })

  it('an unreachable network is a failure too', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const error = await problem(
      client(fetchImpl as unknown as typeof fetch).authenticate(await token()),
    )

    expect(error.code).toBe('INTERNAL')
  })
})

describe('wallet cache', () => {
  it('does not ask Privy again within the TTL', async () => {
    const fetchImpl = vi.fn(async () => userResponse(solanaWallets))
    let clock = 1_000
    const privy = client(fetchImpl as unknown as typeof fetch, {
      now: () => clock,
      cacheTtlMs: 60_000,
    })

    await privy.authenticate(await token())
    clock += 59_000
    await privy.authenticate(await token())

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('asks again after the TTL', async () => {
    const fetchImpl = vi.fn(async () => userResponse(solanaWallets))
    let clock = 1_000
    const privy = client(fetchImpl as unknown as typeof fetch, {
      now: () => clock,
      cacheTtlMs: 60_000,
    })

    await privy.authenticate(await token())
    clock += 60_001
    await privy.authenticate(await token())

    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not mix accounts', async () => {
    const other = 'did:privy:other'
    const fetchImpl = vi.fn(async (input: string | URL | Request) =>
      String(input).includes(encodeURIComponent(other))
        ? userResponse([solanaWallets[1]])
        : userResponse([solanaWallets[0]]),
    )
    const privy = client(fetchImpl as unknown as typeof fetch)

    expect((await privy.authenticate(await token())).wallets).toEqual([EMBEDDED])
    expect((await privy.authenticate(await token({ sub: other }))).wallets).toEqual([EXTERNAL])
  })
})
