import { createForgeProgram, fromBase64 } from '@forge/chain'
import { DELEGATION, ROLE } from '@forge/shared/api'
import { createLogger } from '@forge/shared/log'
import { Connection, Keypair } from '@solana/web3.js'
import { describe, expect, it, vi } from 'vitest'
import type { ChainReader, IssuerConfigView } from '../chain.ts'
import type { Directory, RosterEntry } from '../directory.ts'
import type { Enqueued, HolderRow, HolderState, HolderStore } from '../holders.ts'
import type { IssuanceStore } from '../issuance.ts'
import { type OperationalSigner, SubmitError } from '../operational.ts'
import type { PrivyClient } from '../privy.ts'
import { createServer, type ServerDeps } from '../server.ts'
import { MAX_BATCH_WALLETS } from './holders.ts'

const ISSUER = '11111111111111111111111111111112'
const ADMIN = 'SysvarC1ock11111111111111111111111111111111'
const OFFICER = 'SysvarS1otHashes111111111111111111111111111'
const WATCHER = 'SysvarRent111111111111111111111111111111111'
const MINT = 'So11111111111111111111111111111111111111112'
const HOLDER = 'SysvarRecentB1ockHashes11111111111111111111'
const HOLDER_TWO = 'SysvarS1otHistory11111111111111111111111111'
const BLOCKHASH = 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq2h'
const SIGNATURE = '5'.repeat(88)
const SYNCED_AT = '2026-08-21T10:00:00.000Z'
const NOW = new Date('2026-08-21T12:00:00.000Z')

const OPERATIONAL = Keypair.fromSeed(new Uint8Array(32).fill(11))
const OTHER_KEY = Keypair.fromSeed(new Uint8Array(32).fill(12))

const REQUESTED_AT = new Date('2026-08-21T09:00:00.000Z')

const row = (overrides: Partial<HolderRow> = {}): HolderRow => ({
  wallet: HOLDER,
  state: 'pending',
  tier: 2,
  jurisdiction: 'UA',
  denied: false,
  expiresAt: null,
  requestedAt: REQUESTED_AT,
  thawedAt: null,
  ...overrides,
})

const roster = (
  entries: readonly (readonly [wallet: string, roles: number])[] = [
    [ADMIN, ROLE.ADMIN],
    [OFFICER, ROLE.COMPLIANCE],
  ],
): RosterEntry[] => entries.map(([wallet, roles], memberIndex) => ({ wallet, roles, memberIndex }))

type Fakes = {
  wallets?: string[]
  roles?: number
  entries?: readonly (readonly [string, number])[]
  /** `undefined` — `IssuerConfig` у мережі немає. */
  config?: IssuerConfigView | undefined
  written?: boolean
  rows?: HolderRow[]
  ownsToken?: boolean
  submit?: OperationalSigner['submit']
  enqueue?: HolderStore['enqueue']
}

const delegated: IssuerConfigView = {
  tokenCount: 1,
  operationalKey: OPERATIONAL.publicKey.toBase58(),
  delegationMask: DELEGATION.THAW_HOLDER | DELEGATION.SET_HOLDER_STATUS,
}

