import {
  ISSUER_HEADER,
  type Membership,
  REQUEST_ID_HEADER,
  ROLE,
  sessionSchema,
} from '@forge/shared/api'
import { apiErrorSchema } from '@forge/shared/errors'
import { createLogger } from '@forge/shared/log'
import { describe, expect, it, vi } from 'vitest'
import type { ChainReader } from './chain.ts'
import type { Directory } from './directory.ts'
import { unauthorized } from './errors.ts'
import type { HolderStore } from './holders.ts'
import type { IssuanceStore } from './issuance.ts'
import type { JournalStore } from './journal.ts'
import type { OperationalSigner } from './operational.ts'
import type { PrivyClient, PrivyUser } from './privy.ts'
import { createServer, type ServerDeps } from './server.ts'

const ALPHA = '11111111111111111111111111111112'
const BETA = 'So11111111111111111111111111111111111111112'
const WALLET = 'SysvarC1ock11111111111111111111111111111111'
const DID = 'did:privy:cktest'
const SYNCED_AT = '2026-08-21T10:00:00.000Z'

const membership = (issuerId: string, roles = ROLE.ADMIN): Membership => ({
  issuerId,
  roles,
  wallets: [WALLET],
  syncedAt: SYNCED_AT,
})

/**
 * Stubs of everything that goes outside. These tests check login and the
 * error format, so there is no network and no reservation here: the issuance
 * routes have their own file.
 */
const unreachable = (what: string) => () => {
  throw new Error(`${what} is not needed in these tests`)
}

const chain: ChainReader = {
  program: undefined as unknown as ChainReader['program'],
  tokenCount: async () => undefined,
  issuerConfig: unreachable('reading IssuerConfig'),
  holderStatusWritten: unreachable('reading HolderStatus'),
  latestBlockhash: unreachable('the network'),
}

const holders: HolderStore = {
  ownsToken: unreachable('the holder database'),
  list: unreachable('the holder database'),
  get: unreachable('the holder database'),
  enqueue: unreachable('the holder database'),
  markThawed: unreachable('the holder database'),
  saveStatus: unreachable('the holder database'),
}

const journal: JournalStore = {
  frontier: unreachable('the journal'),
  bracket: unreachable('the journal'),
  count: unreachable('the journal'),
  page: unreachable('the journal'),
  tail: unreachable('the journal'),
}

/** No key is needed here: none of these tests gets as far as signing. */
const operational: OperationalSigner = {
  publicKey: undefined as unknown as OperationalSigner['publicKey'],
  submit: unreachable('signing with the operational key'),
}

const issuance: IssuanceStore = {
  reserve: async () => {
    throw new Error('a reservation is not needed in these tests')
  },
}

function app(
  memberships: Membership[],
  overrides: Partial<Omit<ServerDeps, 'directory'>> & {
    user?: PrivyUser
    directory?: Partial<Directory>
  } = {},
) {
  const privy: PrivyClient = overrides.privy ?? {
    authenticate: async () => overrides.user ?? { userId: DID, wallets: [WALLET] },
  }
  const directory: Directory = {
    membershipsFor: async () => memberships,
    rosterFor: async () => [],
    ...overrides.directory,
  }

  return createServer({
    logger: createLogger({ level: 'silent', service: 'test' }),
    webOrigins: ['https://console.example'],
    requestId: () => 'req-fixed',
    chain,
    issuance,
    holders,
    journal,
    operational,
    ...overrides,
    privy,
    directory,
  })
}

const authorized = (headers: Record<string, string> = {}) => ({
  headers: { authorization: 'Bearer token', ...headers },
})

async function bodyOf(response: Response) {
  return (await response.json()) as Record<string, unknown>
}

describe('liveness probe', () => {
  it('answers without authentication', async () => {
    const response = await app([]).request('/health')

    expect(response.status).toBe(200)
    expect(await bodyOf(response)).toEqual({ status: 'ok' })
  })
})

describe('login', () => {
  it('no header — 401 in the shared error format', async () => {
    const response = await app([membership(ALPHA)]).request('/api/session')

    expect(response.status).toBe(401)
    const body = await bodyOf(response)
    expect(apiErrorSchema.safeParse(body).success).toBe(true)
    expect((body.error as { code: string }).code).toBe('UNAUTHORIZED')
  })

  it.each([
    ['Basic abc', 'a foreign scheme'],
    ['Bearer', 'a scheme without a token'],
    ['token-without-scheme', 'a token without a scheme'],
  ])('%s (%s) — 401', async (header) => {
    const response = await app([membership(ALPHA)]).request('/api/session', {
      headers: { authorization: header },
    })

    expect(response.status).toBe(401)
  })

  it('accepts the scheme in any case', async () => {
    const response = await app([membership(ALPHA)]).request('/api/session', {
      headers: { authorization: 'bearer token' },
    })

    expect(response.status).toBe(200)
  })

  it("a valid token whose address is in no issuer's roster — 401", async () => {
    const response = await app([]).request('/api/session', authorized())

    expect(response.status).toBe(401)
    expect(((await bodyOf(response)).error as { message: string }).message).toContain(
      'not a member of any issuer',
    )
  })

  it('passes a Privy refusal through as is', async () => {
    const server = app([membership(ALPHA)], {
      privy: {
        authenticate: async () => {
          throw unauthorized('invalid or expired access token')
        },
      },
    })
    const response = await server.request('/api/session', authorized())

    expect(response.status).toBe(401)
  })
})

