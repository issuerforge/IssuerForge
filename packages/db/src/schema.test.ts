import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { is } from 'drizzle-orm'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import * as schema from './schema.ts'

const tables = Object.values(schema).filter((value) => is(value, PgTable))

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url))
const migrationSql = readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .map((file) => readFileSync(`${migrationsDir}/${file}`, 'utf8'))
  .join('\n')

describe('tenant isolation', () => {
  it('the tables exist at all', () => {
    expect(tables.length).toBeGreaterThan(0)
  })

  // FR-036 cannot be enforced by an RLS policy on a table with nothing to hold
  // on to. This check catches a new table without `issuer_id` on the day it is
  // added, not at SC-011 in the Polish phase.
  it.each(tables.map((table) => [getTableConfig(table).name, table] as const))(
    '%s carries issuer_id',
    (_name, table) => {
      const columns = getTableConfig(table).columns.map((column) => column.name)
      expect(columns).toContain('issuer_id')
    },
  )

  it.each(tables.map((table) => [getTableConfig(table).name, table] as const))(
    '%s has RLS enabled in the schema',
    (_name, table) => {
      expect(getTableConfig(table).enableRLS).toBe(true)
    },
  )

  // The schema and the SQL are different artefacts, and it is the SQL that
  // goes to Supabase. There are deliberately no policies here yet (T051 writes
  // them), so RLS enabled without policies means "visible to no one except
  // service_role" — the state "the table is open" does not exist.
  it.each(tables.map((table) => getTableConfig(table).name))(
    '%s is closed already in the migration',
    (name) => {
      expect(migrationSql).toContain(`ALTER TABLE "${name}" ENABLE ROW LEVEL SECURITY`)
    },
  )
})

describe('bounds taken from the program', () => {
  // The numbers are duplicated in the database on purpose: a row the program
  // would not accept must not exist in the mirror either. The test keeps both
  // copies in plain sight.
  it('a quorum below MIN_QUORUM is not stored', () => {
    expect(migrationSql).toContain('"issuers"."quorum_n" >= 2')
  })

  it('a roster slot does not exceed MAX_MEMBERS', () => {
    expect(migrationSql).toContain('"role_assignments"."member_index" between 0 and 7')
  })

  it('a role mask is never empty', () => {
    expect(migrationSql).toContain('"role_assignments"."roles" between 1 and 15')
  })
})
