import { Link } from 'react-router-dom'
import { Block, Chip, Segmented, Toggle } from '@/components/controls'
import WizardLayout from '@/components/WizardLayout'
import { ALL_JURISDICTIONS, usePolicy } from '@/lib/policy'

export default function Step2Holders() {
  const { policy, set } = usePolicy()

  const toggleJurisdiction = (code: string) => {
    const next = policy.jurisdictions.includes(code)
      ? policy.jurisdictions.filter((c) => c !== code)
      : [...ALL_JURISDICTIONS.filter((c) => policy.jurisdictions.includes(c) || c === code)]
    set('jurisdictions', next)
  }

  return (
    <WizardLayout
      step={2}
      title="Who may hold"
      footer={
        <Link to="/limits" className="btn-primary">
          Continue to 3 limits
        </Link>
      }
    >
      <Block heading="Sources of verification">
        <Toggle
          label="Attestations from an external verification provider"
          checked={policy.sourceProvider}
          onChange={(v) => set('sourceProvider', v)}
        />
        <Toggle
          label="This issuer’s own register"
          checked={policy.sourceRegister}
          onChange={(v) => set('sourceRegister', v)}
        />
        <p className="muted mt-3 text-[12px] leading-relaxed">
          Where the two disagree, the stricter answer applies. This issuer’s register can narrow the
          circle, never widen it.
        </p>
      </Block>

      <Block heading="Minimum verification tier">
        <Segmented
          label="A holder must be verified at this tier or above"
          value={policy.minTier}
          onChange={(v) => set('minTier', v)}
          options={[
            { value: 1, label: '1' },
            { value: 2, label: '2' },
            { value: 3, label: '3' },
          ]}
        />
      </Block>

      <Block heading="Jurisdictions allowed to hold">
        <div className="flex flex-wrap gap-2 pb-3">
          {ALL_JURISDICTIONS.map((code) => (
            <Chip
              key={code}
              label={code}
              selected={policy.jurisdictions.includes(code)}
              onClick={() => toggleJurisdiction(code)}
            />
          ))}
        </div>
        <p className="muted border-t border-hairline pt-3 text-[12px] leading-relaxed">
          <span className="num">{policy.jurisdictions.length}</span> of{' '}
          <span className="num">{ALL_JURISDICTIONS.length}</span> selected. A holder outside the
          selected set is refused under clause 2.3.
        </p>
      </Block>

      <p className="muted mt-8 border-t border-hairline pt-4 text-[12px] leading-relaxed">
        Accounts start blocked. A holder can receive only after this issuer unblocks their account,
        and every transfer is still checked against the rules.
      </p>
    </WizardLayout>
  )
}