describe('session', () => {
  it('a single membership is derived without the header', async () => {
    const response = await app([membership(ALPHA, ROLE.ADMIN | ROLE.COMPLIANCE)]).request(
      '/api/session',
      authorized(),
    )

    expect(response.status).toBe(200)
    const session = sessionSchema.parse(await response.json())
    expect(session.issuerId).toBe(ALPHA)
    expect(session.roles).toBe(ROLE.ADMIN | ROLE.COMPLIANCE)
    expect(session.userId).toBe(DID)
    expect(session.wallets).toEqual([WALLET])
    expect(session.memberships).toHaveLength(1)
  })

  it('several memberships without the header — 400 with the list, not a silent choice', async () => {
    const response = await app([membership(ALPHA), membership(BETA)]).request(
      '/api/session',
      authorized(),
    )

    expect(response.status).toBe(400)
    const body = await bodyOf(response)
    const error = body.error as { code: string; details: { issuerIds: string[] } }
    expect(error.code).toBe('INVALID_INPUT')
    expect(error.details.issuerIds).toEqual([ALPHA, BETA])
  })

  it('the header chooses among proven memberships', async () => {
    const response = await app([membership(ALPHA), membership(BETA, ROLE.OBSERVER)]).request(
      '/api/session',
      authorized({ [ISSUER_HEADER]: BETA }),
    )

    const session = sessionSchema.parse(await response.json())
    expect(session.issuerId).toBe(BETA)
    expect(session.roles).toBe(ROLE.OBSERVER)
    // The tenant switcher in the console is drawn from this list.
    expect(session.memberships.map((m) => m.issuerId)).toEqual([ALPHA, BETA])
  })

  // The header narrows the choice among memberships already proven and grants no access.
  it('a header naming a foreign issuer does not get in', async () => {
    const response = await app([membership(ALPHA)]).request(
      '/api/session',
      authorized({ [ISSUER_HEADER]: BETA }),
    )

    expect(response.status).toBe(400)
    const error = (await bodyOf(response)).error as { code: string }
    // NOT_FOUND would say whether that issuer exists — an answer about someone else's data.
    expect(error.code).toBe('INVALID_INPUT')
  })

  // FR-036: no request parameter overrides the session's issuer_id.
  it('a query parameter does not change the tenant', async () => {
    const response = await app([membership(ALPHA)]).request(
      `/api/session?issuerId=${BETA}&issuer_id=${BETA}`,
      authorized(),
    )

    expect(sessionSchema.parse(await response.json()).issuerId).toBe(ALPHA)
  })

  it('the roster is queried for the verified login addresses specifically', async () => {
    const membershipsFor = vi.fn(async () => [membership(ALPHA)])
    const server = app([], {
      user: { userId: DID, wallets: [WALLET, BETA] },
      directory: { membershipsFor },
    })

    await server.request('/api/session', authorized())

    expect(membershipsFor).toHaveBeenCalledWith([WALLET, BETA])
  })
})

describe('errors', () => {
  it('an unknown route — 404 in the shared format', async () => {
    const response = await app([membership(ALPHA)]).request('/api/nope', authorized())

    expect(response.status).toBe(404)
    expect(((await bodyOf(response)).error as { code: string }).code).toBe('NOT_FOUND')
  })

  it('an unexpected error does not leak outside', async () => {
    const server = app([], {
      directory: {
        membershipsFor: async () => {
          throw new Error('connect ECONNREFUSED postgres://user:hunter2@host:6543/db')
        },
      },
    })
    const response = await server.request('/api/session', authorized())

    expect(response.status).toBe(500)
    const body = await bodyOf(response)
    // The driver's text contains the connection string with the password.
    expect(JSON.stringify(body)).not.toContain('hunter2')
    const error = body.error as { code: string; message: string; details: { requestId: string } }
    expect(error.code).toBe('INTERNAL')
    expect(error.message).toBe('unexpected server error')
    expect(error.details.requestId).toBe('req-fixed')
  })
})

describe('end-to-end request id', () => {
  it('comes back in the response header', async () => {
    const response = await app([membership(ALPHA)]).request('/health')

    expect(response.headers.get(REQUEST_ID_HEADER)).toBe('req-fixed')
  })

  it("the client's own id is respected", async () => {
    const response = await app([membership(ALPHA)]).request('/health', {
      headers: { [REQUEST_ID_HEADER]: 'from-console' },
    })

    expect(response.headers.get(REQUEST_ID_HEADER)).toBe('from-console')
  })
})

describe('CORS', () => {
  it('an allowed origin gets its own origin back, not a star', async () => {
    const response = await app([membership(ALPHA)]).request('/api/session', {
      headers: { origin: 'https://console.example', ...authorized().headers },
    })

    // `*` is impossible: the browser does not accept it on a response with credentials.
    expect(response.headers.get('access-control-allow-origin')).toBe('https://console.example')
    expect(response.headers.get('access-control-allow-credentials')).toBe('true')
  })

  it('a foreign origin gets no allowance', async () => {
    const response = await app([membership(ALPHA)]).request('/api/session', {
      headers: { origin: 'https://evil.example', ...authorized().headers },
    })

    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('a preflight request passes without a token', async () => {
    const response = await app([membership(ALPHA)]).request('/api/session', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://console.example',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization,x-issuer-id',
      },
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-headers')).toContain('x-issuer-id')
  })
})
