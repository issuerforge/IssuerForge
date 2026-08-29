import { Link } from 'react-router-dom'
import { usePolicy } from '@/lib/policy'

export const STEPS = [
  { n: 1, label: 'Token', path: '/' },
  { n: 2, label: 'Who may hold', path: '/who-may-hold' },
  { n: 3, label: 'Limits', path: '/limits' },
  { n: 4, label: 'Powers', path: '/powers' },
  { n: 5, label: 'Review', path: '/review' },
]

export default function StepRail({ current }: { current: number }) {
  const { maxStep } = usePolicy()

  return (
    <nav className="border-b border-hairline">
      <ul className="mx-auto flex max-w-[1180px] flex-wrap items-center gap-x-5 gap-y-1 px-5 py-3 sm:gap-x-7">
        {STEPS.map((step, i) => {
          const isCurrent = step.n === current
          const reached = step.n <= maxStep
          return (
            <li key={step.n} className="flex items-center gap-x-5 sm:gap-x-7">
              <Link
                to={step.path}
                className="smallcaps inline-block pb-[3px]"
                style={{
                  color: isCurrent || reached ? 'var(--ink)' : 'var(--ink-muted)',
                  borderBottom: isCurrent ? '2px solid var(--ink)' : '2px solid transparent',
                }}
              >
                <span className="num mr-2">{step.n}</span>
                {step.label}
              </Link>
              {i < STEPS.length - 1 && (
                <span className="muted hidden text-[11px] sm:inline">·</span>
              )}
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
