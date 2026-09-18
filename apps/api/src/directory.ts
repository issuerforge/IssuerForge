// From wallet addresses to memberships in issuers.
//
// This is the second step of login and the only one that really grants
// powers: the first (Privy) proves only that the addresses belong to whoever
// came. `role_assignments` is a mirror of `IssuerConfig.members`, so the
// source of truth remains the chain, and what is answered here is "which
// screens to show", not "what to allow with funds".
//
// There is deliberately no cache here: the membership is changed by quorum,
// and a revoked role must vanish from the console in the same request, not a
// minute later.
import { type Database, roleAssignments } from '@forge/db'
import type { Membership } from '@forge/shared/api'
import { eq, inArray } from 'drizzle-orm'

export interface Directory {
  membershipsFor(wallets: readonly string[]): Promise<Membership[]>
  /**
   * One issuer's membership — row by row, not as a merged mask.
   *
   * The membership in the session says **whether** a person has a role; here
   * it is visible **which address** has it. The difference matters exactly
   * where an address becomes a signer: `create_token` is signed by the
   * founder-admin and the attestor, and a merged mask cannot say which of the
   * login account's two wallets is in the membership with the admin role.
   */
  rosterFor(issuerId: string): Promise<RosterEntry[]>
}

/** A membership row: the address, its roles and the slot the quorum indexes it by. */
export interface RosterEntry {
  wallet: string
  roles: number
  memberIndex: number
}

export function createDirectory(db: Database): Directory {
  return {
    async membershipsFor(wallets) {
      // `inArray` with an empty list is either a SQL error or `false`, depending
      // on the driver version. There simply is no query here.
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

    async rosterFor(issuerId) {
      return await db
        .select({
          wallet: roleAssignments.wallet,
          roles: roleAssignments.roles,
          memberIndex: roleAssignments.memberIndex,
        })
        .from(roleAssignments)
        .where(eq(roleAssignments.issuerId, issuerId))
        // Ordered by membership slot: that is also the bit order in the
        // signature bitmap (T025), so the list shown to a person matches the
        // one the quorum counts.
        .orderBy(roleAssignments.memberIndex)
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
 * Membership rows are folded into memberships per issuer.
 *
 * The mask is the union of the roles of all the person's addresses at this
 * issuer: an officer who logged in with a social login and signs with an
 * external wallet has the same powers as with a single address (FR-034a).
 *
 * `syncedAt` is the **oldest** of the rows, not the newest: the age of the
 * mirror is the age of the worst thing the screen shows. An optimistic number
 * here would mean a console that assures the membership is fresh while
 * showing yesterday's row.
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
      // The order is stable: the console draws the tenant switcher as a list,
      // and it must not reshuffle between requests because of the row order in
      // Postgres.
      .toSorted((a, b) => a.issuerId.localeCompare(b.issuerId))
  )
}