function app(fakes: Fakes = {}) {
  const wallets = fakes.wallets ?? [ADMIN]
  const stored = new Map((fakes.rows ?? [row()]).map((entry) => [entry.wallet, entry]))

  const holders: HolderStore = {
    ownsToken: async (_issuerId, mint) => (fakes.ownsToken ?? true) && mint === MINT,
    list: vi.fn(async (_issuerId: string, _mint: string, state?: HolderState) =>
      [...stored.values()].filter((entry) => state === undefined || entry.state === state),
    ),
    get: async (_issuerId, _mint, wallet) => stored.get(wallet),
    enqueue:
      fakes.enqueue ??
      vi.fn(
        async (request): Promise<Enqueued> => ({
          kind: 'queued',
          row: row({
            wallet: request.wallet,
            tier: request.tier,
            jurisdiction: request.jurisdiction,
            expiresAt: request.expiresAt,
            requestedAt: request.at,
          }),
        }),
      ),
    markThawed: vi.fn(async () => {}),
    saveStatus: vi.fn(async () => {}),
  }

  const chain: ChainReader = {
    program: createForgeProgram(new Connection('http://127.0.0.1:8899')),
    tokenCount: async () => 1,
    issuerConfig: vi.fn(async () => ('config' in fakes ? fakes.config : delegated)),
    holderStatusWritten: async () => fakes.written ?? false,
    latestBlockhash: async () => BLOCKHASH,
  }

  const operational: OperationalSigner = {
    publicKey: OPERATIONAL.publicKey,
    submit: fakes.submit ?? vi.fn(async () => SIGNATURE),
  }

  const privy: PrivyClient = { authenticate: async () => ({ userId: 'did:privy:test', wallets }) }

  const directory: Directory = {
    membershipsFor: async () => [
      { issuerId: ISSUER, roles: fakes.roles ?? ROLE.ADMIN, wallets, syncedAt: SYNCED_AT },
    ],
    rosterFor: async () => roster(fakes.entries),
  }

  const issuance: IssuanceStore = {
    reserve: async () => {
      throw new Error('випуск у цих тестах не потрібен')
    },
  }

  const deps: ServerDeps = {
    logger: createLogger({ level: 'silent', service: 'test' }),
    webOrigins: ['https://console.example'],
    requestId: () => 'req-fixed',
    now: () => NOW,
    privy,
    directory,
    chain,
    issuance,
    holders,
    operational,
  }

  return { server: createServer(deps), holders, chain, operational }
}

const headers = { authorization: 'Bearer token', 'content-type': 'application/json' }

const call = (fakes: Fakes, path: string, init: RequestInit = {}) =>
  app(fakes).server.request(path, { headers, ...init })

const post = (fakes: Fakes, path: string, json?: unknown) =>
  call(fakes, path, { method: 'POST', body: JSON.stringify(json ?? {}) })

async function bodyOf(response: Response) {
  return (await response.json()) as Record<string, never>
}

const errorOf = async (response: Response) =>
  (await bodyOf(response)).error as unknown as { code: string; message: string; details?: unknown }

const thawPath = (wallet = HOLDER) => `/api/tokens/${MINT}/holders/${wallet}/thaw`

// ─── Черга ───────────────────────────────────────────────────────────────────

describe('the thaw queue', () => {
  it('enqueues a wallet together with the status assigned to it', async () => {
    const { server, holders } = app()

    const response = await server.request(`/api/tokens/${MINT}/holders`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ wallet: HOLDER, tier: 2, jurisdiction: 'UA' }),
    })

    expect(response.status).toBe(200)
    expect((await bodyOf(response)).holder).toMatchObject({
      wallet: HOLDER,
      state: 'pending',
      tier: 2,
      jurisdiction: 'UA',
      expiresAt: null,
      requestedAt: NOW.toISOString(),
      thawedAt: null,
    })
    expect(holders.enqueue).toHaveBeenCalledWith(expect.objectContaining({ issuerId: ISSUER }))
  })

  // Нуль у програмі означає «без строку» (T016), і рядок черги не має отримати
  // 1970 рік від клієнта, який просто повернув прочитане.
  it('a zero expiry is enqueued as "no expiry"', async () => {
    const { server, holders } = app()

    await server.request(`/api/tokens/${MINT}/holders`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ wallet: HOLDER, tier: 1, jurisdiction: 'UA', expiresAt: 0 }),
    })

    expect(holders.enqueue).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: null }))
  })

  it('an admitted account does not go back into the queue', async () => {
    const enqueue = vi.fn(
      async (): Promise<Enqueued> => ({ kind: 'settled', row: row({ state: 'thawed' }) }),
    )

    const response = await post({ enqueue }, `/api/tokens/${MINT}/holders`, {
      wallet: HOLDER,
      tier: 2,
      jurisdiction: 'UA',
    })

    expect(response.status).toBe(400)
    expect((await errorOf(response)).message).toContain('already onboarded')
  })

  it('returns the queue by state', async () => {
    const rows = [row(), row({ wallet: HOLDER_TWO, state: 'thawed', thawedAt: NOW })]
    const { server, holders } = app({ rows })

    const response = await server.request(`/api/tokens/${MINT}/holders?state=pending`, { headers })

    expect((await bodyOf(response)).holders).toHaveLength(1)
    expect(holders.list).toHaveBeenCalledWith(ISSUER, MINT, 'pending')
  })

  it('reads the queue without a filter', async () => {
    const { server, holders } = app({ rows: [row(), row({ wallet: HOLDER_TWO })] })

    const response = await server.request(`/api/tokens/${MINT}/holders`, { headers })

    expect((await bodyOf(response)).holders).toHaveLength(2)
    expect(holders.list).toHaveBeenCalledWith(ISSUER, MINT, undefined)
  })

  it('an unknown state in the filter is a request error, not an empty queue', async () => {
    const response = await call({}, `/api/tokens/${MINT}/holders?state=melted`)

    expect(response.status).toBe(400)
  })

  // Спостерігач має бачити чергу (FR-033) і не має її розгрібати.
  it('an observer can read the queue', async () => {
    const response = await call(
      { roles: ROLE.OBSERVER, wallets: [WATCHER] },
      `/api/tokens/${MINT}/holders`,
    )

    expect(response.status).toBe(200)
  })

  it('a foreign mint does not exist for this session', async () => {
    const response = await call({}, `/api/tokens/${ADMIN}/holders`)

    expect(response.status).toBe(404)
  })

  it('a typo in the address is a 400, not a 500', async () => {
    const response = await call({}, '/api/tokens/not-an-address/holders')

    expect(response.status).toBe(400)
    expect((await errorOf(response)).message).toContain('base58')
  })
})

