// What the console knows about you — and where from.
//
// Not a stub: until live token data arrives (T031, T034) this is the only
// screen where the whole chain "wallet → issuer membership → role → set of
// screens" is visible in full. It stays afterwards too — in a compliance
// product the question "why do I see exactly this" must have a screen with
// the answer, not a verbal explanation.
import { ROLE_NAMES, roleNames } from '@forge/shared/api'
import { useConsoleSession } from '@/auth/guards'
import { truncate } from '@/lib/format'
import { screensFor } from './screens'

export default function Overview() {
  const session = useConsoleSession()
  const held = roleNames(session.roles)
  const membership = session.memberships.find((m) => m.issuerId === session.issuerId)
  const open = screensFor(session.roles)

  return (
    <div className="py-8">
      <h1 className="section-head block">What this console knows about you</h1>

      <dl className="mt-6 grid grid-cols-1 border-b border-hairline sm:grid-cols-2">
        <div className="border-b border-hairline py-4 sm:border-r sm:pr-6">
          <dt className="smallcaps muted">Issuer</dt>
          <dd className="mono12 mt-2 break-all">{session.issuerId}</dd>
        </div>
        <div className="border-b border-hairline py-4 sm:pl-6">
          <dt className="smallcaps muted">Roster last read</dt>
          <dd className="mono12 mt-2">
            {membership ? new Date(membership.syncedAt).toISOString() : '—'}
          </dd>
        </div>
      </dl>

      <section className="py-8">
        <h2 className="section-head block">Your roles at this issuer</h2>
        <ul className="mt-3">
          {ROLE_NAMES.map((name) => {
            const has = held.includes(name)
            return (
              <li
                key={name}
                className="flex items-baseline justify-between border-b border-hairline py-2"
                style={{ color: has ? 'var(--ink)' : 'var(--ink-muted)' }}
              >
                <span className="smallcaps">{name.toLowerCase()}</span>
                <span className="mono12">{has ? 'held' : '—'}</span>
              </li>
            )
          })}
        </ul>
        <p className="muted mt-3 text-[12px] leading-relaxed">
          A role follows the wallet address that stands in this issuer’s on-chain roster, not the
          account you signed in with. The server reads it; this screen only shows it.
        </p>
      </section>

      <section className="border-t border-hairline py-8">
        <h2 className="section-head block">Addresses this session proved</h2>
        <ul className="mt-3">
          {session.wallets.map((wallet) => {
            const counts = membership?.wallets.includes(wallet) === true
            return (
              <li
                key={wallet}
                className="grid grid-cols-[1fr_auto] items-baseline gap-4 border-b border-hairline py-2"
              >
                <span className="mono12 break-all">{wallet}</span>
                <span className="mono12 muted">
                  {counts ? 'in the roster' : 'not in the roster'}
                </span>
              </li>
            )
          })}
          {session.wallets.length === 0 && (
            <li className="muted py-2 text-[12px]">No confirmed Solana address on this account.</li>
          )}
        </ul>
      </section>

      <section className="border-t border-hairline py-8">
        <h2 className="section-head block">Screens your role opens</h2>
        <ul className="mt-3">
          {open.map((screen) => (
            <li
              key={screen.path}
              className="grid grid-cols-[1fr_auto] items-baseline gap-4 border-b border-hairline py-2"
            >
              <span className="text-[13px]">{screen.label}</span>
              <span className="mono12 muted">{screen.path}</span>
            </li>
          ))}
        </ul>
      </section>

      {session.memberships.length > 1 && (
        <section className="border-t border-hairline py-8">
          <h2 className="section-head block">Your other issuers</h2>
          <ul className="mt-3">
            {session.memberships
              .filter((m) => m.issuerId !== session.issuerId)
              .map((m) => (
                <li
                  key={m.issuerId}
                  className="grid grid-cols-[1fr_auto] items-baseline gap-4 border-b border-hairline py-2"
                >
                  <span className="mono12 break-all">{truncate(m.issuerId)}</span>
                  <span className="mono12 muted">
                    {roleNames(m.roles).join(' · ').toLowerCase()}
                  </span>
                </li>
              ))}
          </ul>
          <p className="muted mt-3 text-[12px] leading-relaxed">
            Nothing from one issuer is readable under another. Switching is a separate session, read
            again from that issuer’s roster.
          </p>
        </section>
      )}
    </div>
  )
}
