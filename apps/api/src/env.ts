// Типізація контексту Hono. Окремим файлом, бо на неї посилаються і сервер, і
// кожен middleware, і маршрути з наступних задач — а `server.ts` імпортує їх.
import type { Session } from '@forge/shared/api'
import type { Logger } from '@forge/shared/log'

export interface AppEnv {
  Variables: {
    requestId: string
    /** Дочірній логер запиту: `requestId` уже в ньому, дописувати не треба. */
    log: Logger
    /**
     * Ставиться `requireSession`. У маршруті за цим middleware `c.get('session')`
     * визначений завжди — до маршруту виконання не доходить інакше.
     */
    session: Session
  }
}
