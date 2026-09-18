// The console screen registry: path, name, required role, content.
//
// This is the **only** place that says which role opens what. The header
// navigation, the route guard and the refusal screen read one and the same
// list, so "the menu item is there but cannot be opened" is impossible by
// construction.
//
// The role arrives here from the session (`GET /api/session`) and is derived
// by the server from the issuer's membership by wallet addresses (FR-034a).
// The console neither computes nor stores it: here it is only read.
//
// Screens that do not exist yet are in the list with a stub naming their
// task. An empty menu item with an honest label is better than a missing one:
// the screen shows the full shape of the powers, not the part that has been
// written so far.
import { ROLE, ROLE_ALL, type RoleName, roleNames } from '@forge/shared/api'
import { lazy, type ReactElement, Suspense } from 'react'
import Overview from './Overview'
import Stub from './Stub'

/**
 * The issuance wizard is loaded as a separate chunk, and that is not only
 * about size.
 *
 * It pulls in the Solana part of Privy — transaction signing — while the
 * screen registry must stay what it is: a list readable without any wallet.
 * A static import would make this file (and its test) depend on the signing
 * library for the sake of a menu line.
 */
const Wizard = lazy(() => import('@/wizard/Wizard'))

/** The roles whose signature counts towards the quorum: both see compliance work. */
const AUTHORISING = ROLE.ADMIN | ROLE.COMPLIANCE

export interface Screen {
  /** The absolute path. Matches what is in `<Route path>`. */
  path: string
  /** The name in navigation. A noun, as in the policy, not a verb. */
  label: string
  /**
   * The role mask any bit of which opens the screen.
   *
   * `ROLE_ALL` is "any known role": the session mask is never empty
   * (`roleMaskSchema` requires ≥ 1 bit), so no separate "for everyone" value
   * is needed, and the access rule stays one expression for the whole app.
   */
  requires: number
  element: ReactElement
}

export const SCREENS: readonly Screen[] = [
  {
    path: '/console',
    label: 'This issuer',
    requires: ROLE_ALL,
    element: <Overview />,
  },
  {
    path: '/console/journal',
    label: 'The journal',
    requires: ROLE_ALL,
    element: (
      <Stub task="T032" what="Export of the journal as NDJSON, and the live feed behind it" />
    ),
  },
  {
    path: '/console/holders',
    label: 'Holders',
    requires: AUTHORISING,
    element: (
      <Stub
        task="T022"
        what="The queue of accounts awaiting unblock, and this issuer’s own register of statuses"
      />
    ),
  },
  {
    path: '/console/actions',
    label: 'Compliance actions',
    requires: AUTHORISING,
    element: (
      <Stub
        task="T034"
        what="A case, its reason code, and the quorum of signatures it still needs"
      />
    ),
  },
  {
    path: '/issue',
    label: 'Issue a token',
    requires: ROLE.ADMIN,
    element: (
      <Suspense fallback={<p className="muted py-8 text-[13px]">Opening the wizard…</p>}>
        <Wizard />
      </Suspense>
    ),
  },
  {
    path: '/mint',
    label: 'Issuance',
    requires: ROLE.ADMIN,
    element: (
      <Stub
        task="T043"
        what="Minting against the attested reserve: the ceiling, the fee and the full amount as separate numbers"
      />
    ),
  },
  {
    path: '/attest',
    label: 'Reserve attestation',
    requires: ROLE.ATTESTOR,
    element: <Stub task="T040" what="Publishing a reserve attestation for this token" />,
  },
  {
    path: '/settings/delegation',
    label: 'The operational key',
    requires: ROLE.ADMIN,
    element: (
      <Stub
        task="T035"
        what="What this issuer has delegated to the platform’s operational key, and revoking any of it in one action"
      />
    ),
  },
]

/** Whether the role mask opens this screen. One rule for the whole app. */
export function permits(roles: number, screen: Screen): boolean {
  return (roles & screen.requires) !== 0
}

/** The screens available to this mask, in registry order. */
export function screensFor(roles: number): Screen[] {
  return SCREENS.filter((screen) => permits(roles, screen))
}

/** The screen at an exact path. `undefined` means "no such path" — a 404. */
export function screenAt(path: string): Screen | undefined {
  return SCREENS.find((screen) => screen.path === path)
}

/**
 * The first available screen — where the root leads.
 *
 * `undefined` is impossible for a valid session (`/console` is open to any
 * role), but the type does not know that, and a silent `!` here would be the
 * worst place for an assumption.
 */
export function landingFor(roles: number): Screen | undefined {
  return screensFor(roles)[0]
}

/** The names of the roles any of which opens the screen. For the refusal screen. */
export function rolesOpening(screen: Screen): RoleName[] {
  return roleNames(screen.requires)
}
