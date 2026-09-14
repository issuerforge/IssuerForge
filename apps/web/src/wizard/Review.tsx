// Крок 5: що саме буде підписано, ким і скількома підписами.
//
// **Три підписи, а не один.** Випуск — це три транзакції, і першу підписують
// двоє: засновник-адміністратор і атестатор резерву. Прототип M0 показував одну
// кнопку «підписати», і борг T020 записаний саме про це. Тут перелік підписів
// стоїть перед кнопкою, а не після неї.
//
// **Кворум і делегація тут не задаються.** Вони належать емітенту, а не
// випуску: змінити їх ця форма не може, і показувати їх значенням, яке нібито
// обирається, було б брехнею (борг T010 — «прибрати з майстра кворум 1»).
// Замість числа стоїть речення про те, чого випуск не робить.

import { useWebEnv } from '@/auth/providers'
import { truncate } from '@/lib/format'
import { problemsAt, toCreateTokenBody, warningsFor } from './draft.ts'
import { absentSigners, signatureCount } from './issuance.ts'
import Rulebook from './Rulebook.tsx'
import { useIssue } from './useIssue.ts'
import { useWizard } from './WizardContext.tsx'

function Head({ children }: { children: string }) {
  return <h2 className="section-head mt-10 block">{children}</h2>
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <li className="grid grid-cols-[1fr_auto] items-baseline gap-4 border-b border-hairline py-2">
      <span className="text-[13px]">{label}</span>
      <span className="num break-all text-right text-[13px]">{value}</span>
    </li>
  )
}

const PHASE_WORD: Record<string, string> = {
  waiting: 'not sent',
  signing: 'waiting for a signature',
  sending: 'sending',
  confirming: 'waiting for confirmation',
  confirmed: 'confirmed',
  failed: 'failed',
}

