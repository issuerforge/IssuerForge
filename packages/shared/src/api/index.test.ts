import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DELEGATION,
  DELEGATION_ALL,
  hasPower,
  hasRole,
  membershipSchema,
  powerNames,
  ROLE,
  ROLE_ALL,
  ROLE_AUTHORISING,
  roleNames,
  sessionSchema,
} from './index.ts'

const ISSUER_RS = fileURLToPath(
  new URL('../../../../programs/issuer-forge/src/state/issuer.rs', import.meta.url),
)

/**
 * `pub const ADMIN: u8 = 1 << 0;` → 1. There are no parentheses and no more
 * complex arithmetic there.
 *
 * Catches both masks of the same file — roles and delegation: the names do
 * not overlap, and an extra entry in the map bothers no one.
 */
function rustRoleBits(source: string): Record<string, number> {
  const bits: Record<string, number> = {}
  for (const m of source.matchAll(/pub const (?<name>[A-Z_]+): u8 = 1 << (?<shift>\d+);/g)) {
    const { name, shift } = m.groups ?? {}
    if (name !== undefined && shift !== undefined) bits[name] = 1 << Number(shift)
  }
  return bits
}

describe('the role mask', () => {
  // This is the same duplicate as the database `CHECK`: the mask travels
  // chain → database → screen without re-encoding, so it has nowhere to
  // diverge — but that is exactly why a divergence would be silent. The test
  // reads the Rust, not a copy of the number.
  it('matches `role` in the program', () => {
    const rust = rustRoleBits(readFileSync(ISSUER_RS, 'utf8'))

    expect(rust.ADMIN).toBe(ROLE.ADMIN)
    expect(rust.COMPLIANCE).toBe(ROLE.COMPLIANCE)
    expect(rust.ATTESTOR).toBe(ROLE.ATTESTOR)
    expect(rust.OBSERVER).toBe(ROLE.OBSERVER)
  })

  it('ALL covers four bits, AUTHORISING — the two quorum roles', () => {
    expect(ROLE_ALL).toBe(15)
    expect(ROLE_AUTHORISING).toBe(ROLE.ADMIN | ROLE.COMPLIANCE)
    // The attestor does not sign the quorum (FR-024), the observer does not act (FR-033).
    expect(hasRole(ROLE_AUTHORISING, ROLE.ATTESTOR)).toBe(false)
    expect(hasRole(ROLE_AUTHORISING, ROLE.OBSERVER)).toBe(false)
  })

  it('unfolds into names in bit order', () => {
    expect(roleNames(ROLE.ADMIN | ROLE.COMPLIANCE)).toEqual(['ADMIN', 'COMPLIANCE'])
    expect(roleNames(ROLE.OBSERVER)).toEqual(['OBSERVER'])
  })
})

describe('the delegation mask', () => {
  // The same duplicate as with roles, and for the same reason: the mask comes
  // from `IssuerConfig.delegation_mask` as a plain number, so a divergence
  // would be silent.
  it('matches `delegation` in the program', () => {
    const rust = rustRoleBits(readFileSync(ISSUER_RS, 'utf8'))

    expect(rust.THAW_HOLDER).toBe(DELEGATION.THAW_HOLDER)
    expect(rust.SET_HOLDER_STATUS).toBe(DELEGATION.SET_HOLDER_STATUS)
    expect(rust.SETTLE_REDEMPTION).toBe(DELEGATION.SETTLE_REDEMPTION)
  })

  /**
   * The list is closed in the program: the mask has no power that moves funds
   * and cannot have one (FR-035a). The test holds exactly that — not "three
   * bits", but the fact that even a **full** delegation covers nothing beyond
   * three routine actions.
   */
  it('full delegation covers exactly three routine actions', () => {
    expect(DELEGATION_ALL).toBe(7)
    expect(powerNames(DELEGATION_ALL)).toEqual([
      'THAW_HOLDER',
      'SET_HOLDER_STATUS',
      'SETTLE_REDEMPTION',
    ])
  })

  it('an empty mask grants nothing', () => {
    expect(hasPower(0, DELEGATION.THAW_HOLDER)).toBe(false)
    expect(powerNames(0)).toEqual([])
  })

  // The bits of the two masks coincide numerically, which is exactly why the
  // function names differ: `hasRole` over a delegation mask would silently
  // answer "yes".
  it('thawing without the status right — these are different bits', () => {
    expect(hasPower(DELEGATION.THAW_HOLDER, DELEGATION.SET_HOLDER_STATUS)).toBe(false)
    expect(powerNames(DELEGATION.THAW_HOLDER)).toEqual(['THAW_HOLDER'])
  })
})

describe('the membership schema', () => {
  const valid = {
    issuerId: '11111111111111111111111111111112',
    roles: ROLE.ADMIN,
    wallets: ['11111111111111111111111111111112'],
    syncedAt: new Date().toISOString(),
  }

  it('accepts a full membership', () => {
    expect(membershipSchema.safeParse(valid).success).toBe(true)
  })

  // An empty mask is a free membership slot, not a member without rights: the
  // mirror has no such row, and it must not appear in a session either.
  it('rejects an empty role mask', () => {
    expect(membershipSchema.safeParse({ ...valid, roles: 0 }).success).toBe(false)
  })

  it('rejects an unknown bit', () => {
    expect(membershipSchema.safeParse({ ...valid, roles: 1 << 6 }).success).toBe(false)
  })

  it('rejects a membership with no address at all', () => {
    expect(membershipSchema.safeParse({ ...valid, wallets: [] }).success).toBe(false)
  })
})

describe('the session schema', () => {
  it('requires at least one membership', () => {
    const result = sessionSchema.safeParse({
      userId: 'did:privy:test',
      wallets: [],
      issuerId: '11111111111111111111111111111112',
      roles: ROLE.ADMIN,
      memberships: [],
    })
    expect(result.success).toBe(false)
  })
})
