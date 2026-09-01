// Підключення до Postgres і реекспорт схеми.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.ts'

export * from './schema.ts'

/**
 * `prepare: false` — вимога пулера Supabase на порту 6543: він працює в
 * transaction mode, де підготовані запити не переживають межу транзакції, і
 * перше ж повторне звертання падає з `prepared statement does not exist`.
 *
 * Рядок з'єднання сюди приходить готовим: читання оточення живе в конфізі api
 * (T009), а не в пакеті бази, щоб той самий пакет годився і воркеру, і скриптам.
 */
export function createDatabase(url: string) {
  return drizzle(postgres(url, { prepare: false }), { schema })
}

export type Database = ReturnType<typeof createDatabase>
