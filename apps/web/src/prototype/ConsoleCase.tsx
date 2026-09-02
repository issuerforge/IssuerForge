import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { truncate } from '@/lib/format'
import { CASE_ACTIONS } from './data'
import { QUORUM_PARTIES } from './policy'

const DEFINITION = [
  { label: 'Holder', value: 'Vant4raDemo7hQ2nR9wKp5xTbZmYs6LgC8jEuA3fDhR1' },
  { label: 'Balance', value: '180,000.00 vNGN' },
  { label: 'Account state', value: 'frozen 2026-08-20 14:22' },
  { label: 'Reason code', value: 'SANCTIONS-MATCH' },
  { label: 'Case reference', value: 'REG-2026-0412' },
  { label: 'Proposed by', value: 'Compliance · F.B.   2026-08-21 09:15' },
  { label: 'Expires', value: '2026-08-23 09:15' },
]

type Outcome = 'open' | 'signed' | 'rejected'

export default function ConsoleCase() {
  const [outcome, setOutcome] = useState<Outcome>('open')

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [])

  const signatures: Record<string, string | undefined> = {
    'F.B.': '2026-08-21 09:15',
    'A.O.': outcome === 'signed' ? '2026-08-21 11:58' : undefined,
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-hairline">
        <div className="mx-auto flex max-w-[1180px] flex-wrap items-baseline justify-between gap-2 px-5 py-4">
          <span className="smallcaps">IssuerForge · compliance console</span>
          <nav className="flex gap-5">
            <Link to="/prototype/console" className="btn-plain muted">
              Back to the token
            </Link>
            <Link to="/prototype/review" className="btn-plain muted">
              The policy
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-[1180px] px-5 pb-16">
        <h1 className="border-b border-hairline py-6 text-[18px] font-medium">
          Case <span className="num">REG-2026-0412</span> · seizure proposed
        </h1>

        <ul className="mt-6 max-w-[46rem]">
          {DEFINITION.map((row) => (
            <li
              key={row.label}
              className="grid grid-cols-1 items-baseline gap-x-6 gap-y-1 border-b border-hairline py-2 sm:grid-cols-[11rem_1fr]"
            >
              <span className="text-[13px]">{row.label}</span>
              <span className="mono12 break-all sm:text-right">{row.value}</span>
            </li>
          ))}
        </ul>

        <h2 className="section-head mt-12 block">Quorum</h2>
        <p className="mt-3 text-[13px]">
          {outcome === 'signed' ? (
            <>
              <span className="num">2</span> of <span className="num">2</span> signatures. The
              seizure has been submitted for execution by the token.
            </>
          ) : outcome === 'rejected' ? (
            <>The proposal was rejected. Nothing has moved and the case is closed.</>
          ) : (
            <>
              <span className="num">1</span> of <span className="num">2</span> signatures. Until the
              second signature, this is a proposal and nothing has moved.
            </>
          )}
        </p>

        <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 md:max-w-[46rem]">
          {QUORUM_PARTIES.map((party) => {
            const signedAt = signatures[party.initials]
            return (
              <li
                key={party.initials}
                className="border p-3"
                style={{
                  background: signedAt ? 'var(--ink)' : 'transparent',
                  color: signedAt ? 'var(--ground)' : 'var(--ink-muted)',
                  borderColor: signedAt ? 'var(--ink)' : 'var(--hairline)',
                }}
              >
                <div className="smallcaps">{party.role}</div>
                <div className="num mt-1 text-[15px]">{party.initials}</div>
                <div className="mono12 mt-2">{signedAt ?? 'not signed'}</div>
              </li>
            )
          })}
        </ul>

        <div className="mt-8 flex flex-wrap items-center gap-6">
          {outcome === 'open' ? (
            <>
              <button
                type="button"
                className="btn-destructive"
                onClick={() => setOutcome('signed')}
              >
                Sign the seizure
              </button>
              <button type="button" className="btn-plain" onClick={() => setOutcome('rejected')}>
                Reject the proposal
              </button>
            </>
          ) : (
            <button type="button" className="btn-plain" onClick={() => setOutcome('open')}>
              Return the case to open
            </button>
          )}
        </div>
        <p className="muted mt-3 text-[12px]">
          A seizure without a reason code cannot be submitted.
        </p>

        <div className="mt-12 flex flex-wrap items-baseline justify-between gap-3 border-b border-hairline pb-2">
          <h2 className="smallcaps">Actions on this token</h2>
          <button type="button" className="btn-plain">
            Export the journal
          </button>
        </div>
        <p className="muted mt-2 text-[12px]">
          Every row can be checked against the network without trusting this console.
        </p>

        <ul className="mt-3">
          {CASE_ACTIONS.map((row) => (
            <li
              key={row.id}
              className="grid grid-cols-1 items-baseline gap-x-5 gap-y-1 border-b border-hairline py-3 md:grid-cols-[6rem_9rem_9rem_9rem_10rem_7rem]"
            >
              <span className="mono12">{row.date}</span>
              <span className="text-[13px]">{row.action}</span>
              <span className="mono12">
                {row.target === '—' ? '—' : truncate(row.target, 8, 4)}
              </span>
              <span className="num text-[12px] md:text-right">{row.amount}</span>
              <span className="mono12 md:text-right">{row.reason}</span>
              <span className="mono12 md:text-right">{row.signers}</span>
            </li>
          ))}
        </ul>
      </main>

      <footer className="border-t border-hairline">
        <div className="mx-auto max-w-[1180px] px-5 py-4">
          <p className="mono12 muted">
            Prototype · all figures, names and addresses shown are fictional
          </p>
        </div>
      </footer>
    </div>
  )
}
