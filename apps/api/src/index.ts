// The api process entry point. The one place where the environment is read,
// the database connection opened and the port taken — from here on the code
// passes ready values around.
import { createDatabase } from '@forge/db'
import { createLogger } from '@forge/shared/log'
import { serve } from '@hono/node-server'
import { Connection } from '@solana/web3.js'
import { createChainReader, fetchWithTimeout } from './chain.ts'
import { ConfigError, loadConfig } from './config.ts'
import { createDirectory } from './directory.ts'
import { createHolderStore } from './holders.ts'
import { createIssuanceStore } from './issuance.ts'
import { createOperationalSigner } from './operational.ts'
import { createPrivyClient } from './privy.ts'
import { createServer } from './server.ts'

function main() {
  const config = loadConfig()
  const logger = createLogger({ level: config.logLevel, service: 'api' })
  const database = createDatabase(config.databaseUrl)

  // `confirmed` is what the token counter reads at: `processed` would return a
  // number from a block that may yet fail to reach finality, i.e. a mint
  // address derived from a number that never was. The same connection sends
  // the delegated transactions, so they await confirmation at the same level.
  const connection = new Connection(config.rpcUrl, {
    commitment: 'confirmed',
    fetch: fetchWithTimeout(),
  })

  const app = createServer({
    logger,
    webOrigins: config.webOrigins,
    privy: createPrivyClient(config.privy),
    directory: createDirectory(database),
    issuance: createIssuanceStore(database),
    holders: createHolderStore(database),
    chain: createChainReader(connection),
    operational: createOperationalSigner(connection, config.operationalSecretKey),
  })

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info({ port: info.port, origins: config.webOrigins }, 'api listening')
  })

  // The host sends SIGTERM on every deploy. Without this the process runs out
  // the timeout, and in-flight requests are cut off mid-response.
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
  // A broken config is a deployment error, and it must be readable without the
  // JSON logger: it is seen by eye in the hosting console, not in a log
  // collection system.
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  }
  throw error
}
