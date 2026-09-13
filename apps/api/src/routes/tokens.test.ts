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
  /** Підміна окремих методів, коли тест рахує виклики. */
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
    throw new Error(`${what} на шляху випуску не читається`)
  }

  const chain: ChainReader = {
    // Провайдер без гаманця: збірка інструкцій за IDL у мережу не ходить.
    program: createForgeProgram(new Connection('http://127.0.0.1:8899')),
    tokenCount: async () => ('tokenCount' in fakes ? fakes.tokenCount : TOKEN_INDEX),
    issuerConfig: absent('IssuerConfig цілком'),
    holderStatusWritten: absent('HolderStatus'),
    latestBlockhash: async () => BLOCKHASH,
    ...fakes.chain,
  }

  const issuance: IssuanceStore = {
    reserve: fakes.reserve ?? (async () => fakes.reservation ?? { kind: 'reserved' }),
  }

  // Онбординг холдерів має власний файл тестів; сюди він потрапляє лише тому,
  // що сервер збирається цілком.
  const holders = new Proxy({} as HolderStore, {
    get: (_, key) => () => {
      throw new Error(`холдери на шляху випуску не потрібні (${String(key)})`)
    },
  })

  const operational: OperationalSigner = {
    publicKey: new PublicKey(ADMIN),
    submit: async () => {
      throw new Error('випуск підписує гаманець, а не операційний ключ')
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

// ─── Тіло випуску ────────────────────────────────────────────────────────────

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
  it("повертає п'ятірку сценаріїв FR-004 із вердиктами", async () => {
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

  it('звужений набір повертається в тому порядку, у якому названий', async () => {
    const response = await post('/api/policy/simulate', {
      policy: { ...OPEN_POLICY, transferLimit: '500' } satisfies PolicyRules,
      scenarios: ['over-limit', 'verified'],
    })

    const scenarios = (await bodyOf(response)).scenarios as { name: string; amount: string }[]
    expect(scenarios.map((s) => s.name)).toEqual(['over-limit', 'verified'])
    expect(scenarios.map((s) => s.amount)).toEqual(['501', '500'])
  })

  it('бита політика — 400 у спільному форматі, а не 500', async () => {
    const response = await post('/api/policy/simulate', {
      policy: { status: { sources: [], minTier: 0 } },
    })

    expect(response.status).toBe(400)
    expect((await errorOf(response)).code).toBe('INVALID_INPUT')
  })

  it("невідоме ім'я сценарію — 400", async () => {
    const response = await post('/api/policy/simulate', {
      policy: OPEN_POLICY,
      scenarios: ['whatever'],
    })

    expect(response.status).toBe(400)
  })

  it('без сесії не відповідає', async () => {
    const response = await app().request('/api/policy/simulate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ policy: OPEN_POLICY }),
    })

    expect(response.status).toBe(401)
  })
})

describe('межі запиту', () => {
  it('сценаріїв не можна попросити більше, ніж їх є', async () => {
    const response = await post('/api/policy/simulate', {
      policy: OPEN_POLICY,
      scenarios: new Array(50_000).fill('verified'),
    })

    expect(response.status).toBe(400)
  })

  it('та сама назва двічі — помилка клієнта, а не замовлення двох сценаріїв', async () => {
    const response = await post('/api/policy/simulate', {
      policy: OPEN_POLICY,
      scenarios: ['verified', 'verified'],
    })

    expect(response.status).toBe(400)
  })

  it.each([
    ['/api/policy/simulate', { policy: OPEN_POLICY, junk: 'x' }],
    ['/api/tokens', issuanceBody({ attestedat: 1 })],
  ])('%s: невідоме поле відхиляється, а не мовчки зникає', async (path, json) => {
    const response = await post(path, json)

    expect(response.status).toBe(400)
  })

  it('тіло понад стелю відхиляється у спільному форматі, а не розбирається цілком', async () => {
    const response = await post('/api/policy/simulate', {
      policy: OPEN_POLICY,
      junk: 'x'.repeat(MAX_BODY_BYTES),
    })

    expect(response.status).toBe(400)
    expect((await errorOf(response)).message).toContain('too large')
  })
})

describe('POST /api/tokens — збірка', () => {
  it('віддає три транзакції в порядку відправки, з одним blockhash', async () => {
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
    // Бюджет T018 виміряний, а не оцінений: 1180 із 1232.
    expect(transactions[0]?.bytes).toBe(1180)
    for (const transaction of transactions) {
      expect(transaction.bytes).toBeLessThanOrEqual(1232)
      expect(Buffer.from(transaction.base64, 'base64').length).toBe(transaction.bytes)
    }
  })

  it('адреси відповідають номеру, узятому з ланцюга', async () => {
    const body = await bodyOf(await post('/api/tokens', issuanceBody()))
    const expected = issuanceAddresses(new PublicKey(ISSUER), TOKEN_INDEX)

    expect(body.tokenIndex).toBe(TOKEN_INDEX)
    expect(body.mint).toBe(expected.mint.toBase58())
    expect(body.tokenConfig).toBe(expected.tokenConfig.toBase58())
    expect(body.policyConfig).toBe(expected.policyConfig.toBase58())
    expect(body.attestation).toBe(expected.attestation.toBase58())
    expect(body.extraAccountMetaList).toBe(expected.extraAccountMetaList.toBase58())
  })

  it('емітента немає в мережі — 404, а не нульовий номер', async () => {
    const response = await postWith({ tokenCount: undefined }, '/api/tokens', issuanceBody())

    expect(response.status).toBe(404)
    expect((await errorOf(response)).code).toBe('NOT_FOUND')
  })
})

describe('нефункціональне', () => {
  it('випуск коштує рівно два звертання до RPC (SC-010)', async () => {
    const tokenCount = vi.fn(async () => TOKEN_INDEX)
    const latestBlockhash = vi.fn(async () => BLOCKHASH)
    const server = app({ chain: { tokenCount, latestBlockhash } })

    const response = await server.request('/api/tokens', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify(issuanceBody()),
    })

    expect(response.status).toBe(200)
    // Збірка інструкцій за IDL у мережу не ходить: якби ходила, ці числа були б
    // більші, а тести взагалі не проходили б без ноди.
    expect(tokenCount).toHaveBeenCalledTimes(1)
    expect(latestBlockhash).toHaveBeenCalledTimes(1)
  })

  it('жодна з трьох транзакцій не має підпису (FR-035a, SC-012)', async () => {
    const body = await bodyOf(await post('/api/tokens', issuanceBody()))
    const transactions = body.transactions as { base64: string }[]

    for (const { base64 } of transactions) {
      const signatures = fromBase64(base64).signatures
      expect(signatures.length).toBeGreaterThan(0)
      // Порожній підпис — 64 нулі. Ключів у API немає, і це видно в байтах.
      for (const signature of signatures) {
        expect(signature.every((byte) => byte === 0)).toBe(true)
      }
    }
    expect(JSON.stringify(body)).not.toContain('secret')
  })

  it('чужий орендар не доходить ані до складу, ані до мережі (SC-011)', async () => {
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
    // Перелік членств у деталях — це власні членства сесії, і чужого ID серед
    // них немає: відповідь не підтверджує навіть існування названого емітента.
    expect(JSON.stringify(await bodyOf(response))).not.toContain(OTHER_ISSUER)
  })
})

