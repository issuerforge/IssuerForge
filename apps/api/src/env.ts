// The Hono context typing. A separate file because the server, every
// middleware and the routes of later tasks all refer to it — and `server.ts`
// imports them.
import type { Session } from '@forge/shared/api'
import type { Logger } from '@forge/shared/log'

export interface AppEnv {
  Variables: {
    requestId: string
    /** The request's child logger: `requestId` is already in it, no need to add it. */
    log: Logger
    /**
     * Set by `requireSession`. In a route behind that middleware
     * `c.get('session')` is always defined — execution does not reach the
     * route otherwise.
     */
    session: Session
  }
}
