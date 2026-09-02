// Логер процесу. Живе в `shared`, а не в `apps/api`, бо той самий формат мають
// давати воркер-індексатор (T031) і скрипти демо: журнал комплаєнс-продукту
// зшивається за `requestId` і `issuerId`, і два різні формати роблять це
// зшивання ручною роботою.
import type { Writable } from 'node:stream'
import { type Logger, type LoggerOptions, pino } from 'pino'

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const

export type LogLevel = (typeof LOG_LEVELS)[number]

export type { Logger }

/**
 * Шляхи, значення яких у лог не потрапляють ніколи.
 *
 * `authorization` — це токен Privy у пред'явленому вигляді: рядок із лога
 * дозволяє ходити в API від імені людини, поки не вичерпається `exp`.
 * `databaseUrl` і `*Secret` — пароль бази й секрет застосунку Privy.
 *
 * Перелік навмисно накриває і кореневе поле, і вкладення в `req`/`headers`:
 * pino редагує за точним шляхом, тож `redact: ['authorization']` не чіпає
 * `req.headers.authorization`, і навпаки.
 */
const REDACTED_PATHS = [
  'authorization',
  'headers.authorization',
  'req.headers.authorization',
  'token',
  'accessToken',
  'appSecret',
  'privy.appSecret',
  'databaseUrl',
  'config.databaseUrl',
  'secretKey',
]

export interface LoggerConfig {
  level: LogLevel
  /** Ім'я процесу в кожному рядку: `api`, `worker`, `demo`. */
  service: string
}

/**
 * `destination` існує заради тестів: редагування секретів перевіряється на
 * тому, що логер справді написав, а не на тому, як його налаштували.
 */
export function createLogger(
  config: LoggerConfig,
  options: LoggerOptions = {},
  destination?: Writable,
): Logger {
  const settings: LoggerOptions = {
    level: config.level,
    base: { service: config.service },
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    ...options,
  }
  return destination === undefined ? pino(settings) : pino(settings, destination)
}
