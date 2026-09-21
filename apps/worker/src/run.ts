// The worker, assembled: connection, lookups, writer, cursor, the queue,
// and the two sources feeding it.
//
// `startWorker` is the whole public surface. The api calls it in-process
// behind `RUN_WORKER` (the free Render instance runs one process, and this
// is the only way the indexer gets to run there); `src/index.ts` calls the
// same function as a process of its own for a local run. Neither knows what
// is inside.
import { PROGRAM_ID } from '@forge/chain'
import type { Database } from '@forge/db'
import type { Logger } from '@forge/shared/log'
import { Connection, type VersionedTransactionResponse } from '@solana/web3.js'
import { createApplier, drizzleCursorStore, drizzleWriter } from './indexer/apply.ts'
import { createIndexer, type Seen } from './indexer/cursor.ts'
import { decodeTransaction } from './indexer/decode.ts'
import { createRpcLookups } from './indexer/lookups.ts'
import { signaturesSince, subscribeSignatures } from './indexer/source.ts'
import { toTransactionView } from './indexer/transaction.ts'

export interface StartWorkerInput {
  readonly rpcUrl: string
  readonly logger: Logger
  /** Owned by the caller: the api shares its pool when the worker runs in-process. */
  readonly database: Database
}

export interface WorkerHandle {
  stop(): Promise<void>
}

/** How often the backfill re-checks the tip for anything the socket dropped. */
const BACKFILL_EVERY_MS = 30_000

/**
 * A confirmed notification can arrive a moment before the same node serves
 * the transaction: a null answer is retried, briefly, before it counts as a
 * failure — which the next backfill pass then repairs anyway.
 */
const FETCH_ATTEMPTS = 3
const FETCH_RETRY_MS = 1_000

/** `Connection` has no timeout of its own; a hung node would hold the queue forever. */
const RPC_TIMEOUT_MS = 15_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchConfirmed(
  connection: Connection,
  signature: string,
): Promise<VersionedTransactionResponse> {
  for (let attempt = 1; ; attempt += 1) {
    const response = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    })
    if (response !== null) return response
    if (attempt >= FETCH_ATTEMPTS) throw new Error(`${signature}: not served at confirmed`)
    await sleep(FETCH_RETRY_MS)
  }
}

export async function startWorker({
  rpcUrl,
  logger,
  database,
}: StartWorkerInput): Promise<WorkerHandle> {
  const connection = new Connection(rpcUrl, {
    commitment: 'confirmed',
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) }),
  })
  const lookups = createRpcLookups(connection)
  const apply = createApplier(drizzleWriter(database))
  const store = drizzleCursorStore(database, PROGRAM_ID.toBase58())

  const indexer = createIndexer({
    store,
    initial: await store.load(),
    logger,
    async handle(seen: Seen) {
      const view = toTransactionView(
        seen.signature,
        await fetchConfirmed(connection, seen.signature),
      )
      const decoded = await decodeTransaction(view, lookups)
      await apply(view, decoded)
      if (decoded.events.length > 0 || decoded.changes.length > 0) {
        logger.info(
          {
            signature: seen.signature,
            slot: seen.slot,
            events: decoded.events.map((record) => record.event.kind),
            changes: decoded.changes.map((change) => change.kind),
          },
          'indexed',
        )
      }
    },
  })

  let passing = false
  async function backfillPass(): Promise<void> {
    if (passing) return
    passing = true
    try {
      indexer.resume()
      const since = indexer.cursor()?.signature
      const pending = await signaturesSince(connection, PROGRAM_ID, since)
      for (const seen of pending) {
        await indexer.handle(seen)
        if (indexer.halted()) break
      }
      logger.info(
        {
          since: since ?? null,
          found: pending.length,
          cursor: indexer.cursor()?.signature ?? null,
        },
        'backfill pass',
      )
    } catch (error) {
      logger.warn({ err: error }, 'backfill failed')
    } finally {
      passing = false
    }
  }

  await backfillPass()
  const subscription = subscribeSignatures(connection, PROGRAM_ID, indexer.push)
  const timer = setInterval(() => void backfillPass(), BACKFILL_EVERY_MS)
  // Only the host: the RPC key sits in the query string.
  logger.info({ program: PROGRAM_ID.toBase58(), rpc: new URL(rpcUrl).host }, 'worker listening')

  return {
    async stop() {
      clearInterval(timer)
      await subscription.stop()
      await indexer.drain()
    },
  }
}
