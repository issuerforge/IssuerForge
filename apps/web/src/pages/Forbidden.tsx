// The role does not open this screen.
//
// Not a 404 and not a silent redirect. The screen exists, and saying "no such
// page" in a product whose essence is a named refusal reason would be the
// same as refusing a transfer without a rule code. So here stands both what
// is missing and what is open instead.
import { roleNames } from '@forge/shared/api'
import { Link } from 'react-router-dom'
import { rolesOpening, type Screen, screensFor } from '@/console/screens'

export default function Forbidden({ screen, roles }: { screen: Screen; roles: number }) {
  const needed = rolesOpening(screen)
  const held = roleNames(roles)
  const open = screensFor(roles)

  return (
    <div className="max-w-[620px] py-10">
      <h1 className="section-head block">This screen is not yours to open</h1>

      <p className="mt-5 text-[13px] leading-relaxed">
        <span className="font-medium">{screen.label}</span> needs{' '}
        {needed.length === 1 ? 'the role' : 'one of the roles'}{' '}
        <span className="num">{needed.join(', ').toLowerCase()}</span>. At this issuer you hold{' '}
        <span className="num">{held.join(', ').toLowerCase()}</span>.
      </p>

      <p className="muted mt-5 text-[12px] leading-relaxed">
        Roles are held by wallet address and changed by a quorum of this issuer’s wallets. Signing
        in again with another method will not change what you hold.
      </p>

      <div className="mt-8 border-t border-hairline pt-5">
        <h2 className="smallcaps muted">Open to you</h2>
        <ul className="mt-3">
          {open.map((other) => (
            <li key={other.path} className="border-b border-hairline py-2">
              <Link to={other.path} className="btn-plain">
                {other.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