describe('POST /api/tokens — підписанти', () => {
  it('засновник — адреса сесії з роллю адміністратора, атестатор — зі складу', async () => {
    const body = await bodyOf(await post('/api/tokens', issuanceBody()))

    expect(body.founder).toBe(ADMIN)
    expect(body.attestor).toBe(ATTESTOR)
  })

  it('адреса сесії без ролі адміністратора — 401', async () => {
    const response = await postWith(
      { wallets: [ATTESTOR], roles: ROLE.ATTESTOR },
      '/api/tokens',
      issuanceBody(),
    )

    expect(response.status).toBe(401)
    expect((await errorOf(response)).message).toContain('admin wallet')
  })

  it('у складі немає атестатора — 400 із поясненням', async () => {
    const response = await postWith(
      { entries: [[ADMIN, ROLE.ADMIN]] },
      '/api/tokens',
      issuanceBody(),
    )

    expect(response.status).toBe(400)
    expect((await errorOf(response)).message).toContain('no attestor')
  })

  it('кілька адміністраторів у сесії — 400 з переліком, доки один не названий', async () => {
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

  it('названий засновником не той, хто має роль, — 400', async () => {
    const response = await postWith(
      { wallets: [ADMIN] },
      '/api/tokens',
      issuanceBody({ founder: ATTESTOR }),
    )

    expect(response.status).toBe(400)
    expect((await errorOf(response)).message).toContain('cannot sign in that role')
  })
})

describe('POST /api/tokens — резервація номера', () => {
  it('номер резервується під той самий випуск, що поїхав у транзакції', async () => {
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

  it('номер тримає інший випуск — 400 із тим, хто його тримає', async () => {
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

describe('POST /api/tokens — межі значень', () => {
  it.each([
    ['назва довша за 32 байти', { name: 'x'.repeat(33) }],
    ['символ довший за 12 байтів', { symbol: 'x'.repeat(13) }],
    ['посилання довше за 200 байтів', { uri: `https://e.example/${'x'.repeat(200)}` }],
    ['точність понад 9', { decimals: 10 }],
    ['комісія понад 100%', { fee: { treasury: TREASURY, bps: 10_001 } }],
    ['валюта не з великих літер', { reserve: { amount: '1', currency: 'ngn' } }],
    ['валюта коротша за три літери', { reserve: { amount: '1', currency: 'NG' } }],
    ['сума не рядком', { initialSupply: 1000 }],
    [
      'емісія понад атестований резерв',
      { initialSupply: '2', reserve: { amount: '1', currency: 'NGN' } },
    ],
    [
      'строк чинності атестації нульовий',
      { attestation: { credential: CREDENTIAL, schema: SCHEMA, maxAgeSeconds: 0 } },
    ],
    ['чужа адреса скарбниці', { fee: { treasury: 'not-an-address', bps: 0 } }],
  ])('%s — 400', async (_case, override) => {
    const response = await post('/api/tokens', issuanceBody(override))

    expect(response.status).toBe(400)
    expect((await errorOf(response)).code).toBe('INVALID_INPUT')
  })

  it('тіло без резерву — 400, а не 500 на перевірці, яка читає відсутнє поле', async () => {
    const { reserve: _dropped, ...withoutReserve } = issuanceBody()
    const response = await post('/api/tokens', withoutReserve)

    expect(response.status).toBe(400)
  })

  it('назва рахується байтами, а не символами', async () => {
    // 17 кириличних літер — 34 байти UTF-8 при 17 символах.
    const parsed = createTokenBodySchema.safeParse(issuanceBody({ name: 'абвгдеєжзиійклмно' }))

    expect(parsed.success).toBe(false)
  })

  it('емісія рівно в атестований резерв проходить', async () => {
    const response = await post(
      '/api/tokens',
      issuanceBody({ initialSupply: '1000', reserve: { amount: '1000', currency: 'NGN' } }),
    )

    expect(response.status).toBe(200)
  })
})

describe('POST /api/tokens — атестація резерву', () => {
  it('без часу підтвердження береться час сервера', async () => {
    const reserve = vi.fn<IssuanceStore['reserve']>(async () => ({ kind: 'reserved' }))
    const response = await postWith({ reserve }, '/api/tokens', issuanceBody())

    expect(response.status).toBe(200)
  })

  it('час підтвердження з майбутнього — 400', async () => {
    const response = await post(
      '/api/tokens',
      issuanceBody({
        reserve: { amount: '1000000', currency: 'NGN', attestedAt: NOW_SECONDS + 60 },
      }),
    )

    expect(response.status).toBe(400)
    expect((await errorOf(response)).message).toContain('dated in the future')
  })

  it('атестація, протермінована вже на випуску, — 400 до підписів', async () => {
    const response = await post(
      '/api/tokens',
      issuanceBody({
        reserve: { amount: '1000000', currency: 'NGN', attestedAt: NOW_SECONDS - 86_401 },
      }),
    )

    expect(response.status).toBe(400)
    expect((await errorOf(response)).message).toContain('already be expired')
  })

  it('атестація на межі строку ще проходить', async () => {
    const response = await post(
      '/api/tokens',
      issuanceBody({
        reserve: { amount: '1000000', currency: 'NGN', attestedAt: NOW_SECONDS - 86_400 },
      }),
    )

    expect(response.status).toBe(200)
  })
})
