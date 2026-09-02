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
import type { Directory } from './directory.ts'
import { unauthorized } from './errors.ts'
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

function app(
  memberships: Membership[],
  overrides: Partial<ServerDeps> & { user?: PrivyUser } = {},
) {
  const privy: PrivyClient = overrides.privy ?? {
    authenticate: async () => overrides.user ?? { userId: DID, wallets: [WALLET] },
  }
  const directory: Directory = overrides.directory ?? {
    membershipsFor: async () => memberships,
  }

  return createServer({
    logger: createLogger({ level: 'silent', service: 'test' }),
    webOrigins: ['https://console.example'],
    requestId: () => 'req-fixed',
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

describe('проба живості', () => {
  it('відповідає без автентифікації', async () => {
    const response = await app([]).request('/health')

    expect(response.status).toBe(200)
    expect(await bodyOf(response)).toEqual({ status: 'ok' })
  })
})

describe('вхід', () => {
  it('без заголовка — 401 у спільному форматі помилки', async () => {
    const response = await app([membership(ALPHA)]).request('/api/session')

    expect(response.status).toBe(401)
    const body = await bodyOf(response)
    expect(apiErrorSchema.safeParse(body).success).toBe(true)
    expect((body.error as { code: string }).code).toBe('UNAUTHORIZED')
  })

  it.each([
    ['Basic abc', 'чужа схема'],
    ['Bearer', 'схема без токена'],
    ['token-without-scheme', 'токен без схеми'],
  ])('%s (%s) — 401', async (header) => {
    const response = await app([membership(ALPHA)]).request('/api/session', {
      headers: { authorization: header },
    })

    expect(response.status).toBe(401)
  })

  it('приймає схему в будь-якому регістрі', async () => {
    const response = await app([membership(ALPHA)]).request('/api/session', {
      headers: { authorization: 'bearer token' },
    })

    expect(response.status).toBe(200)
  })

  it('токен дійсний, але адреса не у складі жодного емітента — 401', async () => {
    const response = await app([]).request('/api/session', authorized())

    expect(response.status).toBe(401)
    expect(((await bodyOf(response)).error as { message: string }).message).toContain(
      'not a member of any issuer',
    )
  })

  it('відмову Privy віддає як є', async () => {
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

describe('сесія', () => {
  it('єдине членство виводиться без заголовка', async () => {
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

  it('кілька членств без заголовка — 400 із переліком, а не мовчазний вибір', async () => {
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

  it('заголовок обирає серед доведених членств', async () => {
    const response = await app([membership(ALPHA), membership(BETA, ROLE.OBSERVER)]).request(
      '/api/session',
      authorized({ [ISSUER_HEADER]: BETA }),
    )

    const session = sessionSchema.parse(await response.json())
    expect(session.issuerId).toBe(BETA)
    expect(session.roles).toBe(ROLE.OBSERVER)
    // Перемикач орендарів у консолі малюється з цього переліку.
    expect(session.memberships.map((m) => m.issuerId)).toEqual([ALPHA, BETA])
  })

  // Заголовок звужує вибір серед уже доведених членств і не надає доступу.
  it('заголовок із чужим емітентом не пускає', async () => {
    const response = await app([membership(ALPHA)]).request(
      '/api/session',
      authorized({ [ISSUER_HEADER]: BETA }),
    )

    expect(response.status).toBe(400)
    const error = (await bodyOf(response)).error as { code: string }
    // NOT_FOUND сказав би, існує той емітент чи ні, — це відповідь про чужі дані.
    expect(error.code).toBe('INVALID_INPUT')
  })

  // FR-036: жоден параметр запиту не перекриває issuer_id сесії.
  it('параметр запиту не змінює орендаря', async () => {
    const response = await app([membership(ALPHA)]).request(
      `/api/session?issuerId=${BETA}&issuer_id=${BETA}`,
      authorized(),
    )

    expect(sessionSchema.parse(await response.json()).issuerId).toBe(ALPHA)
  })

  it('склад питається саме за підтвердженими адресами входу', async () => {
    const membershipsFor = vi.fn(async () => [membership(ALPHA)])
    const server = app([], {
      user: { userId: DID, wallets: [WALLET, BETA] },
      directory: { membershipsFor },
    })

    await server.request('/api/session', authorized())

    expect(membershipsFor).toHaveBeenCalledWith([WALLET, BETA])
  })
})

describe('помилки', () => {
  it('невідомий маршрут — 404 у спільному форматі', async () => {
    const response = await app([membership(ALPHA)]).request('/api/nope', authorized())

    expect(response.status).toBe(404)
    expect(((await bodyOf(response)).error as { code: string }).code).toBe('NOT_FOUND')
  })

  it('несподівана помилка не витікає назовні', async () => {
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
    // Текст драйвера містить рядок з'єднання з паролем.
    expect(JSON.stringify(body)).not.toContain('hunter2')
    const error = body.error as { code: string; message: string; details: { requestId: string } }
    expect(error.code).toBe('INTERNAL')
    expect(error.message).toBe('unexpected server error')
    expect(error.details.requestId).toBe('req-fixed')
  })
})

describe('наскрізний ідентифікатор запиту', () => {
  it('повертається в заголовку відповіді', async () => {
    const response = await app([membership(ALPHA)]).request('/health')

    expect(response.headers.get(REQUEST_ID_HEADER)).toBe('req-fixed')
  })

  it('свій ідентифікатор клієнта поважається', async () => {
    const response = await app([membership(ALPHA)]).request('/health', {
      headers: { [REQUEST_ID_HEADER]: 'from-console' },
    })

    expect(response.headers.get(REQUEST_ID_HEADER)).toBe('from-console')
  })
})

describe('CORS', () => {
  it('дозволене походження отримує свій же origin, а не зірку', async () => {
    const response = await app([membership(ALPHA)]).request('/api/session', {
      headers: { origin: 'https://console.example', ...authorized().headers },
    })

    // `*` неможливий: браузер не приймає його на відповідь із credentials.
    expect(response.headers.get('access-control-allow-origin')).toBe('https://console.example')
    expect(response.headers.get('access-control-allow-credentials')).toBe('true')
  })

  it('чуже походження дозволу не отримує', async () => {
    const response = await app([membership(ALPHA)]).request('/api/session', {
      headers: { origin: 'https://evil.example', ...authorized().headers },
    })

    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('передпольотний запит проходить без токена', async () => {
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
