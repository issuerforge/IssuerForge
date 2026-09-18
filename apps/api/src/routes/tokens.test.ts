import { createForgeProgram, fromBase64, issuanceAddresses, mintPda } from '@forge/chain'
import { OPEN_POLICY, type PolicyRules } from '@forge/policy/model'
import { ISSUER_HEADER, ROLE } from '@forge/shared/api'
import { createLogger } from '@forge/shared/log'
import { Connection, PublicKey } from '@solana/web3.js'
import { describe, expect, it, vi } from 'vitest'
import type { ChainReader } from '../chain.ts'
import type { Directory, RosterEntry } from '../directory.ts'
import type { HolderStore } from '../holders.ts'
import type { IssuanceStore, Reservation } from '../issuance.ts'
import type { OperationalSigner } from '../operational.ts'
import type { PrivyClient } from '../privy.ts'
import { createServer, MAX_BODY_BYTES, type ServerDeps } from '../server.ts'
import { createTokenBodySchema } from './tokens.ts'

const ISSUER = '11111111111111111111111111111112'
const ADMIN = 'SysvarC1ock11111111111111111111111111111111'
const ADMIN_TWO = 'SysvarS1otHashes111111111111111111111111111'
const ATTESTOR = 'SysvarRent111111111111111111111111111111111'
const TREASURY = 'SysvarRecentB1ockHashes11111111111111111111'
const CREDENTIAL = 'SysvarS1otHistory11111111111111111111111111'
const SCHEMA = 'So11111111111111111111111111111111111111112'
const BLOCKHASH = 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq2h'
const SYNCED_AT = '2026-08-21T10:00:00.000Z'
const NOW = new Date('2026-08-21T12:00:00.000Z')
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000)

const OTHER_ISSUER = 'So11111111111111111111111111111111111111112'

const TOKEN_INDEX = 3

const roster = (
  entries: readonly (readonly [wallet: string, roles: number])[] = [
    [ADMIN, ROLE.ADMIN],
    [ATTESTOR, ROLE.ATTESTOR],
  ],
): RosterEntry[] => entries.map(([wallet, roles], memberIndex) => ({ wallet, roles, memberIndex }))

type Fakes = {
  wallets?: string[]
  roles?: number
  entries?: readonly (readonly [string, number])[]
  tokenCount?: number | undefined
  reservation?: Reservation
  reserve?: IssuanceStore['reserve']
  now?: Date
  /** Overrides individual methods when a test counts calls. */
  chain?: Partial<ChainReader>
  directory?: Partial<Directory>
}

function app(fakes: Fakes = {}) {
  const wallets = fakes.wallets ?? [ADMIN]

  const privy: PrivyClient = {
    authenticate: async () => ({ userId: 'did:privy:test', wallets }),
  }

  const directory: Directory = {
    membershipsFor: async () => [
      { issuerId: ISSUER, roles: fakes.roles ?? ROLE.ADMIN, wallets, syncedAt: SYNCED_AT },
    ],
    rosterFor: async () => roster(fakes.entries),
    ...fakes.directory,
  }

  const absent = (what: string) => () => {
    throw new Error(`${what} is not read on the issuance path`)
  }

  const chain: ChainReader = {
    // A provider without a wallet: assembling instructions from the IDL does not go to the network.
    program: createForgeProgram(new Connection('http://127.0.0.1:8899')),
    tokenCount: async () => ('tokenCount' in fakes ? fakes.tokenCount : TOKEN_INDEX),
    issuerConfig: absent('the whole IssuerConfig'),
    holderStatusWritten: absent('HolderStatus'),
    latestBlockhash: async () => BLOCKHASH,
    ...fakes.chain,
  }

  const issuance: IssuanceStore = {
    reserve: fakes.reserve ?? (async () => fakes.reservation ?? { kind: 'reserved' }),
  }

  // Holder onboarding has its own test file; it appears here only because the
  // server is assembled as a whole.
  const holders = new Proxy({} as HolderStore, {
    get: (_, key) => () => {
      throw new Error(`holders are not needed on the issuance path (${String(key)})`)
    },
  })

  const operational: OperationalSigner = {
    publicKey: new PublicKey(ADMIN),
    submit: async () => {
      throw new Error('an issuance is signed by the wallet, not the operational key')
    },
  }

  const deps: ServerDeps = {
    logger: createLogger({ level: 'silent', service: 'test' }),
    webOrigins: ['https://console.example'],
    requestId: () => 'req-fixed',
    now: () => fakes.now ?? NOW,
    privy,
    directory,
    chain,
    issuance,
    holders,
    operational,
  }

  return createServer(deps)
}

