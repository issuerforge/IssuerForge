// One proposal: the case, the reason, the quorum by name, and the one step
// this session can take (FR-017, FR-019b, FR-019c).
//
// **What an approver reads is what the program will compare against.** The
// body comes from the api, which checks it against the account before
// answering (`ActionReader.body`); the screen draws it and nothing else.
//
// **Named seats, not a counter.** "One of two" does not say who signed or who
// could sign next; FR-019c asks for names, and so does the person deciding
// whether to sign.
import {
  actionTransactionResponseSchema,
  type ProposalResponse,
} from '@forge/api/contracts/actions'
import { Link, useParams } from 'react-router-dom'
import { useConsoleSession } from '@/auth/guards'
import { useApi } from '@/auth/providers'
import { truncate } from '@/lib/format'
import { describeMask } from '@/settings/model'
import { Failure } from './ActionsScreen'
import { actionTitle, formatUnits, nextStep, reasonLine, seats, standingLine, utc } from './model'
import { useProposal, useTokens } from './queries'
import { isBusy, RunLine, useRun } from './submit'

export default function ProposalScreen() {
  const { id = '' } = useParams()
  const detail = useProposal(id)
  const tokens = useTokens()

  if (detail.isPending) return <p className="muted py-8 text-[13px]">Reading the proposal…</p>
  if (detail.error) return <Failure error={detail.error} what="this proposal" />

  const { proposal, authorising } = detail.data
  const action = proposal.action
  const token = tokens.data?.tokens.find((t) => t.mint === proposal.mint)
  // Until the token list arrives the amount is shown in the smallest unit,
  // and says so — never with a guessed number of decimals.
  const decimals = token?.decimals ?? 0
  const symbol = token === undefined ? 'base units' : token.symbol

  return (
    <div className="py-6">
      {proposal.mint === null ? (
        <Link to="/settings/delegation" className="btn-plain muted">
          ← The operational key
        </Link>
      ) : (
        <Link to={`/console/actions?token=${proposal.mint}`} className="btn-plain muted">
          ← All actions on this token
        </Link>
      )}

      <h1 className="mt-4 border-b border-hairline pb-5 text-[18px] font-medium">
        {action.kind === 'set-delegation' ? (
          <>Operational key · </>
        ) : (
          <>
            Case <span className="num">{action.reason.caseRef}</span> ·{' '}
          </>
        )}
        {actionTitle(action, decimals, symbol)}
      </h1>

      <Definition proposal={proposal} decimals={decimals} symbol={symbol} />

      <h2 className="section-head mt-12 block">Quorum</h2>
      <p className="mt-3 text-[13px]">{standingLine(proposal)}</p>

      <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 md:max-w-[46rem] md:grid-cols-4">
        {seats(proposal, authorising).map((seat) => {
          const signed = seat.order !== null
          return (
            <li
              key={seat.wallet}
              className="border p-3"
              style={{
                background: signed && !seat.lapsed ? 'var(--ink)' : 'transparent',
                color: seat.lapsed
                  ? 'var(--refuse)'
                  : signed
                    ? 'var(--ground)'
                    : 'var(--ink-muted)',
                borderColor: seat.lapsed
                  ? 'var(--refuse)'
                  : signed
                    ? 'var(--ink)'
                    : 'var(--hairline)',
              }}
            >
              <div className="smallcaps">{seat.role}</div>
              <div className="mono12 mt-1 break-all" title={seat.wallet}>
                {truncate(seat.wallet, 6, 4)}
              </div>
              <div className="mono12 mt-2">
                {seat.lapsed
                  ? 'signed, role lost'
                  : seat.order === 1
                    ? 'proposed · signed 1st'
                    : seat.order !== null
                      ? `signed ${ordinal(seat.order)}`
                      : 'not signed'}
              </div>
            </li>
          )
        })}
      </ul>

      {/* Keyed by the standing: after a signature lands the next step is a
          different action, and it must not inherit the last one's status. */}
      <Step
        key={`${proposal.state}:${proposal.approvals.length}`}
        proposal={proposal}
        authorising={authorising}
      />
    </div>
  )
}

