import { Link } from 'react-router-dom'
import { Block, Field, Tick } from '@/components/controls'
import { usePolicy } from './policy'
import WizardLayout from './WizardLayout'

export default function Step1Token() {
  const { policy, set } = usePolicy()
  const ready = policy.ackSymbol && policy.ackDecimals && policy.ackPolicy

  return (
    <WizardLayout
      step={1}
      title="Token"
      footer={
        ready ? (
          <Link to="/prototype/who-may-hold" className="btn-primary">
            Continue to 2 who may hold
          </Link>
        ) : (
          <button type="button" className="btn-primary" disabled>
            Continue to 2 who may hold
          </button>
        )
      }
    >
      <Field label="Token name" value={policy.tokenName} onChange={(v) => set('tokenName', v)} />
      <Field label="Symbol" value={policy.symbol} onChange={(v) => set('symbol', v)} mono />
      <Field label="Decimals" value={policy.decimals} onChange={(v) => set('decimals', v)} mono />
      <Field
        label="Jurisdiction of issue"
        value={policy.jurisdiction}
        onChange={(v) => set('jurisdiction', v)}
      />
      <Field
        label="Initial issuance"
        value={policy.issuance}
        onChange={(v) => set('issuance', v)}
        mono
        hint={`Denominated in ${policy.symbol || 'vNGN'}.`}
      />

      <Block heading="Fixed at issuance">
        <p className="muted mb-2 text-[13px]">
          Three things can never change after the policy is signed. Tick each one to continue.
        </p>
        <Tick checked={policy.ackSymbol} onChange={(v) => set('ackSymbol', v)}>
          The symbol <span className="num">{policy.symbol || '—'}</span> is fixed for the life of
          the token.
        </Tick>
        <Tick checked={policy.ackDecimals} onChange={(v) => set('ackDecimals', v)}>
          The number of decimals, <span className="num">{policy.decimals || '0'}</span>, is fixed
          for the life of the token.
        </Tick>
        <Tick checked={policy.ackPolicy} onChange={(v) => set('ackPolicy', v)}>
          Every transfer is checked against a policy. That check cannot be removed later, only
          rewritten under the quorum set in step 4.
        </Tick>
        {!ready && (
          <p className="muted mt-3 text-[12px]">
            All three must be ticked before this step can continue.
          </p>
        )}
      </Block>
    </WizardLayout>
  )
}