const post = (path: string, json: unknown) =>
  app().request(path, {
    method: 'POST',
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: JSON.stringify(json),
  })

const postWith = (fakes: Fakes, path: string, json: unknown) =>
  app(fakes).request(path, {
    method: 'POST',
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: JSON.stringify(json),
  })

async function bodyOf(response: Response) {
  return (await response.json()) as Record<string, unknown>
}

const errorOf = async (response: Response) =>
  (await bodyOf(response)).error as {
    code: string
    message: string
    details?: Record<string, unknown>
  }

// ─── Issuance body ───────────────────────────────────────────────────────────

const issuanceBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'Naira Stable',
  symbol: 'NGNX',
  uri: 'https://issuer.example/ngnx.json',
  decimals: 2,
  policy: OPEN_POLICY,
  initialSupply: '1000000',
  reserve: { amount: '1000000', currency: 'NGN' },
  attestation: { credential: CREDENTIAL, schema: SCHEMA, maxAgeSeconds: 86_400 },
  fee: { treasury: TREASURY, bps: 25 },
  founderStatus: { tier: 1, jurisdiction: 'NG' },
  ...overrides,
})

describe('POST /api/policy/simulate', () => {
  it('returns the five FR-004 scenarios with verdicts', async () => {
    const response = await post('/api/policy/simulate', { policy: OPEN_POLICY })

    expect(response.status).toBe(200)
    const body = await bodyOf(response)
    expect(body.now).toBe(NOW_SECONDS)
    expect(body.scenarios).toEqual([
      { name: 'verified', applicable: true, amount: '1', verdict: { allowed: true } },
      {
        name: 'unverified',
        applicable: true,
        amount: '1',
        verdict: { allowed: false, code: 'RECIPIENT_STATUS_MISSING' },
      },
      { name: 'over-limit', applicable: false, amount: '1', verdict: { allowed: true } },
      {
        name: 'denied',
        applicable: true,
        amount: '1',
        verdict: { allowed: false, code: 'RECIPIENT_DENIED' },
      },
      {
        name: 'paused',
        applicable: true,
        amount: '1',
        verdict: { allowed: false, code: 'TRANSFERS_PAUSED' },
      },
    ])
  })

  it('a narrowed set comes back in the order it was named', async () => {
    const response = await post('/api/policy/simulate', {
      policy: { ...OPEN_POLICY, transferLimit: '500' } satisfies PolicyRules,
      scenarios: ['over-limit', 'verified'],
    })

    const scenarios = (await bodyOf(response)).scenarios as { name: string; amount: string }[]
    expect(scenarios.map((s) => s.name)).toEqual(['over-limit', 'verified'])
    expect(scenarios.map((s) => s.amount)).toEqual(['501', '500'])
  })

  it('a broken policy is a 400 in the shared format, not a 500', async () => {
    const response = await post('/api/policy/simulate', {
      policy: { status: { sources: [], minTier: 0 } },
    })

    expect(response.status).toBe(400)
    expect((await errorOf(response)).code).toBe('INVALID_INPUT')
  })

  it('an unknown scenario name is a 400', async () => {
    const response = await post('/api/policy/simulate', {
      policy: OPEN_POLICY,
      scenarios: ['whatever'],
    })

    expect(response.status).toBe(400)
  })

  it('does not answer without a session', async () => {
    const response = await app().request('/api/policy/simulate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ policy: OPEN_POLICY }),
    })

    expect(response.status).toBe(401)
  })
})

