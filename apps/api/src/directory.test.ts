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

describe('зведення рядків складу в членства', () => {
  it('порожній вхід — порожній вихід', () => {
    expect(groupMemberships([])).toEqual([])
  })

  // Офіцер, що зайшов соцвходом, а підписує зовнішнім гаманцем, має ті самі
  // повноваження, що й з однією адресою (FR-034a).
  it("об'єднує ролі кількох адрес однієї людини в одного емітента", () => {
    const [membership] = groupMemberships([
      row({ wallet: EMBEDDED, roles: ROLE.OBSERVER }),
      row({ wallet: EXTERNAL, roles: ROLE.COMPLIANCE }),
    ])

    expect(membership?.roles).toBe(ROLE.OBSERVER | ROLE.COMPLIANCE)
    expect(membership?.wallets).toEqual([EMBEDDED, EXTERNAL].toSorted())
  })

  it('розділяє емітентів', () => {
    const memberships = groupMemberships([
      row({ issuerId: ALPHA, roles: ROLE.ADMIN }),
      row({ issuerId: BETA, roles: ROLE.COMPLIANCE }),
    ])

    expect(memberships).toHaveLength(2)
    expect(memberships.map((m) => m.roles)).toEqual(
      memberships.map((m) => (m.issuerId === ALPHA ? ROLE.ADMIN : ROLE.COMPLIANCE)),
    )
  })

  // Вік дзеркала — це вік найгіршого з того, що показує екран. Найновіший
  // `synced_at` запевняв би, що склад свіжий, поруч із вчорашнім рядком.
  it('бере найстаріший synced_at членства', () => {
    const [membership] = groupMemberships([
      row({ wallet: EMBEDDED, syncedAt: at('2026-08-21T10:00:00.000Z') }),
      row({ wallet: EXTERNAL, syncedAt: at('2026-08-18T08:30:00.000Z') }),
    ])

    expect(membership?.syncedAt).toBe('2026-08-18T08:30:00.000Z')
  })

  it('порядок стабільний і не залежить від порядку рядків', () => {
    const rows = [row({ issuerId: BETA }), row({ issuerId: ALPHA, wallet: EXTERNAL })]

    expect(groupMemberships(rows).map((m) => m.issuerId)).toEqual(
      groupMemberships(rows.toReversed()).map((m) => m.issuerId),
    )
  })
})