// ─── Делегований шлях ────────────────────────────────────────────────────────

describe('thawing with the operational key', () => {
  it('signs itself and returns the signature', async () => {
    const { server, holders, operational } = app()

    const response = await server.request(thawPath(), { method: 'POST', headers })

    expect(response.status).toBe(200)
    expect(await bodyOf(response)).toMatchObject({
      mode: 'delegated',
      wallet: HOLDER,
      outcome: 'thawed',
      signature: SIGNATURE,
    })
    expect(operational.submit).toHaveBeenCalledTimes(1)
    // Дзеркало отримує той самий статус, який поїхав у ланцюг.
    expect(holders.markThawed).toHaveBeenCalledWith(
      expect.objectContaining({
        wallet: HOLDER,
        at: NOW,
        status: { tier: 2, jurisdiction: 'UA', denied: false, expiresAt: null },
      }),
    )
  })

  /**
   * Повторне розморожування (після заморозки офіцером) статусу не несе:
   * `thaw_holder` відхилив би `status: Some(..)` на заповненому записі.
   */
  it('a repeated thaw does not write the status a second time', async () => {
    const { server, holders } = app({ written: true })

    await server.request(thawPath(), { method: 'POST', headers })

    expect(holders.markThawed).toHaveBeenCalledWith(expect.objectContaining({ status: undefined }))
  })

  it('does not thaw a wallet that is not in the queue', async () => {
    const { server, holders } = app({ rows: [] })

    const response = await server.request(thawPath(), { method: 'POST', headers })

    expect(response.status).toBe(404)
    expect((await errorOf(response)).message).toContain('not in the thaw queue')
    expect(holders.markThawed).not.toHaveBeenCalled()
  })

  it('an observer admits nobody', async () => {
    const response = await post({ roles: ROLE.OBSERVER, wallets: [WATCHER] }, thawPath())

    expect(response.status).toBe(401)
  })

  /**
   * Відмова програми — відповідь про стан ланцюга, а не збій API: людині треба
   * показати саме її текст, а не «щось не вдалося».
   */
  it('shows a program refusal in words', async () => {
    const submit = vi.fn(async () => {
      throw new SubmitError('thaw-holder was refused', {
        code: 6033,
        name: 'powerNotDelegated',
        message: 'the operational key was not given this power',
      })
    })

    const response = await post({ submit }, thawPath())

    expect(response.status).toBe(400)
    expect(await errorOf(response)).toMatchObject({
      message: 'the operational key was not given this power',
      details: { program: { code: 6033, name: 'powerNotDelegated' } },
    })
  })

  it('a network failure stays an API failure', async () => {
    const submit = vi.fn(async () => {
      throw new SubmitError('thaw-holder was refused', undefined)
    })

    expect((await post({ submit }, thawPath())).status).toBe(500)
  })

  it('the mirror is not updated if the transaction did not go through', async () => {
    const submit = vi.fn(async () => {
      throw new SubmitError('thaw-holder was refused', undefined)
    })
    const { server, holders } = app({ submit })

    await server.request(thawPath(), { method: 'POST', headers })

    expect(holders.markThawed).not.toHaveBeenCalled()
  })
})