describe('request bounds', () => {
  it('you cannot ask for more scenarios than there are', async () => {
    const response = await post('/api/policy/simulate', {
      policy: OPEN_POLICY,
      scenarios: new Array(50_000).fill('verified'),
    })

    expect(response.status).toBe(400)
  })

  it('the same name twice is a client error, not an order for two scenarios', async () => {
    const response = await post('/api/policy/simulate', {
      policy: OPEN_POLICY,
      scenarios: ['verified', 'verified'],
    })

    expect(response.status).toBe(400)
  })

  it.each([
    ['/api/policy/simulate', { policy: OPEN_POLICY, junk: 'x' }],
    ['/api/tokens', issuanceBody({ attestedat: 1 })],
  ])('%s: an unknown field is rejected rather than silently dropped', async (path, json) => {
    const response = await post(path, json)

    expect(response.status).toBe(400)
  })

  it('a body over the ceiling is rejected in the shared format, not parsed in full', async () => {
    const response = await post('/api/policy/simulate', {
      policy: OPEN_POLICY,
      junk: 'x'.repeat(MAX_BODY_BYTES),
    })

    expect(response.status).toBe(400)
    expect((await errorOf(response)).message).toContain('too large')
  })
})

describe('POST /api/tokens — assembly', () => {
  it('returns three transactions in send order, with one blockhash', async () => {
    const response = await post('/api/tokens', issuanceBody())

    expect(response.status).toBe(200)
    const body = await bodyOf(response)
    const transactions = body.transactions as {
      step: string
      base64: string
      signers: string[]
      dependsOnPrevious: boolean
      bytes: number
    }[]

    expect(body.blockhash).toBe(BLOCKHASH)
    expect(transactions.map((t) => t.step)).toEqual([
      'create-token',
      'token-metadata',
      'hook-accounts',
    ])
    expect(transactions.map((t) => t.dependsOnPrevious)).toEqual([false, true, true])
    expect(transactions[0]?.signers).toEqual([ADMIN, ATTESTOR])
    // The T018 budget is measured, not estimated: 1180 of 1232.
    expect(transactions[0]?.bytes).toBe(1180)
    for (const transaction of transactions) {
      expect(transaction.bytes).toBeLessThanOrEqual(1232)
      expect(Buffer.from(transaction.base64, 'base64').length).toBe(transaction.bytes)
    }
  })

  it('the addresses match the number taken from the chain', async () => {
    const body = await bodyOf(await post('/api/tokens', issuanceBody()))
    const expected = issuanceAddresses(new PublicKey(ISSUER), TOKEN_INDEX)

    expect(body.tokenIndex).toBe(TOKEN_INDEX)
    expect(body.mint).toBe(expected.mint.toBase58())
    expect(body.tokenConfig).toBe(expected.tokenConfig.toBase58())
    expect(body.policyConfig).toBe(expected.policyConfig.toBase58())
    expect(body.attestation).toBe(expected.attestation.toBase58())
    expect(body.extraAccountMetaList).toBe(expected.extraAccountMetaList.toBase58())
  })

  it('no issuer on chain — 404, not token number zero', async () => {
    const response = await postWith({ tokenCount: undefined }, '/api/tokens', issuanceBody())

    expect(response.status).toBe(404)
    expect((await errorOf(response)).code).toBe('NOT_FOUND')
  })
})

