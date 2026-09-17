import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createLogger, type LogLevel } from './log.ts'

/** A logger wired to memory: we check what was written, not how it was configured. */
function capture(level: LogLevel) {
  const lines: Record<string, unknown>[] = []
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(JSON.parse(String(chunk)) as Record<string, unknown>)
      callback()
    },
  })
  return { logger: createLogger({ level, service: 'api' }, {}, destination), lines }
}

describe('the logger', () => {
  it('redacts the login token and the database connection string', () => {
    const { logger, lines } = capture('info')

    logger.info(
      {
        authorization: 'Bearer super-secret',
        req: { headers: { authorization: 'Bearer super-secret' } },
        databaseUrl: 'postgres://user:hunter2@host:6543/db',
        issuerId: 'visible',
      },
      'request',
    )

    const [line] = lines
    expect(line).toBeDefined()
    // A token from the log lets anyone call the API on behalf of a person until `exp`.
    expect(JSON.stringify(line)).not.toContain('super-secret')
    expect(JSON.stringify(line)).not.toContain('hunter2')
    expect(line?.authorization).toBe('[redacted]')
    expect(line?.databaseUrl).toBe('[redacted]')
    // What the journal is stitched together by stays in plain sight.
    expect(line?.issuerId).toBe('visible')
    expect(line?.service).toBe('api')
  })

  it('respects the level', () => {
    const { logger, lines } = capture('warn')

    logger.info('quiet')
    logger.warn('loud')

    expect(lines).toHaveLength(1)
    expect(lines[0]?.msg).toBe('loud')
  })
})