// ─── Шлях учасника складу ────────────────────────────────────────────────────

describe('thawing with a roster wallet', () => {
  const revoked: IssuerConfigView = { ...delegated, delegationMask: 0 }
  const foreign: IssuerConfigView = {
    ...delegated,
    operationalKey: OTHER_KEY.publicKey.toBase58(),
  }

  it.each([
    ['делегацію відкликано', revoked],
    ['операційний ключ емітента — чужий', foreign],
  ])('%s: віддає непідписану транзакцію', async (_name, config) => {
    const { server, holders, operational } = app({ config })

    const response = await server.request(thawPath(), { method: 'POST', headers })
    const body = await bodyOf(response)

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      mode: 'member',
      signer: ADMIN,
      blockhash: BLOCKHASH,
      wallet: HOLDER,
      outcome: 'unsigned',
    })
    expect(operational.submit).not.toHaveBeenCalled()
    // Нічого не підтверджено — отже, у черзі рахунок і лишається.
    expect(holders.markThawed).not.toHaveBeenCalled()

    const transaction = body.transaction as unknown as { base64: string; signers: string[] }
    expect(transaction.signers).toEqual([ADMIN])
    expect(fromBase64(transaction.base64).message.recentBlockhash).toBe(BLOCKHASH)
  })

  /**
   * Названий підписант вимикає делегацію: емітент сказав «підпишу сам». Читання
   * `IssuerConfig` при цьому зайве — і його не мусить бути.
   */
  it('a named signer disables delegation and does not read IssuerConfig', async () => {
    const { server, chain, operational } = app({
      wallets: [ADMIN, OFFICER],
      roles: ROLE.ADMIN | ROLE.COMPLIANCE,
    })

    const response = await server.request(`${thawPath()}?signer=${OFFICER}`, {
      method: 'POST',
      headers,
    })

    expect(await bodyOf(response)).toMatchObject({ mode: 'member', signer: OFFICER })
    expect(chain.issuerConfig).not.toHaveBeenCalled()
    expect(operational.submit).not.toHaveBeenCalled()
  })

  it('a wallet without the authorising right does not become a signer', async () => {
    const response = await post(
      {
        config: revoked,
        wallets: [ADMIN, WATCHER],
        entries: [
          [ADMIN, ROLE.ADMIN],
          [WATCHER, ROLE.OBSERVER],
        ],
      },
      `${thawPath()}?signer=${WATCHER}`,
    )

    expect(response.status).toBe(400)
  })

  // Делегації немає, і жоден гаманець сесії не стоїть у складі: сказати треба
  // обидві дороги — делегувати повноваження або ввійти адресою зі складу.
  it('no delegation and no roster address — 401 with an explanation', async () => {
    const response = await post(
      { config: revoked, entries: [[OFFICER, ROLE.COMPLIANCE]] },
      thawPath(),
    )

    expect(response.status).toBe(401)
    expect(await errorOf(response)).toMatchObject({
      message: expect.stringContaining('roster'),
      details: { power: 'THAW_HOLDER' },
    })
  })

  it('several authorising wallets and no choice — 400 with the list', async () => {
    const response = await post(
      {
        config: revoked,
        wallets: [ADMIN, OFFICER],
        roles: ROLE.ADMIN | ROLE.COMPLIANCE,
      },
      thawPath(),
    )

    expect(response.status).toBe(400)
    expect((await errorOf(response)).details).toEqual({ signer: [ADMIN, OFFICER] })
  })

  it('does not invent an issuer with no IssuerConfig on chain', async () => {
    const response = await post({ config: undefined }, thawPath())

    expect(response.status).toBe(404)
  })
})

// ─── Пачка ───────────────────────────────────────────────────────────────────