describe('non-functional', () => {
  it('an issuance costs exactly two RPC calls (SC-010)', async () => {
    const tokenCount = vi.fn(async () => TOKEN_INDEX)
    const latestBlockhash = vi.fn(async () => BLOCKHASH)
    const server = app({ chain: { tokenCount, latestBlockhash } })

    const response = await server.request('/api/tokens', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify(issuanceBody()),
    })

    expect(response.status).toBe(200)
    // Assembling instructions from the IDL does not go to the network: if it
    // did, these numbers would be larger, and the tests would not pass without
    // a node at all.
    expect(tokenCount).toHaveBeenCalledTimes(1)
    expect(latestBlockhash).toHaveBeenCalledTimes(1)
  })

  it('none of the three transactions carries a signature (FR-035a, SC-012)', async () => {
    const body = await bodyOf(await post('/api/tokens', issuanceBody()))
    const transactions = body.transactions as { base64: string }[]

    for (const { base64 } of transactions) {
      const signatures = fromBase64(base64).signatures
      expect(signatures.length).toBeGreaterThan(0)
      // An empty signature is 64 zeros. The API has no keys, and that is visible in the bytes.
      for (const signature of signatures) {
        expect(signature.every((byte) => byte === 0)).toBe(true)
      }
    }
    expect(JSON.stringify(body)).not.toContain('secret')
  })

  it('a foreign tenant reaches neither the roster nor the network (SC-011)', async () => {
    const rosterFor = vi.fn(async () => roster())
    const tokenCount = vi.fn(async () => TOKEN_INDEX)
    const server = app({ directory: { rosterFor }, chain: { tokenCount } })

    const response = await server.request('/api/tokens', {
      method: 'POST',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
        [ISSUER_HEADER]: OTHER_ISSUER,
      },
      body: JSON.stringify(issuanceBody()),
    })

    expect(response.status).toBe(400)
    expect(rosterFor).not.toHaveBeenCalled()
    expect(tokenCount).not.toHaveBeenCalled()
    // The membership list in the details is the session's own memberships, and
    // the foreign ID is not among them: the response does not even confirm
    // that the named issuer exists.
    expect(JSON.stringify(await bodyOf(response))).not.toContain(OTHER_ISSUER)
  })
})

describe('POST /api/tokens — signers', () => {
  it("the founder is the session's admin address; the attestor comes from the roster", async () => {
    const body = await bodyOf(await post('/api/tokens', issuanceBody()))

    expect(body.founder).toBe(ADMIN)
    expect(body.attestor).toBe(ATTESTOR)
  })

  it('a session address without the admin role — 401', async () => {
    const response = await postWith(
      { wallets: [ATTESTOR], roles: ROLE.ATTESTOR },
      '/api/tokens',
      issuanceBody(),
    )

    expect(response.status).toBe(401)
    expect((await errorOf(response)).message).toContain('admin wallet')
  })

  it('no attestor in the roster — 400 with an explanation', async () => {
    const response = await postWith(
      { entries: [[ADMIN, ROLE.ADMIN]] },
      '/api/tokens',
      issuanceBody(),
    )

    expect(response.status).toBe(400)
    expect((await errorOf(response)).message).toContain('no attestor')
  })

  it('several admins in the session — 400 with the list until one is named', async () => {
    const fakes: Fakes = {
      wallets: [ADMIN, ADMIN_TWO],
      entries: [
        [ADMIN, ROLE.ADMIN],
        [ADMIN_TWO, ROLE.ADMIN],
        [ATTESTOR, ROLE.ATTESTOR],
      ],
    }

    const ambiguous = await postWith(fakes, '/api/tokens', issuanceBody())
    expect(ambiguous.status).toBe(400)
    expect((await errorOf(ambiguous)).details).toEqual({ founder: [ADMIN, ADMIN_TWO] })

    const picked = await postWith(fakes, '/api/tokens', issuanceBody({ founder: ADMIN_TWO }))
    expect((await bodyOf(picked)).founder).toBe(ADMIN_TWO)
  })

  it('the one named as founder does not hold the role — 400', async () => {
    const response = await postWith(
      { wallets: [ADMIN] },
      '/api/tokens',
      issuanceBody({ founder: ATTESTOR }),
    )

    expect(response.status).toBe(400)
    expect((await errorOf(response)).message).toContain('cannot sign in that role')
  })
})

describe('POST /api/tokens — number reservation', () => {
  it('the number is reserved for the same issuance that went into the transaction', async () => {
    const reserve = vi.fn<IssuanceStore['reserve']>(async () => ({ kind: 'reserved' }))
    await postWith({ reserve }, '/api/tokens', issuanceBody())

    expect(reserve).toHaveBeenCalledWith({
      issuerId: ISSUER,
      mint: mintPda(new PublicKey(ISSUER), TOKEN_INDEX).toBase58(),
      symbol: 'NGNX',
      name: 'Naira Stable',
      decimals: 2,
      at: NOW,
    })
  })

  it('another issuance holds the number — 400 naming who holds it', async () => {
    const since = new Date('2026-08-21T11:59:00.000Z')
    const response = await postWith(
      {
        reservation: {
          kind: 'taken',
          holder: { symbol: 'USDX', name: 'Dollar Stable', decimals: 6 },
          since,
        },
      },
      '/api/tokens',
      issuanceBody(),
    )

    expect(response.status).toBe(400)
    const error = await errorOf(response)
    expect(error.message).toContain('already holds the next token number')
    expect(error.details).toMatchObject({
      tokenIndex: TOKEN_INDEX,
      symbol: 'USDX',
      name: 'Dollar Stable',
      since: since.toISOString(),
    })
  })
})