export default function Review() {
  const { draft, goTo } = useWizard()
  const env = useWebEnv()
  const issue = useIssue(env.VITE_DEVNET_RPC_URL)

  const problems = problemsAt(5, draft)
  const warnings = warningsFor(draft)
  const absent = absentSigners(issue.plans)
  const done =
    issue.progress.length > 0 && issue.progress.every((entry) => entry.phase === 'confirmed')

  const prepare = async () => {
    // Час береться тут, а не всередині чистої функції: атестація резерву
    // датується моментом запиту, і прихований годинник зробив би збірку
    // невідтворюваною.
    const built = toCreateTokenBody(draft, Math.floor(Date.now() / 1000))
    if (built.body !== undefined) await issue.assemble(built.body)
  }

  return (
    <>
      <Rulebook documentMode />

      {problems.length > 0 && (
        <>
          <Head>Not ready to issue</Head>
          <ul className="mt-3">
            {problems.map((problem) => (
              <li key={problem} className="border-b border-hairline py-2 text-[13px]">
                {problem}
              </li>
            ))}
          </ul>
        </>
      )}

      {warnings.length > 0 && (
        <>
          <Head>Worth reading twice</Head>
          <ul className="mt-3">
            {warnings.map((warning) => (
              <li
                key={warning}
                className="border-b border-hairline py-2 text-[13px] leading-relaxed"
                style={{ color: 'var(--refuse)' }}
              >
                {warning}
              </li>
            ))}
          </ul>
          <p className="muted mt-2 text-[12px]">
            The network allows all of this. It is the issuance that would be useless, not the
            transaction that would fail.
          </p>
        </>
      )}

      <Head>What this issuance does not set</Head>
      <p className="mt-3 max-w-[42rem] text-[13px] leading-relaxed">
        The quorum that signs actions with money, the roster of wallets that holds it, and what this
        issuer delegates to the platform’s operational key all belong to the issuer, not to this
        token. Issuing does not change any of them.
      </p>

      {issue.assembled === undefined ? (
        <>
          <Head>Prepare the issuance</Head>
          <p className="mt-3 max-w-[42rem] text-[13px] leading-relaxed">
            This asks the api to reserve the next token number for this issuer and to build the
            three transactions. Nothing is signed and nothing reaches the network yet.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-5 border-t border-hairline pt-5">
            <button
              type="button"
              className="btn-primary"
              disabled={problems.length > 0 || issue.busy}
              onClick={prepare}
            >
              {issue.busy ? 'Preparing…' : 'Prepare the issuance'}
            </button>
            <button type="button" className="btn-plain muted" onClick={() => goTo(4)}>
              Back to 4 reserve and fee
            </button>
          </div>
        </>
      ) : (
        <>
          <Head>Addresses, known before signing</Head>
          <ul className="mt-3 max-w-[42rem]">
            <Row label="Token number" value={String(issue.assembled.tokenIndex)} />
            <Row label="Mint" value={issue.assembled.mint} />
            <Row label="Policy" value={issue.assembled.policyConfig} />
            <Row label="Reserve attestation" value={issue.assembled.attestation} />
          </ul>

          <Head>Signatures this takes</Head>
          <ul className="mt-3">
            {issue.plans.map((plan, index) => {
              const entry = issue.progress[index]
              return (
                <li key={plan.step} className="border-b border-hairline py-3">
                  <div className="grid grid-cols-[1fr_auto] items-baseline gap-4">
                    <span className="text-[13px]">
                      <span className="num mr-2">{index + 1}</span>
                      {plan.step}
                      {plan.dependsOnPrevious && (
                        <span className="muted"> · sent only after the previous is confirmed</span>
                      )}
                    </span>
                    <span className="mono12">{plan.bytes} bytes</span>
                  </div>
                  <ul className="mt-1">
                    {plan.signers.map((signer) => (
                      <li key={signer.address} className="mono12 muted">
                        {truncate(signer.address, 8, 6)}
                        {signer.connected ? ' · signs here' : ' · not a wallet of this session'}
                      </li>
                    ))}
                  </ul>
                  {entry && (
                    <p className="mono12 mt-1">
                      {PHASE_WORD[entry.phase] ?? entry.phase}
                      {entry.signature !== undefined && ` · ${truncate(entry.signature, 8, 6)}`}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
          <p className="muted mt-3 text-[12px] leading-relaxed">
            {signatureCount(issue.plans)} signatures across {issue.plans.length} transactions. They
            are signed in this order and sent one at a time.
          </p>

          {absent.length > 0 && (
            <>
              <Head>A signature this session cannot give</Head>
              <p className="mt-3 max-w-[42rem] text-[13px] leading-relaxed">
                The attestor of the reserve stands in this issuer’s roster as its own wallet, and
                that wallet is not signed in here — which is what the role is for (it may hold
                nothing else). Sign in with{' '}
                {absent.map((address) => truncate(address, 8, 6)).join(', ')} as well, and this page
                will collect both signatures in one pass.
              </p>
              <p className="muted mt-2 text-[12px] leading-relaxed">
                Handing the transaction over as a string — sign here, pass it on, come back with the
                second signature — is not built yet. The unsigned bytes are below for anyone who
                signs and sends them elsewhere.
              </p>
              <p className="mono12 muted mt-3 break-all">{issue.plans[0]?.base64}</p>
            </>
          )}

          {issue.error !== undefined && (
            <>
              <Head>The issuance stopped</Head>
              <p className="mt-3 max-w-[42rem] text-[13px]" style={{ color: 'var(--refuse)' }}>
                {issue.error}
              </p>
            </>
          )}

          <div className="mt-10 flex flex-wrap items-center gap-5 border-t border-hairline pt-6">
            {done ? (
              <span className="text-[13px]">
                Issued. The token is live on the network under the policy above.
              </span>
            ) : (
              <button
                type="button"
                className="btn-primary"
                disabled={issue.busy || absent.length > 0}
                onClick={issue.submit}
              >
                {issue.busy ? 'Signing and sending…' : 'Sign and issue'}
              </button>
            )}
            {!done && (
              <button type="button" className="btn-plain muted" onClick={issue.reset}>
                Back to editing
              </button>
            )}
          </div>
          {!done && (
            <p className="muted mt-3 text-[12px] leading-relaxed">
              The reserved token number is held for five minutes. Coming back later builds the same
              token again, with a fresh blockhash.
            </p>
          )}
        </>
      )}
    </>
  )
}
