// Route guards: login, tenant, role.
//
// The state "a screen drew without a session" does not exist — just as it
// does not on the api side (`requireSession` there either puts the session
// into the context or does not let execution through). The components below
// either show the session or show what is missing.
import type { Session } from '@forge/shared/api'
import { usePrivy } from '@privy-io/react-auth'
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { ApiRequestError } from '@/api/client'
import { useSession } from '@/api/session'
import { permits, type Screen } from '@/console/screens'
import Forbidden from '@/pages/Forbidden'
import Notice from '@/pages/Notice'
import PickIssuer from '@/pages/PickIssuer'
import SignIn from '@/pages/SignIn'
import { useTenant } from './providers'
import { resolveTenant } from './tenant'

const SessionContext = createContext<Session | null>(null)

/**
 * How long to wait for the login provider before saying it did not answer.
 *
 * This is not about a slow network: `ready` never becomes true if
 * `VITE_PRIVY_APP_ID` is syntactically valid but no such app exists — and
 * that is exactly the deployment mistake `readWebEnv` does not see. Without
 * a limit the console shows "opening" forever, and the cause stays in the
 * network panel.
 */
const READY_TIMEOUT_MS = 10_000

function useReadyTimedOut(ready: boolean): boolean {
  const [timedOut, setTimedOut] = useState(false)

  useEffect(() => {
    if (ready) return
    const timer = setTimeout(() => setTimedOut(true), READY_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [ready])

  return timedOut && !ready
}

/** The session inside the guard. There is nowhere to call it from outside — and it must not be. */
export function useConsoleSession(): Session {
  const session = useContext(SessionContext)
  if (!session) throw new Error('useConsoleSession must be used inside RequireSession')
  return session
}

/**
 * The list of issuers the api named in `details.issuerIds` when the header
 * is not chosen or names an issuer outside the membership.
 *
 * There is deliberately no separate "my issuers" handler: the server has
 * already said what to choose from, and a second request for the same list
 * would be a second source of truth about memberships.
 */
function offeredIssuers(error: unknown): string[] | undefined {
  if (!(error instanceof ApiRequestError) || error.code !== 'INVALID_INPUT') return undefined
  const offered = error.details?.issuerIds
  if (!Array.isArray(offered)) return undefined
  const ids = offered.filter((id): id is string => typeof id === 'string')
  return ids.length > 0 ? ids : undefined
}

export function RequireSession() {
  const { ready, authenticated } = usePrivy()
  const { issuerId, select } = useTenant()
  const session = useSession()
  const [dropped, setDropped] = useState<string | undefined>(undefined)
  const loginUnreachable = useReadyTimedOut(ready)

  // The set of issuers known to this response: either from a successful
  // session or from the list the api named in the refusal. Both sources are
  // the same server.
  const known = session.data?.memberships.map((m) => m.issuerId) ?? offeredIssuers(session.error)
  // A string, not an array: a new array on every render would loop the effect.
  const knownKey = known?.join(',')

  useEffect(() => {
    if (knownKey === undefined) return
    const resolved = resolveTenant(knownKey === '' ? [] : knownKey.split(','), issuerId)
    // A role is revoked by quorum, and the stored choice outlives that. It
    // must be said once and out loud: otherwise the person sees a list of
    // issuers with no explanation of why they were thrown out of what was
    // open yesterday.
    if (resolved.dropped !== undefined) setDropped(resolved.dropped)
    if (resolved.issuerId !== issuerId) select(resolved.issuerId)
  }, [knownKey, issuerId, select])

  if (!ready) {
    return loginUnreachable ? (
      <Notice
        title="The login provider did not answer"
        body="The console could not reach Privy. Either this build carries an app id that no longer exists, or the provider is unreachable from here. Both are deployment problems, not something signing in again can fix."
      />
    ) : (
      <Notice title="Opening the console" />
    )
  }
  if (!authenticated) return <SignIn />
  if (session.isPending) return <Notice title="Reading your role" />

  if (session.error) {
    const issuerIds = offeredIssuers(session.error)
    if (issuerIds) {
      return (
        <PickIssuer
          issuerIds={issuerIds}
          dropped={dropped}
          onPick={(picked) => {
            setDropped(undefined)
            select(picked)
          }}
        />
      )
    }

    const problem = session.error instanceof ApiRequestError ? session.error : undefined

    // `UNAUTHORIZED` here does not mean "bad token" but "this address is in no
    // issuer's membership": the token is already verified, otherwise there
    // would be no login. Suggesting to log in again would be advice that
    // changes nothing.
    if (problem?.code === 'UNAUTHORIZED') {
      return (
        <Notice
          title="No issuer lists this wallet"
          body="Access to a console follows the wallet address that stands in an issuer’s roster, not the account you signed in with. Ask an administrator of that issuer to add this address."
          requestId={problem.requestId}
          signOut
        />
      )
    }

    return (
      <Notice
        title="The console could not read your role"
        body={problem?.message ?? 'Unexpected failure.'}
        requestId={problem?.requestId}
        signOut
      />
    )
  }

  return (
    <SessionContext.Provider value={session.data}>
      <Outlet />
    </SessionContext.Provider>
  )
}

/** The role does not open the screen — we say so, rather than showing a 404 or redirecting. */
export function RequireScreen({ screen, children }: { screen: Screen; children: ReactNode }) {
  const session = useConsoleSession()
  if (!permits(session.roles, screen)) return <Forbidden screen={screen} roles={session.roles} />
  return <>{children}</>
}