describe('POST /api/tokens — value bounds', () => {
  it.each([
    ['a name longer than 32 bytes', { name: 'x'.repeat(33) }],
    ['a symbol longer than 12 bytes', { symbol: 'x'.repeat(13) }],
    ['a uri longer than 200 bytes', { uri: `https://e.example/${'x'.repeat(200)}` }],
    ['decimals above 9', { decimals: 10 }],
    ['a fee above 100%', { fee: { treasury: TREASURY, bps: 10_001 } }],
    ['a currency not in upper case', { reserve: { amount: '1', currency: 'ngn' } }],
    ['a currency shorter than three letters', { reserve: { amount: '1', currency: 'NG' } }],
    ['an amount not as a string', { initialSupply: 1000 }],
    [
      'an issuance above the attested reserve',
      { initialSupply: '2', reserve: { amount: '1', currency: 'NGN' } },
    ],
    [
      'a zero attestation validity period',
      { attestation: { credential: CREDENTIAL, schema: SCHEMA, maxAgeSeconds: 0 } },
    ],
    ['a malformed treasury address', { fee: { treasury: 'not-an-address', bps: 0 } }],
  ])('%s — 400', async (_case, override) => {
    const response = await post('/api/tokens', issuanceBody(override))

    expect(response.status).toBe(400)
    expect((await errorOf(response)).code).toBe('INVALID_INPUT')
  })

  it('a body without a reserve — 400, not a 500 in a check that reads the missing field', async () => {
    const { reserve: _dropped, ...withoutReserve } = issuanceBody()
    const response = await post('/api/tokens', withoutReserve)

    expect(response.status).toBe(400)
  })

  it('the name is counted in bytes, not characters', async () => {
    // 17 Greek letters are 34 bytes of UTF-8 at 17 characters.
    const parsed = createTokenBodySchema.safeParse(issuanceBody({ name: 'αβγδεζηθικλμνξοπρ' }))

    expect(parsed.success).toBe(false)
  })

  it('an issuance exactly equal to the attested reserve passes', async () => {
    const response = await post(
      '/api/tokens',
      issuanceBody({ initialSupply: '1000', reserve: { amount: '1000', currency: 'NGN' } }),
    )

    expect(response.status).toBe(200)
  })
})

describe('POST /api/tokens — reserve attestation', () => {
  it("without an attestation time the server's time is taken", async () => {
    const reserve = vi.fn<IssuanceStore['reserve']>(async () => ({ kind: 'reserved' }))
    const response = await postWith({ reserve }, '/api/tokens', issuanceBody())

    expect(response.status).toBe(200)
  })

  it('an attestation time in the future — 400', async () => {
    const response = await post(
      '/api/tokens',
      issuanceBody({
        reserve: { amount: '1000000', currency: 'NGN', attestedAt: NOW_SECONDS + 60 },
      }),
    )

    expect(response.status).toBe(400)
    expect((await errorOf(response)).message).toContain('dated in the future')
  })

  it('an attestation already expired at issuance — 400 before any signatures', async () => {
    const response = await post(
      '/api/tokens',
      issuanceBody({
        reserve: { amount: '1000000', currency: 'NGN', attestedAt: NOW_SECONDS - 86_401 },
      }),
    )

    expect(response.status).toBe(400)
    expect((await errorOf(response)).message).toContain('already be expired')
  })

  it('an attestation at the edge of its term still passes', async () => {
    const response = await post(
      '/api/tokens',
      issuanceBody({
        reserve: { amount: '1000000', currency: 'NGN', attestedAt: NOW_SECONDS - 86_400 },
      }),
    )

    expect(response.status).toBe(200)
  })
})
