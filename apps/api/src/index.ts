// Точка входу процесу api. Єдине місце, де читається оточення, відкривається
// з'єднання з базою й займається порт — далі по коду ходять готові значення.
import { createDatabase } from '@forge/db'
import { createLogger } from '@forge/shared/log'
import { serve } from '@hono/node-server'
import { ConfigError, loadConfig } from './config.ts'
import { createDirectory } from './directory.ts'
import { createPrivyClient } from './privy.ts'
import { createServer } from './server.ts'

function main() {
  const config = loadConfig()
  const logger = createLogger({ level: config.logLevel, service: 'api' })

  const app = createServer({
    logger,
    webOrigins: config.webOrigins,
    privy: createPrivyClient(config.privy),
    directory: createDirectory(createDatabase(config.databaseUrl)),
  })

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info({ port: info.port, origins: config.webOrigins }, 'api listening')
  })

  // Railway надсилає SIGTERM при кожному розгортанні. Без цього процес добиває
  // таймаут, а запити в польоті обриваються посеред відповіді.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.info({ signal }, 'shutting down')
      server.close(() => process.exit(0))
    })
  }
}

try {
  main()
} catch (error) {
  // Битий конфіг — це помилка розгортання, і вона має читатись без JSON-логера:
  // її бачать у консолі Railway очима, а не в системі збору логів.
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  }
  throw error
}
