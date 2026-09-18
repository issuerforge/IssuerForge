import { ROLE } from '@forge/shared/api'
import { describe, expect, it } from 'vitest'
import { groupMemberships, type MembershipRow } from './directory.ts'

const ALPHA = '11111111111111111111111111111112'
const BETA = 'So11111111111111111111111111111111111111112'
const EMBEDDED = 'SysvarC1ock11111111111111111111111111111111'
const EXTERNAL = 'SysvarRent111111111111111111111111111111111'

const at = (iso: string) => new Date(iso)

function row(overrides: Partial<MembershipRow> = {}): MembershipRow {
  return {
    issuerId: ALPHA,
    wallet: EMBEDDED,
    roles: ROLE.ADMIN,
    syncedAt: at('2026-08-21T10:00:00.000Z'),
    ...overrides,
  }
}

describe('folding roster rows into memberships', () => {
  it('empty in, empty out', () => {
    expect(groupMemberships([])).toEqual([])
  })

  // An officer who logged in with a social login and signs with an external
  // wallet has the same powers as with a single address (FR-034a).
  it('merges the roles of several addresses of one person in one issuer', () => {
    const [membership] = groupMemberships([
      row({ wallet: EMBEDDED, roles: ROLE.OBSERVER }),
      row({ wallet: EXTERNAL, roles: ROLE.COMPLIANCE }),
    ])

    expect(membership?.roles).toBe(ROLE.OBSERVER | ROLE.COMPLIANCE)
    expect(membership?.wallets).toEqual([EMBEDDED, EXTERNAL].toSorted())
  })

  it('keeps issuers apart', () => {
    const memberships = groupMemberships([
      row({ issuerId: ALPHA, roles: ROLE.ADMIN }),
      row({ issuerId: BETA, roles: ROLE.COMPLIANCE }),
    ])

    expect(memberships).toHaveLength(2)
    expect(memberships.map((m) => m.roles)).toEqual(
      memberships.map((m) => (m.issuerId === ALPHA ? ROLE.ADMIN : ROLE.COMPLIANCE)),
    )
  })

  // The age of the mirror is the age of the worst thing the screen shows. The
  // newest `synced_at` would assure the membership is fresh next to
  // yesterday's row.
  it('takes the oldest synced_at of the membership', () => {
    const [membership] = groupMemberships([
      row({ wallet: EMBEDDED, syncedAt: at('2026-08-21T10:00:00.000Z') }),
      row({ wallet: EXTERNAL, syncedAt: at('2026-08-18T08:30:00.000Z') }),
    ])

    expect(membership?.syncedAt).toBe('2026-08-18T08:30:00.000Z')
  })

  it('the order is stable and independent of row order', () => {
    const rows = [row({ issuerId: BETA }), row({ issuerId: ALPHA, wallet: EXTERNAL })]

    expect(groupMemberships(rows).map((m) => m.issuerId)).toEqual(
      groupMemberships(rows.toReversed()).map((m) => m.issuerId),
    )
  })
})
