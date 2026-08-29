import type { ReactNode } from 'react'

export function Field({
  label,
  value,
  onChange,
  mono = false,
  hint,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  mono?: boolean
  hint?: string
}) {
  return (
    <label className="grid grid-cols-1 items-baseline gap-x-6 gap-y-1 border-b border-hairline py-3 sm:grid-cols-[13rem_1fr]">
      <span className="smallcaps muted">{label}</span>
      <span>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={mono ? 'num text-right text-[14px]' : 'text-[14px]'}
          spellCheck={false}
        />
        {hint && <span className="muted mt-1 block text-[12px]">{hint}</span>}
      </span>
    </label>
  )
}

export function Tick({
  checked,
  onChange,
  children,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-start gap-3 border-b border-hairline py-3 text-left last:border-b-0"
      aria-pressed={checked}
    >
      <span className="tick">{checked && <span />}</span>
      <span className="text-[13px] leading-relaxed">{children}</span>
    </button>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  description?: string
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="grid w-full grid-cols-[1fr_auto] items-start gap-4 border-b border-hairline py-3 text-left"
      aria-pressed={checked}
    >
      <span>
        <span className="block text-[13px]">{label}</span>
        {description && (
          <span className="muted mt-1 block text-[12px] leading-relaxed">{description}</span>
        )}
      </span>
      <span className="mono12 flex items-center gap-2 pt-[2px]">
        <span className="tick !mt-0">{checked && <span />}</span>
        <span style={{ color: checked ? 'var(--ink)' : 'var(--ink-muted)' }}>
          {checked ? 'on' : 'off'}
        </span>
      </span>
    </button>
  )
}

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
  label?: string
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline py-3">
      {label && <span className="text-[13px]">{label}</span>}
      <div className="flex border border-hairline">
        {options.map((opt) => {
          const active = opt.value === value
          return (
            <button
              key={String(opt.value)}
              type="button"
              onClick={() => onChange(opt.value)}
              className="num border-r border-hairline px-4 py-[6px] text-[13px] last:border-r-0"
              style={{
                background: active ? 'var(--ink)' : 'transparent',
                color: active ? 'var(--ground)' : 'var(--ink-muted)',
              }}
            >
              {opt.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function Chip({
  label,
  selected,
  onClick,
}: {
  label: string
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="num border border-hairline px-3 py-[5px] text-[13px]"
      style={{
        background: selected ? 'var(--ink)' : 'transparent',
        color: selected ? 'var(--ground)' : 'var(--ink-muted)',
        borderColor: selected ? 'var(--ink)' : 'var(--hairline)',
      }}
      aria-pressed={selected}
    >
      {label}
    </button>
  )
}

export function Block({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section className="mt-9">
      <h2 className="section-head block">{heading}</h2>
      <div className="mt-3">{children}</div>
    </section>
  )
}
