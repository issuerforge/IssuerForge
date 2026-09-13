// Hono-застосунок: маршрути консолі, SSE-стрічка, публічне читання.
// Ключів емітента тут немає: ендпоінти, що змінюють ончейн-стан, віддають
// непідписану транзакцію (docs/PLAN.md → «API-контракти»).
//
// Застосунок збирається з переданих залежностей і нічого не створює сам: ані
// з'єднання з базою, ані клієнта Privy, ані читання оточення. Завдяки цьому
// тести піднімають той самий сервер, що й `index.ts`, без мережі й без бази —
// підміняється рівно те, що ходить назовні.
import { REQUEST_ID_HEADER, type Session } from '@forge/shared/api'
import type { Logger } from '@forge/shared/log'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import type { ChainReader } from './chain.ts'
import type { AppEnv } from './env.ts'
import { invalidInput, onError, onNotFound } from './errors.ts'
import type { HolderStore } from './holders.ts'
import type { IssuanceStore } from './issuance.ts'
import type { OperationalSigner } from './operational.ts'
import { createHolderRoutes } from './routes/holders.ts'
import { createTokenRoutes } from './routes/tokens.ts'
import { requireSession, type SessionDeps } from './session.ts'

export interface ServerDeps extends SessionDeps {
  logger: Logger
  webOrigins: readonly string[]
  chain: ChainReader
  issuance: IssuanceStore
  holders: HolderStore
  /**
   * Операційний ключ платформи. Єдина залежність сервера, яка вміє підписувати
   * — і саме тому вона передається ззовні, як усе інше: тест піднімає ті самі
   * маршрути, не маючи ключа взагалі.
   */
  operational: OperationalSigner
  /** Підмінюється в тестах, щоб `requestId` у відповіді був передбачуваним. */
  requestId?: () => string
  /** Годинник. Підмінюється в тестах, щоб симуляція була відтворюваною. */
  now?: () => Date
}

/** Найбільше тіло запиту, яке має сенс. Найбільше законне — випуск, ~2 КБ. */
export const MAX_BODY_BYTES = 32 * 1024

export function createServer(deps: ServerDeps) {
  const app = new Hono<AppEnv>()
  const newRequestId = deps.requestId ?? (() => crypto.randomUUID())

  app.onError(onError)
  app.notFound(onNotFound)

  app.use('*', async (c, next) => {
    // Ідентифікатор приймається від клієнта: консоль ставить його на запит і
    // показує в повідомленні про помилку, і тоді рядок лога знаходиться за тим
    // самим числом, яке бачила людина.
    const requestId = c.req.header(REQUEST_ID_HEADER) ?? newRequestId()
    c.set('requestId', requestId)
    c.set('log', deps.logger.child({ requestId }))
    c.header(REQUEST_ID_HEADER, requestId)
    await next()
  })

  // Походження перевіряється за точним збігом зі списком: `*` тут неможливий,
  // бо консоль ходить із заголовком `Authorization`, а браузер не приймає
  // подорожні облікові дані на відповідь із дозволом «будь-кому».
  app.use(
    '/api/*',
    cors({
      origin: (origin) => (deps.webOrigins.includes(origin) ? origin : null),
      allowHeaders: ['authorization', 'content-type', 'x-issuer-id', REQUEST_ID_HEADER],
      exposeHeaders: [REQUEST_ID_HEADER],
      credentials: true,
      maxAge: 600,
    }),
  )

  // Стеля тіла стоїть одна на всі ручки, а не по копії в кожній: без неї
  // двадцятимегабайтний JSON розбирається цілком і тільки потім відкидається
  // схемою (виміряно). Найбільше законне тіло — випуск токена — важить близько
  // двох кілобайтів, тож запас тут тридцятикратний із гаком.
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () => {
        // 413 у переліку кодів немає, і вигадувати його заради одного випадку
        // означало б другий спосіб відповідати на «клієнт надіслав не те».
        throw invalidInput('request body is too large', { limit: MAX_BODY_BYTES })
      },
    }),
  )

  /** Проба живості для Railway. Без автентифікації і без звертань до бази. */
  app.get('/health', (c) => c.json({ status: 'ok' as const }))

  app.use('/api/*', requireSession(deps))

  /**
   * Те, що сервер вивів із токена входу. Консоль малює з цього перемикач
   * орендарів і набір доступних екранів (T010), а не вигадує роль сама.
   */
  app.get('/api/session', (c) => c.json(c.get('session') satisfies Session))

  // Маршрути монтуються **після** `requireSession`: Hono добирає обробники в
  // порядку реєстрації, тож ручка, додана нижче, все одно проходить через уже
  // оголошений вхід. Стану «маршрут під /api без сесії» не існує.
  const now = deps.now ?? (() => new Date())
  app.route('/api', createTokenRoutes({ ...deps, now }))
  app.route('/api', createHolderRoutes({ ...deps, now }))

  return app
}

export type Server = ReturnType<typeof createServer>
