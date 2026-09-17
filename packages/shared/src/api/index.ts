// Contracts shared by the server and the console: the role mask, the session
// shape and the header names. The schemas here validate both the response on
// the server and what the browser read, so a divergence between the two sides
// is impossible by construction.
import { z } from 'zod'
import { addressSchema } from '../primitives.ts'

/**
 * Role bitmask — a mirror of `role` in `programs/issuer-forge/src/state/issuer.rs`.
 * The numbers are not "agreed", they are the same ones: the database holds
 * `role_assignments.roles` copied from `IssuerConfig.members[i].roles`, and any
 * re-encoding on the path chain → database → screen would be a place where a
 * role could change silently.
 */
export const ROLE = {
  ADMIN: 1 << 0,
  COMPLIANCE: 1 << 1,
  ATTESTOR: 1 << 2,
  OBSERVER: 1 << 3,
} as const

export type RoleName = keyof typeof ROLE

export const ROLE_NAMES = Object.keys(ROLE) as readonly RoleName[]

/** All known bits. The same number stands as a `CHECK` on `role_assignments`. */
export const ROLE_ALL = ROLE.ADMIN | ROLE.COMPLIANCE | ROLE.ATTESTOR | ROLE.OBSERVER

/** Roles whose signature counts towards the quorum (FR-019). */
export const ROLE_AUTHORISING = ROLE.ADMIN | ROLE.COMPLIANCE

/**
 * An empty mask is not a role: a membership row with `roles == 0` is a free
 * slot, not a member without powers (`OBSERVER` exists for the latter).
 */
export const roleMaskSchema = z.number().int().min(1).max(ROLE_ALL)

export function hasRole(mask: number, role: number): boolean {
  return (mask & role) !== 0
}

export function roleNames(mask: number): RoleName[] {
  return ROLE_NAMES.filter((name) => hasRole(mask, ROLE[name]))
}

/**
 * Powers delegated to the platform's operational key (FR-035) — a mirror of
 * `delegation` in the same `state/issuer.rs`.
 *
 * The list is closed **in the program**, not in configuration: issuance,
 * seizure, pause and policy change are not here and cannot be, so a
 * compromised operational key does not get them even with a "full" mask
 * (FR-035a).
 */
export const DELEGATION = {
  THAW_HOLDER: 1 << 0,
  SET_HOLDER_STATUS: 1 << 1,
  SETTLE_REDEMPTION: 1 << 2,
} as const

export type PowerName = keyof typeof DELEGATION

export const POWER_NAMES = Object.keys(DELEGATION) as readonly PowerName[]

export const DELEGATION_ALL =
  DELEGATION.THAW_HOLDER | DELEGATION.SET_HOLDER_STATUS | DELEGATION.SETTLE_REDEMPTION

/**
 * The same arithmetic as `hasRole`, and deliberately a **separate name**.
 *
 * Both masks are `number`, so the types will not hold the confusion back:
 * `hasRole(mask, ROLE.ADMIN)` over a delegation mask would compile and
 * silently answer "yes" to `THAW_HOLDER`. Different names keep that mistake
 * visible when reading — the only barrier that is possible here at all.
 */
export function hasPower(mask: number, power: number): boolean {
  return (mask & power) !== 0
}

export function powerNames(mask: number): PowerName[] {
  return POWER_NAMES.filter((name) => hasPower(mask, DELEGATION[name]))
}

/**
 * One user's membership in one issuer.
 *
 * `wallets` are those of the verified login addresses that really are in this
 * issuer's membership; the mask is the union of their roles. `syncedAt` is the
 * age of the membership mirror, and it is shown in the console: a screen that
 * silently draws yesterday's role membership is worse than an empty one in a
 * compliance product.
 */
export const membershipSchema = z.object({
  issuerId: addressSchema,
  roles: roleMaskSchema,
  wallets: z.array(addressSchema).min(1),
  syncedAt: z.iso.datetime(),
})

export type Membership = z.infer<typeof membershipSchema>

/**
 * The session is what the server derived from the verified login token, and
 * **only that**.
 *
 * `issuerId` here does not come from a request parameter: it is either the
 * only membership, or the one chosen by the `X-Issuer-Id` header among
 * memberships already proven. The header narrows the choice, it does not grant
 * access, so the FR-036 rule "no request parameter overrides the session's
 * `issuer_id`" stays intact.
 *
 * The role in the session opens screens and handlers. It does not authorise
 * actions with funds: those are checked by the program against the quorum
 * (FR-019), and the session has no influence on that whatsoever.
 */
export const sessionSchema = z.object({
  /** DID of the login provider. Roles are not bound to it (FR-034a). */
  userId: z.string().min(1),
  /** All verified Solana addresses of the login account. */
  wallets: z.array(addressSchema),
  issuerId: addressSchema,
  roles: roleMaskSchema,
  memberships: z.array(membershipSchema).min(1),
})

export type Session = z.infer<typeof sessionSchema>

/** Issuer selection when there are several memberships. The value must be among them. */
export const ISSUER_HEADER = 'x-issuer-id'

/** End-to-end request identifier: accepted from the client, otherwise our own. */
export const REQUEST_ID_HEADER = 'x-request-id'