function Definition({
  proposal,
  decimals,
  symbol,
}: {
  proposal: ProposalResponse
  decimals: number
  symbol: string | null
}) {
  const action = proposal.action
  const rows: { label: string; value: string }[] = [
    ...(action.kind === 'seize'
      ? [
          { label: 'From account', value: action.tokenAccount },
          {
            label: 'Amount',
            value: `${formatUnits(action.amount, decimals)}${symbol ? ` ${symbol}` : ''}`,
          },
        ]
      : []),
    ...(action.kind === 'set-delegation'
      ? [
          { label: 'Key now', value: action.previousKey },
          { label: 'Key after', value: action.operationalKey },
          { label: 'Powers now', value: describeMask(action.previousMask) },
          { label: 'Powers after', value: describeMask(action.mask) },
        ]
      : [{ label: 'Reason', value: reasonLine(action.reason) }]),
    { label: 'Proposed by', value: proposal.approvals[0] ?? '—' },
    { label: 'Raised', value: `${utc(proposal.createdAt)} UTC` },
    proposal.executedAt === null
      ? { label: 'Lapses', value: `${utc(proposal.expiresAt)} UTC` }
      : { label: 'Executed', value: `${utc(proposal.executedAt)} UTC` },
    ...(proposal.mint === null ? [] : [{ label: 'Token', value: proposal.mint }]),
    { label: 'Proposal account', value: proposal.address },
  ]

  return (
    <ul className="mt-6 max-w-[46rem]">
      {rows.map((row) => (
        <li
          key={row.label}
          className="grid grid-cols-1 items-baseline gap-x-6 gap-y-1 border-b border-hairline py-2 sm:grid-cols-[11rem_1fr]"
        >
          <span className="text-[13px]">{row.label}</span>
          <span className="mono12 break-all sm:text-right">{row.value}</span>
        </li>
      ))}
    </ul>
  )
}

function Step({
  proposal,
  authorising,
}: {
  proposal: ProposalResponse
  authorising: readonly { wallet: string; roles: number }[]
}) {
  const api = useApi()
  const session = useConsoleSession()
  const { state, run } = useRun()
  const step = nextStep(proposal, authorising, session.wallets)

  if (step.kind === 'wait') {
    return <p className="muted mt-8 max-w-[46rem] text-[13px] leading-relaxed">{step.why}</p>
  }

  const path = `/api/actions/${proposal.address}/${step.kind}?signer=${step.signer}`
  const label =
    step.kind === 'approve'
      ? proposal.action.kind === 'seize'
        ? 'Sign the seizure'
        : 'Sign the proposal'
      : step.kind === 'execute'
        ? 'Execute'
        : 'Close and return the rent'
  const note =
    step.kind === 'approve'
      ? `Your signature, from ${truncate(step.signer, 6, 4)}, is counted by the program, not by this console.`
      : step.kind === 'execute'
        ? 'The quorum is the authority; this signature only sends the transaction and pays its fee.'
        : 'Closing is open to any authorising member once the proposal is over; the rent goes to whoever paid it.'

  return (
    <div className="mt-8">
      <button
        type="button"
        className={
          // Red where the signature takes something: funds, or circulation.
          step.kind === 'approve' &&
          (proposal.action.kind === 'seize' || proposal.action.kind === 'pause')
            ? 'btn-destructive'
            : 'btn-primary'
        }
        disabled={isBusy(state)}
        onClick={() => void run(() => api.post(path, {}, actionTransactionResponseSchema))}
      >
        {label}
      </button>
      <p className="muted mt-3 max-w-[46rem] text-[12px] leading-relaxed">{note}</p>
      <RunLine state={state} />
    </div>
  )
}

const ordinal = (n: number) => `${n}${n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`
