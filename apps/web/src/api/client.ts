// Клієнт api: єдине місце, де консоль ходить у мережу.
//
// Три правила, які тут закріплені:
//
// 1. **Токен береться на кожен запит**, а не запам'ятовується. Privy оновлює
//    його сам, і збережена копія рано чи пізно стає простроченою рівно тоді,
//    коли офіцер натискає «підписати».
// 2. **Відповідь, яка не збіглася зі схемою, — це помилка, а не порожній
//    екран.** У комплаєнс-продукті мовчки не намальоване поле гірше за напис
//    «відповідь не збіглася з контрактом»: перше виглядає як «нуль».
// 3. **`X-Request-Id` ставить клієнт.** Api його приймає (`server.ts`), тож
//    число з екрана помилки й рядок лога — одне й те саме число.

import { ISSUER_HEADER, REQUEST_ID_HEADER } from '@forge/shared/api'
import { apiErrorSchema, type ErrorCode } from '@forge/shared/errors'
import type { z } from 'zod'

export interface ApiClientDeps {
  /** Без кінцевого слеша — його зрізає `readWebEnv`. */
  baseUrl: string
  /** `getAccessToken` із Privy. `null` означає «вхід не виконаний». */
  getAccessToken: () => Promise<string | null>
  /**
   * Обраний емітент, коли членств кілька. Функція, а не значення: перемикач у
   * шапці міняє його між запитами, і клієнт не має перестворюватись на це.
   */
  issuerId?: () => string | undefined
  fetch?: typeof globalThis.fetch
  requestId?: () => string
}

/**
 * Помилка api як значення. Несе код із того самого переліку, що й сервер, тож
 * екран приймає рішення за кодом, а не за текстом повідомлення.
 */
export class ApiRequestError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly requestId: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ApiRequestError'
  }
}

export interface ApiClient {
  get<T>(path: string, schema: z.ZodType<T>): Promise<T>
  /**
   * Тіло **не** валідується тут перед відправкою.
   *
   * Схему запиту знає той, хто його складає (майстер бере її з
   * `@forge/api/contracts` — того самого файла, що й сервер), а клієнт лишається
   * транспортом. Друга перевірка тут означала б два місця, де вирішується, що
   * таке правильне тіло, і розійшлися б вони мовчки.
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

    // Вхід перевіряється до мережі: запит без токена api однаково відхилить, а
    // так «ви не увійшли» видно миттєво й без зайвого рядка в логах сервера.
    const token = await deps.getAccessToken()
    if (token === null) {
      throw new ApiRequestError('UNAUTHORIZED', 'not signed in', requestId)
    }

    const headers = new Headers({
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      [REQUEST_ID_HEADER]: requestId,
    })

    // Заголовок ставиться, тільки коли емітент справді обраний: порожнє
    // значення api читає як «не названо», і краще не надсилати його зовсім.
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
      // Мережевої помилки в переліку кодів немає: для екрана вона нічим не
      // відрізняється від «сервер не відповів», і це `INTERNAL`.
      throw new ApiRequestError('INTERNAL', 'the console could not reach the api', requestId, {
        cause: String(cause),
      })
    }

    // Свій ідентифікатор перебивається тим, що назвав сервер: збігаються вони
    // завжди, крім випадку, коли запит не дійшов і відповів проксі.
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
