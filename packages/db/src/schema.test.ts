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

  // FR-036 не можна виконати політикою RLS на таблиці, якій нема за що чіплятись.
  // Ця перевірка ловить нову таблицю без `issuer_id` у день, коли її додали, а не
  // на SC-011 у фазі Polish.
  it.each(tables.map((table) => [getTableConfig(table).name, table] as const))(
    '%s несе issuer_id',
    (_name, table) => {
      const columns = getTableConfig(table).columns.map((column) => column.name)
      expect(columns).toContain('issuer_id')
    },
  )

  it.each(tables.map((table) => [getTableConfig(table).name, table] as const))(
    '%s має увімкнений RLS у схемі',
    (_name, table) => {
      expect(getTableConfig(table).enableRLS).toBe(true)
    },
  )

  // Схема і SQL — різні артефакти, і в Supabase їде саме SQL. Політик тут ще
  // немає навмисно (їх пише T051), тож увімкнений RLS без політик означає
  // «не видно нікому, крім service_role» — стану «таблиця відкрита» не існує.
  it.each(tables.map((table) => getTableConfig(table).name))(
    '%s закритий уже в міграції',
    (name) => {
      expect(migrationSql).toContain(`ALTER TABLE "${name}" ENABLE ROW LEVEL SECURITY`)
    },
  )
})

describe('bounds taken from the program', () => {
  // Числа продубльовані в базі свідомо: рядок, якого програма не прийме, не має
  // існувати й у дзеркалі. Тест тримає обидві копії на видноті.
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
