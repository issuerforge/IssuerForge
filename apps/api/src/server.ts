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
import { cors } from 'hono/cors'
import type { AppEnv } from './env.ts'
import { onError, onNotFound } from './errors.ts'
import { requireSession, type SessionDeps } from './session.ts'

export interface ServerDeps extends SessionDeps {
  logger: Logger
  webOrigins: readonly string[]
  /** Підмінюється в тестах, щоб `requestId` у відповіді був передбачуваним. */
  requestId?: () => string
}

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

  /** Проба живості для Railway. Без автентифікації і без звертань до бази. */
  app.get('/health', (c) => c.json({ status: 'ok' as const }))

  app.use('/api/*', requireSession(deps))

  /**
   * Те, що сервер вивів із токена входу. Консоль малює з цього перемикач
   * орендарів і набір доступних екранів (T010), а не вигадує роль сама.
   */
  app.get('/api/session', (c) => c.json(c.get('session') satisfies Session))

  return app
}

export type Server = ReturnType<typeof createServer>
