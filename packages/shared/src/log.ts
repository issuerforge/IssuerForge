// Process logger. Lives in `shared` rather than `apps/api` because the indexer
// worker (T031) and the demo scripts must emit the same format: the journal of
// a compliance product is stitched together by `requestId` and `issuerId`, and
// two different formats turn that stitching into manual work.
import type { Writable } from 'node:stream'
import { type Logger, type LoggerOptions, pino } from 'pino'

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const

export type LogLevel = (typeof LOG_LEVELS)[number]

export type { Logger }

/**
 * Paths whose values never reach the log.
 *
 * `authorization` is the Privy token as presented: a line from the log lets
 * anyone call the API on behalf of a person until `exp` runs out.
 * `databaseUrl` and `*Secret` are the database password and the Privy app
 * secret.
 *
 * The list deliberately covers both the root field and the nesting under
 * `req`/`headers`: pino redacts by exact path, so `redact: ['authorization']`
 * does not touch `req.headers.authorization`, and vice versa.
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
  /** Process name on every line: `api`, `worker`, `demo`. */
  service: string
}

/**
 * `destination` exists for the tests: secret redaction is checked against
 * what the logger actually wrote, not against how it was configured.
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
