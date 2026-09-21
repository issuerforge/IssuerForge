// The api client: the same thing the console does, only without a browser.
//
// **The `--api` path exists for the sake of one number.** Without it SC-001
// measures the on-chain half: three transactions assembled inside the demo
// process. In reality a person in the wizard walks a longer path — login,
// membership, simulation, reserving a number in the database, and only then
// signing. That is what has to be measured, because that is what the
// criterion says ("wizard → working token").
//
// The bodies and responses are described in `@forge/api/contracts` — the
// same file the server validates with. A second description here would
// diverge from the first exactly when the contract changes (T023 moved it
// out of the route for precisely this).
import type {
  CreateTokenBody,
  CreateTokenResponse,
  SimulatePolicyBody,
  SimulatePolicyResponse,
} from '@forge/api/contracts'
import { createTokenResponseSchema, simulatePolicyResponseSchema } from '@forge/api/contracts'
import { ISSUER_HEADER, type Session, sessionSchema } from '@forge/shared/api'

export interface ApiClientOptions {
  readonly baseUrl: string
  readonly accessToken: string
  /** The issuer. Needed only when there are several memberships, but always set. */
  readonly issuerId: string
}

/**
 * An api refusal is a separate type, not a string.
 *
 * The product's error code (`{ error: { code, message, details } }`) carries
 * more than the status: "another issuance holds the next number" and "no
 * attestor in the membership" are both 400, and in the report they must read
 * as different sentences.
 */
export class ApiRefused extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown

  constructor(status: number, code: string, message: string, details: unknown) {
    super(`api ${status} ${code}: ${message}`)
    this.name = 'ApiRefused'
    this.status = status
    this.code = code
    this.details = details
  }
}

export interface ApiClient {
  /** Who the api takes this login for. 401 until the indexer has mirrored the membership. */
  session(): Promise<Session>
  simulate(body: SimulatePolicyBody): Promise<SimulatePolicyResponse>
  createToken(body: CreateTokenBody): Promise<CreateTokenResponse>
  queueHolder(mint: string, body: QueueHolderBody): Promise<void>
  thawHolder(mint: string, wallet: string): Promise<ThawResult>
}

export interface QueueHolderBody {
  readonly wallet: string
  readonly tier: number
  readonly jurisdiction: string
  readonly expiresAt?: number | null
}

export interface ThawResult {
  /** `delegated` — the operational key signed; `member` — returned unsigned. */
  readonly mode: string
  readonly signature?: string | undefined
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  async function call<T>(
    method: string,
    path: string,
    body: unknown,
    parse: (value: unknown) => T,
  ): Promise<T> {
    const response = await fetch(`${options.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.accessToken}`,
        [ISSUER_HEADER]: options.issuerId,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

    const payload: unknown = await response.json().catch(() => undefined)

    if (!response.ok) {
      const error = errorOf(payload)
      throw new ApiRefused(response.status, error.code, error.message, error.details)
    }

    return parse(payload)
  }

  return {
    async session() {
      return await call('GET', '/api/session', undefined, (value) => sessionSchema.parse(value))
    },

    async simulate(body) {
      return await call('POST', '/api/policy/simulate', body, (value) =>
        simulatePolicyResponseSchema.parse(value),
      )
    },

    async createToken(body) {
      return await call('POST', '/api/tokens', body, (value) =>
        createTokenResponseSchema.parse(value),
      )
    },

    async queueHolder(mint, body) {
      await call('POST', `/api/tokens/${mint}/holders`, body, () => undefined)
    },

    async thawHolder(mint, wallet) {
      return await call('POST', `/api/tokens/${mint}/holders/${wallet}/thaw`, undefined, (value) =>
        thawResultOf(value),
      )
    },
  }
}

/**
 * Parses `{ error: { code, message, details } }` without failing on another
 * shape.
 *
 * A response that is not our error (a proxy, a gateway, an empty body) must
 * still yield a readable sentence: otherwise an infrastructure failure would
 * look like a program refusal — exactly the substitution T024 already
 * suffered from once.
 */
function errorOf(payload: unknown): { code: string; message: string; details: unknown } {
  if (typeof payload === 'object' && payload !== null && 'error' in payload) {
    const error = (payload as { error: unknown }).error
    if (typeof error === 'object' && error !== null) {
      const record = error as Record<string, unknown>
      return {
        code: typeof record.code === 'string' ? record.code : 'UNKNOWN',
        message: typeof record.message === 'string' ? record.message : 'no message',
        details: record.details,
      }
    }
  }
  return { code: 'UNKNOWN', message: 'the response carried no error object', details: payload }
}

function thawResultOf(payload: unknown): ThawResult {
  const record = (payload ?? {}) as Record<string, unknown>
  return {
    mode: typeof record.mode === 'string' ? record.mode : 'unknown',
    signature: typeof record.signature === 'string' ? record.signature : undefined,
  }
}
