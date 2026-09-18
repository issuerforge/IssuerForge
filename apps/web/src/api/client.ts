// The api client: the only place where the console goes to the network.
//
// Three rules pinned down here:
//
// 1. **The token is fetched on every request**, not remembered. Privy
//    refreshes it itself, and a stored copy sooner or later expires exactly
//    when the officer clicks "sign".
// 2. **A response that does not match the schema is an error, not a blank
//    screen.** In a compliance product a field silently not drawn is worse
//    than the notice "the response did not match the contract": the former
//    looks like "zero".
// 3. **`X-Request-Id` is set by the client.** The api accepts it
//    (`server.ts`), so the number on the error screen and the log line are
//    one and the same number.

import { ISSUER_HEADER, REQUEST_ID_HEADER } from '@forge/shared/api'
import { apiErrorSchema, type ErrorCode } from '@forge/shared/errors'
import type { z } from 'zod'

export interface ApiClientDeps {
  /** Without a trailing slash — `readWebEnv` strips it. */
  baseUrl: string
  /** `getAccessToken` from Privy. `null` means "not logged in". */
  getAccessToken: () => Promise<string | null>
  /**
   * The chosen issuer when there are several memberships. A function, not a
   * value: the switcher in the header changes it between requests, and the
   * client must not be recreated for that.
   */
  issuerId?: () => string | undefined
  fetch?: typeof globalThis.fetch
  requestId?: () => string
}

/**
 * An api error as a value. Carries a code from the same list as the server,
 * so the screen decides by the code, not by the message text.
 */
export class ApiRequestError extends Error {
  readonly code: ErrorCode
  readonly requestId: string
  readonly details: Record<string, unknown> | undefined

  constructor(
    code: ErrorCode,
    message: string,
    requestId: string,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ApiRequestError'
    this.code = code
    this.requestId = requestId
    this.details = details
  }
}

export interface ApiClient {
  get<T>(path: string, schema: z.ZodType<T>): Promise<T>
  /**
   * The body is **not** validated here before sending.
   *
   * The request schema is known by whoever assembles it (the wizard takes it
   * from `@forge/api/contracts` — the same file as the server), and the
   * client stays a transport. A second check here would mean two places
   * deciding what a correct body is, and they would diverge silently.
   */
  post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T>
}

export function createApiClient(deps: ApiClientDeps): ApiClient {
  const doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis)
  const newRequestId = deps.requestId ?? (() => crypto.randomUUID())

  async function request<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    const requestId = newRequestId()

    // Login is checked before the network: the api would reject a request
    // without a token anyway, and this way "you are not logged in" is visible
    // instantly and without a stray line in the server logs.
    const token = await deps.getAccessToken()
    if (token === null) {
      throw new ApiRequestError('UNAUTHORIZED', 'not signed in', requestId)
    }

    const headers = new Headers({
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      [REQUEST_ID_HEADER]: requestId,
    })

    // The header is set only when an issuer is really chosen: the api reads an
    // empty value as "not named", and it is better not to send it at all.
    const issuerId = deps.issuerId?.()
    if (issuerId !== undefined && issuerId !== '') headers.set(ISSUER_HEADER, issuerId)
    if (body !== undefined) headers.set('content-type', 'application/json')

    let response: Response
    try {
      response = await doFetch(`${deps.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (cause) {
      // There is no network error in the list of codes: to the screen it is no
      // different from "the server did not answer", and that is `INTERNAL`.
      throw new ApiRequestError('INTERNAL', 'the console could not reach the api', requestId, {
        cause: String(cause),
      })
    }

    // Our own identifier is overridden by the one the server named: they
    // always match, except when the request never arrived and a proxy
    // answered.
    const echoed = response.headers.get(REQUEST_ID_HEADER) ?? requestId
    const payload: unknown = await response.json().catch(() => undefined)

    if (!response.ok) {
      const problem = apiErrorSchema.safeParse(payload)
      if (!problem.success) {
        throw new ApiRequestError('INTERNAL', `api answered ${response.status}`, echoed)
      }
      const { code, message, details } = problem.data.error
      throw new ApiRequestError(code, message, echoed, details)
    }

    const parsed = schema.safeParse(payload)
    if (!parsed.success) {
      throw new ApiRequestError('INTERNAL', 'api answered outside the contract', echoed, {
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      })
    }
    return parsed.data
  }

  return {
    get: (path, schema) => request('GET', path, schema),
    post: (path, body, schema) => request('POST', path, schema, body),
  }
}
