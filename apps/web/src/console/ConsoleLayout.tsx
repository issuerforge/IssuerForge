// Оболонка консолі: емітент, перемикач орендарів, навігація, вихід.
//
// Навігація будується з реєстру екранів, відфільтрованого маскою ролей із
// сесії. Через це «пункт є, а зайти не можна» неможливе: список у шапці й
// перевірка в ґарді читають один і той самий вираз (`permits`).
import { roleNames } from '@forge/shared/api'
import { usePrivy } from '@privy-io/react-auth'
import { NavLink, Outlet } from 'react-router-dom'
import { useConsoleSession } from '@/auth/guards'
import { useTenant } from '@/auth/providers'
import { truncate } from '@/lib/format'
import { screensFor } from './screens'

function TenantSwitcher() {
  const session = useConsoleSession()
  const { select } = useTenant()

  // Один емітент — перемикача немає взагалі: список з одного пункту навчає
  // натискати на нього дарма.
  if (session.memberships.length < 2) {
    return <span className="mono12 muted break-all">{truncate(session.issuerId)}</span>
  }

  return (
    <label className="flex items-baseline gap-2">
      <span className="smallcaps muted">Issuer</span>
      <select
        className="mono12 bg-transparent"
        value={session.issuerId}
        onChange={(e) => select(e.target.value)}
      >
        {session.memberships.map((membership) => (
          <option key={membership.issuerId} value={membership.issuerId}>
            {truncate(membership.issuerId)}
          </option>
        ))}
      </select>
    </label>
  )
}

export default function ConsoleLayout() {
  const session = useConsoleSession()
  const { logout } = usePrivy()
  const screens = screensFor(session.roles)

  return (
    <div className="min-h-screen">
      <header className="border-b border-hairline">
        <div className="mx-auto flex max-w-[1180px] flex-wrap items-baseline justify-between gap-x-6 gap-y-2 px-5 py-4">
          <span className="smallcaps">IssuerForge · issuer console</span>
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <TenantSwitcher />
            <span className="mono12 muted">
              {roleNames(session.roles).join(' · ').toLowerCase()}
            </span>
            <button type="button" className="btn-plain muted" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </div>
      </header>

      <nav className="border-b border-hairline">
        <ul className="mx-auto flex max-w-[1180px] flex-wrap items-center gap-x-6 gap-y-1 px-5 py-3">
          {screens.map((screen) => (
            <li key={screen.path}>
              <NavLink
                to={screen.path}
                // `end` на кожному пункті: без нього «This issuer» лишався б
                // підсвіченим на всіх дочірніх шляхах `/console/*`.
                end
                className="smallcaps inline-block pb-[3px]"
                style={({ isActive }) => ({
                  color: isActive ? 'var(--ink)' : 'var(--ink-muted)',
                  borderBottom: isActive ? '2px solid var(--ink)' : '2px solid transparent',
                })}
              >
                {screen.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <main className="mx-auto max-w-[1180px] px-5 pb-16">
        <Outlet />
      </main>
    </div>
  )
}
