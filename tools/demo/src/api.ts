// Клієнт api: те саме, що робить консоль, тільки без браузера.
//
// **Шлях `--api` існує заради одного числа.** Без нього SC-001 міряє
// ончейн-половину: три транзакції, зібрані в процесі демо. Насправді ж людина
// в майстрі проходить довший шлях — вхід, склад, симуляція, резервація номера
// в базі, і аж потім підпис. Саме його й треба міряти, бо саме він стоїть у
// критерії («майстер → працюючий токен»).
//
// Тіла й відповіді описані в `@forge/api/contracts` — тому ж файлі, який
// валідує сервер. Другий опис тут розійшовся б із першим рівно тоді, коли
// контракт зміниться (T023 виніс його з маршруту саме для цього).
import type {
  CreateTokenBody,
  CreateTokenResponse,
  SimulatePolicyBody,
  SimulatePolicyResponse,
} from '@forge/api/contracts'
import { createTokenResponseSchema, simulatePolicyResponseSchema } from '@forge/api/contracts'
import { ISSUER_HEADER } from '@forge/shared/api'

export interface ApiClientOptions {
  readonly baseUrl: string
  readonly accessToken: string
  /** Емітент. Потрібен лише коли членств кілька, але ставиться завжди. */
  readonly issuerId: string
}

/**
 * Відмова api — окремий тип, а не рядок.
 *
 * Код помилки продукту (`{ error: { code, message, details } }`) несе більше,
 * ніж статус: «інша емісія тримає наступний номер» і «немає атестатора в
 * складі» — обидва 400, і в звіті вони мають читатись різними реченнями.
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
  /** `delegated` — підписав операційний ключ; `member` — віддано непідписаним. */
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
 * Розбирає `{ error: { code, message, details } }`, не падаючи на іншій формі.
 *
 * Відповідь, яка не є нашою помилкою (проксі, шлюз, порожнє тіло), усе одно
 * мусить дати читабельне речення: інакше збій інфраструктури виглядав би як
 * відмова програми — рівно та підміна, від якої T024 уже раз постраждав.
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