describe('a batch of thaws', () => {
  const batchPath = `/api/tokens/${MINT}/holders/thaw`

  it('reports on each wallet separately', async () => {
    const { server, operational } = app({ rows: [row()] })

    const response = await server.request(batchPath, {
      method: 'POST',
      headers,
      body: JSON.stringify({ wallets: [HOLDER, HOLDER_TWO] }),
    })

    // Один у черзі, другого немає: пачка не падає цілком і не мовчить про того,
    // хто не пройшов.
    expect(response.status).toBe(200)
    expect(await bodyOf(response)).toMatchObject({
      mode: 'delegated',
      results: [
        { wallet: HOLDER, outcome: 'thawed', signature: SIGNATURE },
        { wallet: HOLDER_TWO, outcome: 'failed', error: { code: 'NOT_FOUND' } },
      ],
    })
    expect(operational.submit).toHaveBeenCalledTimes(1)
  })

  it('the unsigned path gives everyone the same blockhash', async () => {
    const { server } = app({
      config: { ...delegated, delegationMask: 0 },
      rows: [row(), row({ wallet: HOLDER_TWO })],
    })

    const response = await server.request(batchPath, {
      method: 'POST',
      headers,
      body: JSON.stringify({ wallets: [HOLDER, HOLDER_TWO] }),
    })
    const body = await bodyOf(response)
    const results = body.results as unknown as { transaction: { base64: string } }[]

    expect(body).toMatchObject({ mode: 'member', blockhash: BLOCKHASH })
    for (const result of results) {
      expect(fromBase64(result.transaction.base64).message.recentBlockhash).toBe(BLOCKHASH)
    }
  })

  it('a duplicate in the list is a request error, not two report rows', async () => {
    const response = await post({}, batchPath, { wallets: [HOLDER, HOLDER] })

    expect(response.status).toBe(400)
  })

  it('a list longer than the limit is not accepted', async () => {
    const wallets = Array.from({ length: MAX_BATCH_WALLETS + 1 }, () =>
      Keypair.generate().publicKey.toBase58(),
    )

    expect((await post({}, batchPath, { wallets })).status).toBe(400)
  })

  it('an empty list is not accepted', async () => {
    expect((await post({}, batchPath, { wallets: [] })).status).toBe(400)
  })
})

// ─── Реєстр статусів ─────────────────────────────────────────────────────────

describe('updating the status register', () => {
  const statusPath = `/api/tokens/${MINT}/holders/${HOLDER}/status`
  const status = { tier: 1, jurisdiction: 'PL', denied: true, expiresAt: null }

  it('writes the status by delegation and mirrors it after confirmation', async () => {
    const { server, holders } = app({ written: true })

    const response = await server.request(statusPath, {
      method: 'POST',
      headers,
      body: JSON.stringify(status),
    })

    expect(await bodyOf(response)).toMatchObject({
      mode: 'delegated',
      wallet: HOLDER,
      outcome: 'updated',
      signature: SIGNATURE,
    })
    expect(holders.saveStatus).toHaveBeenCalledWith(
      expect.objectContaining({ wallet: HOLDER, status, at: NOW }),
    )
  })

  /**
   * `set_holder_status` акаунта не заводить (T016): без розморожування писати
   * нікуди, і сказати це треба реченням, а не кодом `AccountNotInitialized`.
   */
  it('does not update an account with no on-chain status record', async () => {
    const { server, holders } = app({ written: false })

    const response = await server.request(statusPath, {
      method: 'POST',
      headers,
      body: JSON.stringify(status),
    })

    expect(response.status).toBe(400)
    expect((await errorOf(response)).message).toContain('thaw it first')
    expect(holders.saveStatus).not.toHaveBeenCalled()
  })

  it('without delegation returns an unsigned transaction and leaves the mirror alone', async () => {
    const { server, holders } = app({
      written: true,
      config: { ...delegated, delegationMask: DELEGATION.THAW_HOLDER },
    })

    const response = await server.request(statusPath, {
      method: 'POST',
      headers,
      body: JSON.stringify(status),
    })

    expect(await bodyOf(response)).toMatchObject({ mode: 'member', outcome: 'unsigned' })
    expect(holders.saveStatus).not.toHaveBeenCalled()
  })

  // Заборона — найсуворіше, що вміє реєстр (FR-008a1): пропущене поле не має
  // читатися як «зняти».
  it('requires an explicit denial, not a silent "no"', async () => {
    const response = await post({ written: true }, statusPath, {
      tier: 1,
      jurisdiction: 'PL',
    })

    expect(response.status).toBe(400)
  })

  it.each([
    ['юрисдикція не alpha-2', { ...status, jurisdiction: 'Ukraine' }],
    ['рівень поза байтом', { ...status, tier: 300 }],
    ['зайве поле', { ...status, source: 'provider' }],
  ])('%s — 400', async (_name, body) => {
    expect((await post({ written: true }, statusPath, body)).status).toBe(400)
  })
})
