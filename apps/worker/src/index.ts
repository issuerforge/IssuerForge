// The worker as a process of its own — for a local run next to `pnpm dev`.
// In production it runs inside the api behind `RUN_WORKER` (`render.yaml`);
// the two entry points call the same `startWorker` and differ only in who
// owns the database pool.
import { createDatabase } from '@forge/db'
import { createLogger, LOG_LEVELS } from '@forge/shared/log'
import { z } from 'zod'
import { startWorker } from './run.ts'

/** Exactly what this process reads: the node and the database, nothing the api needs. */
const envSchema = z.object({
  DEVNET_RPC_URL: z.url({ protocol: /^https?$/ }),
  DATABASE_URL: z.string().startsWith('postgres'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
})

async function main() {
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    process.stderr.write(
      `invalid environment:\n${parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}\n`,
    )
    process.exit(1)
  }
  const env = parsed.data
  const logger = createLogger({ level: env.LOG_LEVEL, service: 'worker' })
  const database = createDatabase(env.DATABASE_URL)
  const worker = await startWorker({ rpcUrl: env.DEVNET_RPC_URL, logger, database })

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.info({ signal }, 'shutting down')
      void worker
        .stop()
        .then(() => database.$client.end({ timeout: 5 }).then(() => process.exit(0)))
    })
  }
}

await main()
