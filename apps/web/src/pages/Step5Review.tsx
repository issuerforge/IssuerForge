import { useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import Rulebook from '@/components/Rulebook'
import StepRail from '@/components/StepRail'
import { Masthead } from '@/components/WizardLayout'
import {
  CARRIED_RECORDS,
  FINGERPRINT,
  ISSUANCE,
  PLATFORM_FEE,
  SCENARIOS,
  TO_ISSUER,
} from '@/lib/data'
import { fmt } from '@/lib/format'
import { usePolicy } from '@/lib/policy'

function Head({ children }: { children: string }) {
  return <h2 className="section-head mt-12 block">{children}</h2>
}

export default function Step5Review() {
  const { visit } = usePolicy()
  const navigate = useNavigate()

  useEffect(() => {
    visit(5)
    window.scrollTo(0, 0)
  }, [visit])

  return (
    <div className="min-h-screen">
      <Masthead />
      <StepRail current={5} />

      <main className="mx-auto max-w-[1180px] px-5 pb-16">
        <div className="flex items-baseline justify-between border-b border-hairline py-6">
          <h1 className="smallcaps">
            <span className="num mr-2">5</span>Review and issue
          </h1>
          <span className="mono12 muted">step 5 of 5</span>
        </div>

        <div className="mt-8">
          <Rulebook reachedThrough={5} variant="document" />
        </div>

        <Head>Policy fingerprint</Head>
        <p className="num mt-3 break-all text-[15px]">{FINGERPRINT}</p>
        <p className="muted mt-2 text-[12px] leading-relaxed">
          The rules above compile to this fingerprint. It appears on the token and in every future
          change.
        </p>

        <Head>What this issuance costs</Head>
        <ul className="mt-3 max-w-[36rem]">
          {[
            { label: 'Issued', value: ISSUANCE },
            { label: 'To the issuer', value: TO_ISSUER },
            { label: 'Platform fee (12 bps)', value: PLATFORM_FEE },
          ].map((row) => (
            <li
              key={row.label}
              className="grid grid-cols-[1fr_auto] items-baseline border-b border-hairline py-2"
            >
              <span className="text-[13px]">{row.label}</span>
              <span className="num text-right text-[13px]">{fmt(row.value)} vNGN</span>
            </li>
          ))}
        </ul>
        <p className="muted mt-3 text-[12px]">
          Attested reserve <span className="num">25,400,000.00 NGN</span> · published 3 h 12 min ago
        </p>
        <p className="muted mt-1 text-[12px]">
          Headroom after this issuance <span className="num">400,000.00 NGN</span>
        </p>
        <p className="mt-3 text-[13px]">
          Issuance above the attested reserve is refused by the network, not by this screen.
        </p>

        <Head>What these rules will do</Head>
        <ul className="mt-3">
          {SCENARIOS.map((row) => {
            const refused = row.verdict === 'refused'
            return (
              <li
                key={row.scenario}
                className="grid grid-cols-1 items-baseline gap-x-6 gap-y-1 border-b border-hairline py-3 md:grid-cols-[1fr_6rem_3rem_15rem]"
                style={{ color: refused ? 'var(--refuse)' : 'var(--ink)' }}
              >
                <span className="text-[13px]">{row.scenario}</span>
                <span className="text-[13px] md:text-right">{row.verdict}</span>
                <span className="num text-[13px] md:text-right">{row.clause ?? ''}</span>
                <span className="text-[12px] md:text-right">{row.reason ?? ''}</span>
              </li>
            )
          })}
        </ul>

        <Head>What every transfer will carry</Head>
        <ul className="mt-3 max-w-[36rem]">
          {CARRIED_RECORDS.map((record, i) => (
            <li
              key={record}
              className="grid grid-cols-[2.6rem_1fr] items-baseline border-b border-hairline py-2"
            >
              <span className="mono12">{i + 1}</span>
              <span className="text-[13px]">{record}</span>
            </li>
          ))}
        </ul>
        <p className="muted mt-3 text-[12px] leading-relaxed">
          Wallets add these automatically. Holders see them listed when they approve a transfer.
        </p>

        <div className="mt-12 flex flex-wrap items-center gap-5 border-t border-hairline pt-6">
          <button type="button" className="btn-primary" onClick={() => navigate('/console')}>
            Sign and issue
          </button>
          <span className="muted text-[12px]">
            Two signatures required — this collects the first.
          </span>
          <Link to="/powers" className="btn-plain muted">
            Back to 4 powers
          </Link>
        </div>
      </main>

      <footer className="border-t border-hairline">
        <div className="mx-auto max-w-[1180px] px-5 py-4">
          <p className="mono12 muted">
            Prototype · all figures, names and addresses shown are fictional
          </p>
        </div>
      </footer>
    </div>
  )
}
