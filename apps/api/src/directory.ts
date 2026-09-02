// Від адрес гаманців до членств у складі емітентів.
//
// Це другий крок входу і єдиний, який справді дає повноваження: перший (Privy)
// доводить лише, що адреси належать тому, хто прийшов. `role_assignments` —
// дзеркало `IssuerConfig.members`, тож джерелом правди лишається ланцюг, а тут
// відповідається питання «які екрани показувати», не «що дозволити з коштами».
//
// Кешу тут немає навмисно: склад змінюється кворумом, і відкликана роль має
// зникати з консолі в тому ж запиті, а не за хвилину.
import { type Database, roleAssignments } from '@forge/db'
import type { Membership } from '@forge/shared/api'
import { inArray } from 'drizzle-orm'

export interface Directory {
  membershipsFor(wallets: readonly string[]): Promise<Membership[]>
}

export function createDirectory(db: Database): Directory {
  return {
    async membershipsFor(wallets) {
      // `inArray` з порожнім списком — це або SQL-помилка, або `false` залежно
      // від версії драйвера. Запиту тут просто не існує.
      if (wallets.length === 0) return []

      const rows = await db
        .select({
          issuerId: roleAssignments.issuerId,
          wallet: roleAssignments.wallet,
          roles: roleAssignments.roles,
          syncedAt: roleAssignments.syncedAt,
        })
        .from(roleAssignments)
        .where(inArray(roleAssignments.wallet, [...wallets]))

      return groupMemberships(rows)
    },
  }
}

export interface MembershipRow {
  issuerId: string
  wallet: string
  roles: number
  syncedAt: Date
}

/**
 * Рядки складу зводяться в членства по емітентах.
 *
 * Маска — об'єднання ролей усіх адрес людини в цього емітента: офіцер, що
 * зайшов соцвходом і підписує зовнішнім гаманцем, має ті самі повноваження, що
 * й з однією адресою (FR-034a).
 *
 * `syncedAt` береться **найстаріший** із рядків, а не найновіший: вік дзеркала
 * — це вік найгіршого з того, що екран показує. Оптимістичне число тут
 * означало б консоль, яка запевняє, що склад свіжий, показуючи вчорашній рядок.
 */
export function groupMemberships(rows: readonly MembershipRow[]): Membership[] {
  const byIssuer = new Map<string, { roles: number; wallets: string[]; syncedAt: Date }>()

  for (const row of rows) {
    const current = byIssuer.get(row.issuerId)
    if (current === undefined) {
      byIssuer.set(row.issuerId, {
        roles: row.roles,
        wallets: [row.wallet],
        syncedAt: row.syncedAt,
      })
      continue
    }
    current.roles |= row.roles
    current.wallets.push(row.wallet)
    if (row.syncedAt < current.syncedAt) current.syncedAt = row.syncedAt
  }

  return (
    [...byIssuer.entries()]
      .map(([issuerId, m]) => ({
        issuerId,
        roles: m.roles,
        wallets: m.wallets.toSorted(),
        syncedAt: m.syncedAt.toISOString(),
      }))
      // Порядок стабільний: консоль малює перемикач орендарів списком, і той не
      // має переставлятись між запитами через порядок рядків у Postgres.
      .toSorted((a, b) => a.issuerId.localeCompare(b.issuerId))
  )
}
