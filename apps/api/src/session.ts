// The session: a verified login token → `issuer_id` and the role mask.
//
// The main rule of tenant isolation (FR-036) is stated here in one sentence:
// **`issuerId` is taken from the issuer's membership, not from the request.**
// The `X-Issuer-Id` header exists only for the case of several memberships,
// and can only narrow the choice to one of those already proven — it cannot
// grant access in any way.
//
// That case is not exotic: an auditor or a lawyer legitimately serves two
// issuers with one address, and SC-011 is measured with exactly two tenants.
import { ISSUER_HEADER, type Membership, type Session } from '@forge/shared/api'
import { createMiddleware } from 'hono/factory'
import type { Directory } from './directory.ts'
import type { AppEnv } from './env.ts'
import { invalidInput, unauthorized } from './errors.ts'
import type { PrivyClient } from './privy.ts'

export interface SessionDeps {
  privy: PrivyClient
  directory: Directory
}

/** `Authorization: Bearer <token>`. The scheme is case-insensitive per RFC 7235. */
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  const match = /^Bearer[ ]+(?<token>[^\s]+)$/i.exec(header)
  return match?.groups?.token
}

/**
 * Picks the tenant among the proven memberships.
 *
 * A header naming an issuer outside this list is `INVALID_INPUT`, not
 * `NOT_FOUND`: whether that issuer exists is a question that makes no sense
 * from this session's side, and an answer to it would be an answer about
 * someone else's data.
 */
export function selectMembership(
  memberships: readonly Membership[],
  requested: string | undefined,
): Membership {
  if (memberships.length === 0) {
    throw unauthorized('this wallet is not a member of any issuer')
  }

  if (requested === undefined) {
    const only = memberships[0]
    if (memberships.length === 1 && only !== undefined) return only
    throw invalidInput(`this account belongs to several issuers: pick one with ${ISSUER_HEADER}`, {
      issuerIds: memberships.map((m) => m.issuerId),
    })
  }

  const picked = memberships.find((m) => m.issuerId === requested)
  if (picked === undefined) {
    throw invalidInput(`${ISSUER_HEADER} does not name an issuer this account belongs to`, {
      issuerIds: memberships.map((m) => m.issuerId),
    })
  }
  return picked
}

/**
 * The login middleware. Puts `session` into the context or does not let
 * execution through at all — the state "the route ran without a session" does
 * not exist.
 */
export function requireSession(deps: SessionDeps) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const token = bearerToken(c.req.header('authorization'))
    if (token === undefined) throw unauthorized('missing bearer access token')

    const user = await deps.privy.authenticate(token)
    const memberships = await deps.directory.membershipsFor(user.wallets)
    const membership = selectMembership(
      memberships,
      c.req.header(ISSUER_HEADER)?.trim() || undefined,
    )

    const session: Session = {
      userId: user.userId,
      wallets: user.wallets,
      issuerId: membership.issuerId,
      roles: membership.roles,
      memberships,
    }

    c.set('session', session)
    // `issuerId` in the request logger is not decoration: the journal of a
    // compliance product must answer "what was done at this issuer" with no
    // joins.
    c.set('log', c.get('log').child({ issuerId: session.issuerId, userId: session.userId }))

    await next()
  })
}
