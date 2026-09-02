import { ISSUER_HEADER, REQUEST_ID_HEADER } from '@forge/shared/api'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ApiRequestError, createApiClient } from './client'

const body = z.object({ ok: z.boolean() })

const json = (value: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })

interface Call {
  url: string
  headers: Headers
}

function harness(responder: () => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) })
    return responder()
  })
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch }
}

const client = (
  overrides: Partial<Parameters<typeof createApiClient>[0]> & { fetch: typeof globalThis.fetch },
) =>
  createApiClient({
    baseUrl: 'http://api.test',
    getAccessToken: async () => 'jwt-token',
    requestId: () => 'req-1',
    ...overrides,
  })

describe('createApiClient', () => {
  it('sends the bearer token and its own request id', async () => {
    const { calls, fetch } = harness(() => json({ ok: true }))
    await client({ fetch }).get('/api/session', body)

    expect(calls[0]?.url).toBe('http://api.test/api/session')
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer jwt-token')
    expect(calls[0]?.headers.get(REQUEST_ID_HEADER)).toBe('req-1')
  })

  it('sends the issuer header only when a tenant is chosen', async () => {
    const chosen = harness(() => json({ ok: true }))
    await client({ fetch: chosen.fetch, issuerId: () => 'Iss1' }).get('/api/session', body)
    expect(chosen.calls[0]?.headers.get(ISSUER_HEADER)).toBe('Iss1')

    const unchosen = harness(() => json({ ok: true }))
    await client({ fetch: unchosen.fetch, issuerId: () => undefined }).get('/api/session', body)
    expect(unchosen.calls[0]?.headers.has(ISSUER_HEADER)).toBe(false)
  })

  it('reads the tenant at request time, not at construction', async () => {
    const { calls, fetch } = harness(() => json({ ok: true }))
    let issuerId = 'Iss1'
    const api = client({ fetch, issuerId: () => issuerId })

    await api.get('/api/session', body)
    issuerId = 'Iss2'
    await api.get('/api/session', body)

    expect(calls.map((c) => c.headers.get(ISSUER_HEADER))).toEqual(['Iss1', 'Iss2'])
  })

  it('refuses without a token and does not reach the network', async () => {
    const { calls, fetch } = harness(() => json({ ok: true }))
    const api = client({ fetch, getAccessToken: async () => null })

    await expect(api.get('/api/session', body)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      requestId: 'req-1',
    })
    expect(calls).toHaveLength(0)
  })

  it('carries the code, message and details of an api error', async () => {
    const { fetch } = harness(() =>
      json(
        {
          error: {
            code: 'INVALID_INPUT',
            message: 'pick one with x-issuer-id',
            details: { issuerIds: ['Iss1', 'Iss2'] },
          },
        },
        { status: 400 },
      ),
    )

    const error = await client({ fetch })
      .get('/api/session', body)
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ApiRequestError)
    expect(error).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'pick one with x-issuer-id',
      details: { issuerIds: ['Iss1', 'Iss2'] },
    })
  })

  it('prefers the request id the server echoed back', async () => {
    const { fetch } = harness(
      () =>
        new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'boom' } }), {
          status: 500,
          headers: { 'content-type': 'application/json', [REQUEST_ID_HEADER]: 'req-server' },
        }),
    )

    await expect(client({ fetch }).get('/api/session', body)).rejects.toMatchObject({
      requestId: 'req-server',
    })
  })

  it('turns a failure body it cannot read into INTERNAL, not a crash', async () => {
    const { fetch } = harness(() => new Response('<html>502</html>', { status: 502 }))

    await expect(client({ fetch }).get('/api/session', body)).rejects.toMatchObject({
      code: 'INTERNAL',
      message: 'api answered 502',
    })
  })

  // Мовчазне «поле не намалювалось» у комплаєнс-продукті читається як нуль,
  // тож відповідь поза контрактом мусить бути гучною.
  it('rejects a successful answer that does not match the contract', async () => {
    const { fetch } = harness(() => json({ ok: 'yes' }))

    await expect(client({ fetch }).get('/api/session', body)).rejects.toMatchObject({
      code: 'INTERNAL',
      message: 'api answered outside the contract',
    })
  })

  it('turns a dead network into INTERNAL with the cause attached', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof globalThis.fetch

    const error = await client({ fetch })
      .get('/api/session', body)
      .catch((e: unknown) => e)

    expect(error).toMatchObject({ code: 'INTERNAL' })
    expect((error as ApiRequestError).details?.cause).toContain('Failed to fetch')
  })
})
