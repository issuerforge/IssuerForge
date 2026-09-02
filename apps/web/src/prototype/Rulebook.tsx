import { useEffect, useRef, useState } from 'react'
import { type Clause, usePolicy } from './policy'

const STEP_TITLES: Record<number, string> = {
  1: '1 Token',
  2: '2 Who may hold',
  3: '3 Limits',
  4: '4 Powers',
}

type Props = {
  /** clauses belonging to steps after this one are shown muted as defaults */
  reachedThrough?: number
  variant?: 'panel' | 'document'
}

export default function Rulebook({ reachedThrough, variant = 'panel' }: Props) {
  const { clauses, maxStep } = usePolicy()
  const reached = reachedThrough ?? maxStep

  const previous = useRef<Record<string, string>>(
    Object.fromEntries(clauses.map((c) => [c.id, c.text])),
  )
  const [marked, setMarked] = useState<{ ids: string[]; tick: number }>({ ids: [], tick: 0 })

  useEffect(() => {
    const changed = clauses
      .filter((c) => previous.current[c.id] !== undefined && previous.current[c.id] !== c.text)
      .map((c) => c.id)
    previous.current = Object.fromEntries(clauses.map((c) => [c.id, c.text]))
    if (changed.length === 0) return
    setMarked((m) => ({ ids: changed, tick: m.tick + 1 }))
    const timer = window.setTimeout(() => setMarked((m) => ({ ids: [], tick: m.tick })), 900)
    return () => window.clearTimeout(timer)
  }, [clauses])

  const groups = [1, 2, 3, 4].map((step) => ({
    step,
    items: clauses.filter((c) => c.step === step),
  }))

  return (
    <div className={variant === 'panel' ? 'bg-panel' : ''}>
      <div className="flex items-baseline justify-between border-b border-hairline pb-2">
        <h2 className="smallcaps">The rulebook</h2>
        <span className="mono12 muted">Vantara Pay · Lagos, Nigeria</span>
      </div>

      <p className="muted mt-3 max-w-prose text-[13px]">
        {variant === 'document'
          ? 'The finished policy. Every clause below is enforced by the token itself, on every transfer, whatever wallet or program makes it.'
          : 'Clauses for steps you have not reached yet are shown in muted ink. They are the defaults that would apply if you stopped now.'}
      </p>

      <div className="mt-5 pl-4">
        {groups.map((group) => {
          const muted = group.step > reached
          return (
            <section key={group.step} className="mb-6 last:mb-0">
              <h3
                className="section-head block"
                style={{ color: muted ? 'var(--ink-muted)' : 'var(--ink)' }}
              >
                {STEP_TITLES[group.step]}
                {muted ? ' · default' : ''}
              </h3>
              <ol className="mt-2">
                {group.items.map((clause) => (
                  <ClauseRow
                    key={clause.id}
                    clause={clause}
                    muted={muted}
                    marked={marked.ids.includes(clause.id)}
                    tick={marked.tick}
                  />
                ))}
              </ol>
            </section>
          )
        })}
      </div>
    </div>
  )
}

function ClauseRow({
  clause,
  muted,
  marked,
  tick,
}: {
  clause: Clause
  muted: boolean
  marked: boolean
  tick: number
}) {
  return (
    <li
      className="relative grid grid-cols-[2.6rem_1fr] items-start border-b border-hairline py-2 last:border-b-0"
      style={{ color: muted ? 'var(--ink-muted)' : 'var(--ink)' }}
    >
      {marked && <span key={tick} className="marginal-rule" aria-hidden="true" />}
      <span className="mono12 pt-[2px]">{clause.id}</span>
      <span className="text-[13px] leading-relaxed">{clause.text}</span>
    </li>
  )
}
