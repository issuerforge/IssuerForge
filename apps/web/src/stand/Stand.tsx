// The dev stand: the officer's real screens on an in-memory api, with no login
// provider and no node (`fake.ts`).
//
// Mounted by `main.tsx` only under `vite dev` with `VITE_STAND=1`, and loaded
// with a dynamic import behind `import.meta.env.DEV` — a production build
// drops it with the branch. It exists so a screen can be looked at, at 1280
// and at 375, before anyone signs in: the gate checks modules, not screens.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useMemo, useRef, useState } from 'react'
import { Navigate, NavLink, Route, Routes } from 'react-router-dom'
import { ProvideSession } from '@/auth/guards'
import { ProvideApi } from '@/auth/providers'
import ActionsScreen from '@/compliance/ActionsScreen'
import ProposalScreen from '@/compliance/ProposalScreen'
import { ProvideSubmitter } from '@/compliance/submit'
import DelegationScreen from '@/settings/delegation'
import { createStand, ISSUER, SESSIONS } from './fake'

type As = keyof typeof SESSIONS

export default function Stand() {
  const [as, setAs] = useState<As>('officer')
  // One memory for the whole visit: switching the role must keep what the
  // other role signed, or the second signature has nothing to land on.
  const current = useRef(as)
  current.current = as
  const stand = useMemo(() => createStand(() => SESSIONS[current.current].wallets[0] ?? ''), [])
  const queries = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } }),
    [],
  )

  return (
    <QueryClientProvider client={queries}>
      <ProvideApi api={stand.api} issuerId={ISSUER}>
        <ProvideSubmitter value={stand.submitter}>
          {/* Keyed by the role: a new session is a new console, not a re-render. */}
          <ProvideSession key={as} session={SESSIONS[as]}>
            <div className="min-h-screen">
              <header className="border-b border-hairline">
                <div className="mx-auto flex max-w-[1180px] flex-wrap items-baseline justify-between gap-x-6 gap-y-2 px-5 py-4">
                  <span className="flex flex-wrap items-baseline gap-x-5">
                    <span className="smallcaps">IssuerForge · dev stand</span>
                    <NavLink to="/console/actions" className="btn-plain muted">
                      Compliance actions
                    </NavLink>
                    <NavLink to="/settings/delegation" className="btn-plain muted">
                      The operational key
                    </NavLink>
                  </span>
                  <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
                    {(Object.keys(SESSIONS) as As[]).map((role) => (
                      <button
                        key={role}
                        type="button"
                        className="btn-plain"
                        style={{ color: role === as ? 'var(--ink)' : 'var(--ink-muted)' }}
                        onClick={() => {
                          setAs(role)
                          void queries.invalidateQueries()
                        }}
                      >
                        as {role}
                      </button>
                    ))}
                  </div>
                </div>
              </header>
              <main className="mx-auto max-w-[1180px] px-5 pb-16">
                <Routes>
                  <Route path="/console/actions" element={<ActionsScreen />} />
                  <Route path="/console/actions/:id" element={<ProposalScreen />} />
                  <Route path="/settings/delegation" element={<DelegationScreen />} />
                  <Route path="*" element={<Navigate to="/console/actions" replace />} />
                </Routes>
              </main>
              <footer className="border-t border-hairline">
                <div className="mx-auto max-w-[1180px] px-5 py-4">
                  <p className="mono12 muted">
                    Dev stand · the api answers from memory, nothing is signed or sent · every
                    address is a placeholder
                  </p>
                </div>
              </footer>
            </div>
          </ProvideSession>
        </ProvideSubmitter>
      </ProvideApi>
    </QueryClientProvider>
  )
}
