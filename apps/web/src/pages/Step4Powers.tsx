import { Link } from 'react-router-dom'
import { Block, Segmented, Tick, Toggle } from '@/components/controls'
import WizardLayout from '@/components/WizardLayout'
import { QUORUM_PARTIES, usePolicy } from '@/lib/policy'

export default function Step4Powers() {
  const { policy, set } = usePolicy()

  return (
    <WizardLayout
      step={4}
      title="Powers"
      footer={
        <Link to="/review" className="btn-primary">
          Continue to 5 review
        </Link>
      }
    >
      <Block heading="Powers held over this token">
        <Toggle
          label="Freeze an account"
          description="A compliance officer can stop one account from sending or receiving."
          checked={policy.freeze}
          onChange={(v) => set('freeze', v)}
        />
        <Toggle
          label="Seize funds"
          description="Funds can be taken from a named account without that holder’s signature."
          checked={policy.seize}
          onChange={(v) => set('seize', v)}
        />
        <Toggle
          label="Pause all transfers"
          description="Every transfer of this token stops at once until the pause is lifted."
          checked={policy.pause}
          onChange={(v) => set('pause', v)}
        />
      </Block>

      <Block heading="Quorum for actions that touch money">
        <Segmented
          label="Signatures required"
          value={policy.quorumN}
          onChange={(v) => set('quorumN', v)}
          options={[
            { value: 1, label: '1 of 4' },
            { value: 2, label: '2 of 4' },
            { value: 3, label: '3 of 4' },
            { value: 4, label: '4 of 4' },
          ]}
        />
        <ul className="mt-1">
          {QUORUM_PARTIES.map((party) => (
            <li
              key={party.initials}
              className="grid grid-cols-[1fr_auto] items-baseline border-b border-hairline py-2"
            >
              <span className="text-[13px]">{party.role}</span>
              <span className="num text-[13px]">{party.initials}</span>
            </li>
          ))}
        </ul>
        <p className="muted mt-3 text-[12px] leading-relaxed">
          Issuance, seizure, pause and any change to these rules need two signatures. One signature
          is a proposal and has no effect.
        </p>
      </Block>

      <Block heading="Reserve attestor">
        <div className="grid grid-cols-[1fr_auto] items-baseline border-b border-hairline py-2">
          <span className="text-[13px]">Attestor</span>
          <span className="num text-[13px]">external</span>
        </div>
        <p className="muted mt-3 text-[12px] leading-relaxed">
          This key can publish reserve attestations and do nothing else.
        </p>
      </Block>

      <Block heading="Delegated to the platform’s operational key">
        <Tick checked={policy.delegatedUnblock} onChange={(v) => set('delegatedUnblock', v)}>
          Unblock accounts
        </Tick>
        <Tick checked={policy.delegatedRegister} onChange={(v) => set('delegatedRegister', v)}>
          Update this issuer’s own register
        </Tick>
        <Tick
          checked={policy.delegatedRedemptions}
          onChange={(v) => set('delegatedRedemptions', v)}
        >
          Settle redemptions
        </Tick>
        <p className="mt-4 border-t border-hairline pt-3 text-[13px] leading-relaxed">
          This key can never issue tokens, move a holder’s funds, pause transfers or change the
          rules — those are refused by the token itself, not by a setting.
        </p>
      </Block>
    </WizardLayout>
  )
}
