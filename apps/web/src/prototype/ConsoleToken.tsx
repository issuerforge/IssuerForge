import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AWAITING_UNBLOCK, FEED, FINGERPRINT, REFUSALS_BY_CLAUSE } from './data'

const FIGURES = [
  { label: 'In circulation', value: '25,000,000.00 vNGN', note: '' },
  { label: 'Attested reserve', value: '25,400,000.00 NGN', note: 'attestation 3 h 12 min old' },
  { label: 'Holders', value: '1,284', note: '' },
  { label: 'Awaiting unblock', value: '37', note: '' },
  { label: 'Refused today', value: '63', note: '' },
]

export default function ConsoleToken() {
  const [pending, setPending] = useState(AWAITING_UNBLOCK)
  const [awaitingCount, setAwaitingCount] = useState(37)

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [])

  const unblock = (address: string) => {
    setPending((rows) => rows.filter((r) => r.address !== address))
    setAwaitingCount((c) => Math.max(0, c - 1))
  }

  const unblockAll = () => {
    setAwaitingCount((c) => Math.max(0, c - pending.length))
    setPending([])
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-hairline">
        <div className="mx-auto flex max-w-[1180px] flex-wrap items-baseline justify-between gap-2 px-5 py-4">
          <span className="smallcaps">IssuerForge · compliance console</span>
          <nav className="flex gap-5">
            <Link to="/prototype/review" className="btn-plain muted">
              The policy
            </Link>
            <Link to="/prototype/console/case/REG-2026-0412" className="btn-plain muted">
              Case REG-2026-0412
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-[1180px] px-5 pb-16">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-hairline py-6">
          <h1 className="text-[18px] font-medium">
            Vantara Naira <span className="num text-[14px]">vNGN</span>
          </h1>
          <span className="mono12 muted break-all">{FINGERPRINT}</span>
        </div>

        <ul className="grid grid-cols-1 border-b border-hairline sm:grid-cols-2 lg:grid-cols-5">
          {FIGURES.map((figure) => (
            <li
              key={figure.label}
              className="border-b border-hairline py-5 last:border-b-0 sm:border-r sm:pr-5 lg:last:border-r-0 lg:border-b-0"
            >
              <div className="num text-[19px] leading-tight">{figure.value}</div>
              <div className="smallcaps muted mt-2">{figure.label}</div>
              {figure.note && <div className="mono12 muted mt-1">{figure.note}</div>}
            </li>
          ))}
        </ul>

        <div className="grid grid-cols-1 lg:grid-cols-2">
          <section className="py-8 lg:pr-10">
            <h2 className="section-head block">Refusals today, by clause</h2>
            <ul className="mt-3">
              {REFUSALS_BY_CLAUSE.map((row) => (
                <li
                  key={row.clause}
                  className="grid grid-cols-[2.6rem_1fr_auto] items-baseline border-b border-hairline py-2"
                >
                  <span className="mono12">{row.clause}</span>
                  <span className="text-[13px]">{row.name}</span>
                  <span className="num text-right text-[13px]">{row.count}</span>
                </li>
              ))}
            </ul>
            <p className="muted mt-3 text-[12px] leading-relaxed">
              A refusal is named by the clause that caused it. The clause numbers are the ones in
              the policy.
            </p>
          </section>

          <section className="border-t border-hairline py-8 lg:border-l lg:border-t-0 lg:pl-10">
            <h2 className="section-head block">The feed</h2>
            <ul className="mt-3">
              {FEED.map((event) => {
                const body = (
                  <>
                    <span className="mono12">{event.time}</span>
                    <span className="text-[13px]">
                      {event.event}
                      {event.clause && <span className="num ml-2">{event.clause}</span>}
                    </span>
                    <span className="num text-[12px] md:text-right">{event.amount ?? ''}</span>
                    <span className="mono12 truncate md:text-right">
                      {event.counterparty
                        ? event.counterparty.length > 20
                          ? `${event.counterparty.slice(0, 8)}…${event.counterparty.slice(-4)}`
                          : event.counterparty
                        : ''}
                    </span>
                  </>
                )
                const cls =
                  'grid grid-cols-[3.2rem_1fr] items-baseline gap-x-4 gap-y-1 border-b border-hairline py-2 md:grid-cols-[3.2rem_1fr_8rem_8rem]'
                return (
                  <li
                    key={event.id}
                    style={{ color: event.refused ? 'var(--refuse)' : 'var(--ink)' }}
                  >
                    {event.caseLink ? (
                      <Link
                        to="/prototype/console/case/REG-2026-0412"
                        className={`${cls} w-full text-left`}
                      >
                        {body}
                      </Link>
                    ) : (
                      <div className={cls}>{body}</div>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        </div>

        <section className="border-t border-hairline pt-8">
          <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-hairline pb-2">
            <h2 className="smallcaps">
              Awaiting unblock (<span className="num">{awaitingCount}</span>)
            </h2>
            {pending.length > 0 && (
              <button type="button" className="btn-plain" onClick={unblockAll}>
                Unblock all {pending.length === 4 ? 'four' : pending.length}
              </button>
            )}
          </div>
          <ul className="mt-1">
            {pending.map((row) => (
              <li
                key={row.address}
                className="grid grid-cols-1 items-baseline gap-x-6 gap-y-1 border-b border-hairline py-3 md:grid-cols-[1fr_5rem_4rem_7rem_5rem]"
              >
                <span className="mono12 break-all">{row.address}</span>
                <span className="num text-[12px] md:text-right">{row.tier}</span>
                <span className="num text-[12px] md:text-right">{row.jurisdiction}</span>
                <span className="num text-[12px] md:text-right">{row.waiting}</span>
                <button
                  type="button"
                  className="btn-plain justify-self-start md:justify-self-end"
                  onClick={() => unblock(row.address)}
                >
                  Unblock
                </button>
              </li>
            ))}
            {pending.length === 0 && (
              <li className="muted py-3 text-[12px]">
                No account in this view is waiting. <span className="num">{awaitingCount}</span>{' '}
                remain in the full register.
              </li>
            )}
          </ul>
        </section>
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
