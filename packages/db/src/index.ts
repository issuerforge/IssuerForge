// The Postgres connection and a re-export of the schema.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.ts'

export * from './schema.ts'

/**
 * `prepare: false` is a requirement of the Supabase pooler on port 6543: it
 * runs in transaction mode, where prepared statements do not survive the
 * transaction boundary, and the very first repeat call fails with
 * `prepared statement does not exist`.
 *
 * The connection string arrives here ready-made: reading the environment
 * lives in the api config (T009), not in the database package, so that the
 * same package serves the worker and the scripts too.
 */
export function createDatabase(url: string) {
  return drizzle(postgres(url, { prepare: false }), { schema })
}

export type Database = ReturnType<typeof createDatabase>
