import { Link } from 'react-router-dom'
import { Block } from '@/components/controls'
import { usePolicy } from './policy'
import WizardLayout from './WizardLayout'

function AmountField({
  label,
  value,
  onChange,
  unit,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  unit: string
}) {
  return (
    <label className="grid grid-cols-1 items-baseline gap-x-6 gap-y-1 border-b border-hairline py-3 sm:grid-cols-[16rem_1fr]">
      <span className="text-[13px]">{label}</span>
      <span className="flex items-baseline justify-end gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="num max-w-[13rem] text-right text-[14px]"
          spellCheck={false}
        />
        <span className="num text-[13px]">{unit}</span>
      </span>
    </label>
  )
}

export default function Step3Limits() {
  const { policy, set } = usePolicy()
  const unit = policy.symbol || 'vNGN'
  const total = policy.blockedVisible.length + policy.blockedHidden

  return (
    <WizardLayout
      step={3}
      title="Limits"
      footer={
        <Link to="/prototype/powers" className="btn-primary">
          Continue to 4 powers
        </Link>
      }
    >
      <Block heading="Transfer limits">
        <AmountField
          label="Maximum single transfer"
          value={policy.maxSingle}
          onChange={(v) => set('maxSingle', v)}
          unit={unit}
        />
        <AmountField
          label="Maximum per holder per 24 hours"
          value={policy.maxDaily}
          onChange={(v) => set('maxDaily', v)}
          unit={unit}
        />
        <p className="muted mt-3 text-[12px] leading-relaxed">
          The 24-hour counter is kept on the sender’s account and read on every transfer.
        </p>
      </Block>

      <Block heading={`Blocked addresses (${total})`}>
        <ul>
          {policy.blockedVisible.map((entry) => (
            <li
              key={entry.address}
              className="grid grid-cols-1 items-baseline gap-x-4 gap-y-1 border-b border-hairline py-3 sm:grid-cols-[1fr_auto_auto]"
            >
              <span className="mono12 break-all">{entry.address}</span>
              <span className="mono12 sm:text-right">{entry.reason}</span>
              <button
                type="button"
                className="btn-plain refuse justify-self-start sm:justify-self-end"
                onClick={() =>
                  set(
                    'blockedVisible',
                    policy.blockedVisible.filter((b) => b.address !== entry.address),
                  )
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        {policy.blockedHidden > 0 && (
          <p className="muted mt-3 text-[12px]">
            and <span className="num">{policy.blockedHidden}</span> more
          </p>
        )}
        {total === 0 && <p className="muted mt-3 text-[12px]">The register is empty.</p>}
      </Block>
    </WizardLayout>
  )
}
