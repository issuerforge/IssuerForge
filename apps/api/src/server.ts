// The Hono app: console routes, the SSE feed, public reads. There are no
// issuer keys here: endpoints that change on-chain state return an unsigned
// transaction (docs/PLAN.md → "API contracts").
//
// The app is assembled from the dependencies passed in and creates nothing
// itself: neither the database connection, nor the Privy client, nor the
// environment read. Thanks to that, tests bring up the same server as
// `index.ts`, with no network and no database — exactly what goes outside is
// swapped.
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
import type { JournalStore } from './journal.ts'
import type { OperationalSigner } from './operational.ts'
import { createHolderRoutes } from './routes/holders.ts'
import { createJournalRoutes } from './routes/journal.ts'
import { createTokenRoutes } from './routes/tokens.ts'
import { requireSession, type SessionDeps } from './session.ts'

export interface ServerDeps extends SessionDeps {
  logger: Logger
  webOrigins: readonly string[]
  chain: ChainReader
  issuance: IssuanceStore
  holders: HolderStore
  journal: JournalStore
  /**
   * The platform's operational key. The only server dependency that can sign
   * — and that is exactly why it is passed in from outside like everything
   * else: a test brings up the same routes with no key at all.
   */
  operational: OperationalSigner
  /** Swapped in tests so that the `requestId` in the response is predictable. */
  requestId?: () => string
  /** The clock. Swapped in tests so that the simulation is reproducible. */
  now?: () => Date
  /** The feed's poll interval. Swapped in tests so a poll is not a second of waiting. */
  feedPollMs?: number
}

/** The largest request body that makes sense. The largest legitimate one is an issuance, ~2 KB. */
export const MAX_BODY_BYTES = 32 * 1024

export function createServer(deps: ServerDeps) {
  const app = new Hono<AppEnv>()
  const newRequestId = deps.requestId ?? (() => crypto.randomUUID())

  app.onError(onError)
  app.notFound(onNotFound)

  app.use('*', async (c, next) => {
    // The identifier is accepted from the client: the console puts it on the
    // request and shows it in the error message, and then the log line is
    // found by the same number the person saw.
    const requestId = c.req.header(REQUEST_ID_HEADER) ?? newRequestId()
    c.set('requestId', requestId)
    c.set('log', deps.logger.child({ requestId }))
    c.header(REQUEST_ID_HEADER, requestId)
    await next()
  })

  // The origin is checked by exact match against the list: `*` is impossible
  // here, because the console sends an `Authorization` header, and the
  // browser does not accept credentials on a response that allows "anyone".
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

  // One body ceiling for all handlers rather than a copy in each: without it
  // a twenty-megabyte JSON is parsed in full and only then rejected by the
  // schema (measured). The largest legitimate body — a token issuance — weighs
  // about two kilobytes, so the headroom here is thirtyfold and then some.
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () => {
        // 413 is not in the list of codes, and inventing it for one case would
        // mean a second way of answering "the client sent the wrong thing".
        throw invalidInput('request body is too large', { limit: MAX_BODY_BYTES })
      },
    }),
  )

  /** The liveness probe for the host. No authentication and no database access. */
  app.get('/health', (c) => c.json({ status: 'ok' as const }))

  app.use('/api/*', requireSession(deps))

  /**
   * What the server derived from the login token. The console draws the
   * tenant switcher and the set of available screens from this (T010) rather
   * than inventing the role itself.
   */
  app.get('/api/session', (c) => c.json(c.get('session') satisfies Session))

  // The routes are mounted **after** `requireSession`: Hono picks handlers in
  // registration order, so a handler added below still goes through the login
  // already declared. The state "a route under /api without a session" does
  // not exist.
  const now = deps.now ?? (() => new Date())
  app.route('/api', createTokenRoutes({ ...deps, now }))
  app.route('/api', createHolderRoutes({ ...deps, now }))
  app.route('/api', createJournalRoutes({ ...deps, now }))

  return app
}

export type Server = ReturnType<typeof createServer>
