import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createLogger, type LogLevel } from './log.ts'

/** Логер, підключений до пам'яті: перевіряємо написане, а не налаштування. */
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

describe('логер', () => {
  it("редагує токен входу й рядок з'єднання з базою", () => {
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
    // Токен із лога дозволяє ходити в API від імені людини до самого `exp`.
    expect(JSON.stringify(line)).not.toContain('super-secret')
    expect(JSON.stringify(line)).not.toContain('hunter2')
    expect(line?.authorization).toBe('[redacted]')
    expect(line?.databaseUrl).toBe('[redacted]')
    // Те, за чим зшивається журнал, лишається на видноті.
    expect(line?.issuerId).toBe('visible')
    expect(line?.service).toBe('api')
  })

  it('поважає рівень', () => {
    const { logger, lines } = capture('warn')

    logger.info('quiet')
    logger.warn('loud')

    expect(lines).toHaveLength(1)
    expect(lines[0]?.msg).toBe('loud')
  })
})
