// The officer's screen: a token's totals, its frozen accounts, its proposals,
// and the form that starts a new action (FR-014, FR-015, FR-016, FR-020).
//
// **Two kinds of action, and the screen says which is which.** A freeze is
// the officer's alone and takes effect on one signature. A seizure, a pause
// and its lifting are proposals: the first signature raises them, nothing
// moves until the quorum is reached and someone executes. The form's button
// and the line under it name the difference before anyone signs.
import type { ProposalResponse } from '@forge/api/contracts/actions'
import { proposeActionResponseSchema } from '@forge/api/contracts/actions'
import {
  type ComplianceSummary,
  type FreezeResponse,
  officerTransactionResponseSchema,
  type TokenListing,
} from '@forge/api/contracts/compliance'
import { hasRole, ROLE } from '@forge/shared/api'
import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useConsoleSession } from '@/auth/guards'
import { useApi } from '@/auth/providers'
import { Chip, Field, Segmented } from '@/components/controls'
import { truncate } from '@/lib/format'
import {
  type ActionDraft,
  type ActionKind,
  actionTitle,
  type DraftField,
  EMPTY_DRAFT,
  formatUnits,
  reasonLine,
  toRequest,
  utc,
} from './model'
import { useProposals, useSummary, useTokens } from './queries'
import { ReasonFields, type ReasonValue } from './ReasonFields'
import { isBusy, RunLine, useRun } from './submit'

export default function ActionsScreen() {
  const tokens = useTokens()
  const [params, setParams] = useSearchParams()

  if (tokens.isPending)
    return <p className="muted py-8 text-[13px]">Reading this issuer’s tokens…</p>
  if (tokens.error) return <Failure error={tokens.error} what="this issuer’s tokens" />

  const list = tokens.data.tokens
  if (list.length === 0) {
    return (
      <div className="max-w-[620px] py-10">
        <h1 className="section-head block">Compliance actions</h1>
        <p className="mt-5 text-[13px] leading-relaxed">
          This issuer has not issued a token yet. Freezes, seizures and pauses act on a token, so
          there is nothing to act on.
        </p>
      </div>
    )
  }

  const chosen = list.find((token) => token.mint === params.get('token')) ?? list[0]
  if (chosen === undefined) return null

  return (
    <div className="py-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-hairline pb-2">
        <h1 className="smallcaps">Compliance actions</h1>
        {list.length > 1 ? (
          <div className="flex flex-wrap gap-2">
            {list.map((token) => (
              <Chip
                key={token.mint}
                label={token.symbol ?? truncate(token.mint)}
                selected={token.mint === chosen.mint}
                onClick={() => setParams({ token: token.mint })}
              />
            ))}
          </div>
        ) : (
          <span className="mono12 muted">{tokenName(chosen)}</span>
        )}
      </div>
      <TokenActions key={chosen.mint} token={chosen} />
    </div>
  )
}

const tokenName = (token: TokenListing) =>
  token.symbol ? `${token.symbol} · ${truncate(token.mint)}` : truncate(token.mint)

function TokenActions({ token }: { token: TokenListing }) {
  const summary = useSummary(token.mint)
  const proposals = useProposals(token.mint)
  const [prefill, setPrefill] = useState<Partial<ActionDraft> | undefined>(undefined)

  if (summary.isPending) return <p className="muted py-8 text-[13px]">Reading the token…</p>
  if (summary.error) return <Failure error={summary.error} what="the token’s totals" />

  const data = summary.data
  return (
    <>
      <Totals summary={data} symbol={token.symbol} />

      <FrozenAccounts
        summary={data}
        symbol={token.symbol}
        onSeize={(freeze) =>
          setPrefill({
            kind: 'seize',
            target: freeze.tokenAccount,
            targetIs: 'tokenAccount',
            amount: formatUnits(freeze.amount, data.decimals),
            caseRef: freeze.reason.caseRef,
          })
        }
      />

      <section className="mt-12">
        <h2 className="section-head block">Proposals</h2>
        {proposals.isPending && <p className="muted mt-3 text-[13px]">Reading proposals…</p>}
        {proposals.error && <Failure error={proposals.error} what="the proposals" />}
        {proposals.data && (
          <ProposalList
            proposals={proposals.data.proposals}
            decimals={data.decimals}
            symbol={token.symbol}
          />
        )}
      </section>

      <NewAction
        key={JSON.stringify(prefill ?? {})}
        mint={token.mint}
        decimals={data.decimals}
        paused={data.paused}
        symbol={token.symbol}
        prefill={prefill}
      />
    </>
  )
}

// ─── Totals (FR-020) ─────────────────────────────────────────────────────────

function Totals({ summary, symbol }: { summary: ComplianceSummary; symbol: string | null }) {
  const cells = [
    { label: 'Supply', value: summary.supply, note: 'everything minted' },
    { label: 'Free to move', value: summary.free, note: 'supply less the two below' },
    {
      label: 'Frozen by an officer',
      value: summary.frozen.amount,
      note: `${summary.frozen.accounts.length} account${summary.frozen.accounts.length === 1 ? '' : 's'}`,
    },
    { label: 'Seized', value: summary.seized.amount, note: 'held in the issuer’s vault' },
  ]

  return (
    <section className="mt-6">
      {summary.paused && (
        <p className="refuse mb-4 border border-current px-4 py-3 text-[13px]">
          Circulation is paused. Every transfer of this token is refused until a quorum lifts the
          pause.
        </p>
      )}
      <dl className="grid grid-cols-1 border-t border-hairline sm:grid-cols-2 lg:grid-cols-4">
        {cells.map((cell) => (
          <div key={cell.label} className="border-b border-hairline py-4 sm:pr-6">
            <dt className="smallcaps muted">{cell.label}</dt>
            <dd className="num mt-2 break-all text-[17px]">
              {formatUnits(cell.value, summary.decimals)}
              {symbol && <span className="mono12 muted ml-2">{symbol}</span>}
            </dd>
            <dd className="muted mt-1 text-[12px]">{cell.note}</dd>
          </div>
        ))}
      </dl>
      <p className="muted mt-3 text-[12px] leading-relaxed">
        Read from the network on opening, not from the console’s mirror. Accounts awaiting
        onboarding are frozen by default and are not counted as frozen by an officer.
      </p>
    </section>
  )
}

// ─── Frozen accounts ─────────────────────────────────────────────────────────

function FrozenAccounts({
  summary,
  symbol,
  onSeize,
}: {
  summary: ComplianceSummary
  symbol: string | null
  onSeize: (freeze: FreezeResponse) => void
}) {
  const session = useConsoleSession()
  const officer = hasRole(session.roles, ROLE.COMPLIANCE)
  const accounts = summary.frozen.accounts

  return (
    <section className="mt-12">
      <h2 className="section-head block">Frozen accounts</h2>
      {accounts.length === 0 ? (
        <p className="muted mt-3 text-[13px]">No account of this token is frozen by an officer.</p>
      ) : (
        <ul>
          {accounts.map((freeze) => (
            <FrozenRow
              key={freeze.tokenAccount}
              freeze={freeze}
              mint={summary.mint}
              decimals={summary.decimals}
              symbol={symbol}
              officer={officer}
              onSeize={() => onSeize(freeze)}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function FrozenRow({
  freeze,
  mint,
  decimals,
  symbol,
  officer,
  onSeize,
}: {
  freeze: FreezeResponse
  mint: string
  decimals: number
  symbol: string | null
  officer: boolean
  onSeize: () => void
}) {
  const api = useApi()
  const { state, run } = useRun()
  const [lifting, setLifting] = useState(false)
  const [reason, setReason] = useState<ReasonValue>({
    reasonCode: '',
    otherCode: '',
    caseRef: freeze.reason.caseRef,
  })
  const [errors, setErrors] = useState<{
    reason?: string | undefined
    caseRef?: string | undefined
  }>({})

  const lift = () => {
    // The same check as the new-action form: the schema the api validates with.
    const result = toRequest(
      {
        ...EMPTY_DRAFT,
        ...reason,
        kind: 'freeze',
        target: freeze.tokenAccount,
        targetIs: 'tokenAccount',
      },
      decimals,
      false,
    )
    if (!result.ok) {
      setErrors({ reason: result.errors.reason, caseRef: result.errors.caseRef })
      return
    }
    if (result.request.kind !== 'freeze') return
    const checked = result.request.body.reason
    setErrors({})
    void run(() =>
      api.post(
        `/api/tokens/${mint}/freezes/${freeze.tokenAccount}/unfreeze`,
        { reason: checked },
        officerTransactionResponseSchema,
      ),
    )
  }

  return (
    <li className="border-b border-hairline py-3">
      <div className="grid grid-cols-1 items-baseline gap-x-5 gap-y-1 md:grid-cols-[10rem_10rem_1fr_9rem_auto]">
        <span className="mono12" title={freeze.tokenAccount}>
          {truncate(freeze.tokenAccount, 8, 4)}
        </span>
        <span className="num text-[13px] md:text-right">
          {formatUnits(freeze.amount, decimals)}
          {symbol && <span className="mono12 muted ml-1">{symbol}</span>}
        </span>
        <span className="mono12 break-all">{reasonLine(freeze.reason)}</span>
        <span className="mono12 muted">{utc(freeze.frozenAt)}</span>
        <span className="flex gap-4">
          {officer && !lifting && (
            <button type="button" className="btn-plain" onClick={() => setLifting(true)}>
              Lift
            </button>
          )}
          <button type="button" className="btn-plain" onClick={onSeize}>
            Propose seizure
          </button>
        </span>
      </div>
      <p className="muted mt-1 text-[12px]">
        Owner <span className="mono12">{truncate(freeze.wallet, 8, 4)}</span> · lifting returns the
        account {freeze.wasThawed ? 'to transfers' : 'to the onboarding queue'}
      </p>

      {lifting && (
        <div className="mt-3 max-w-[46rem] border-l-2 border-hairline pl-4">
          <ReasonFields value={reason} onChange={setReason} errors={errors} />
          <div className="mt-4 flex flex-wrap items-center gap-5">
            <button type="button" className="btn-primary" disabled={isBusy(state)} onClick={lift}>
              Lift the freeze
            </button>
            <button type="button" className="btn-plain muted" onClick={() => setLifting(false)}>
              Cancel
            </button>
          </div>
          <p className="muted mt-2 text-[12px]">
            One signature, yours. The lifting is its own line in the journal, with its own reason.
          </p>
          <RunLine state={state} />
        </div>
      )}
    </li>
  )
}

// ─── Proposals ───────────────────────────────────────────────────────────────

const STATE_LABEL: Record<ProposalResponse['state'], string> = {
  open: 'gathering',
  ready: 'ready to execute',
  blocked: 'blocked',
  executed: 'executed',
  expired: 'expired',
}

function ProposalList({
  proposals,
  decimals,
  symbol,
}: {
  proposals: readonly ProposalResponse[]
  decimals: number
  symbol: string | null
}) {
  if (proposals.length === 0) {
    return <p className="muted mt-3 text-[13px]">No proposal is open for this token.</p>
  }
  return (
    <ul>
      {proposals.map((proposal) => (
        <li key={proposal.address} className="border-b border-hairline">
          <Link
            to={`/console/actions/${proposal.address}`}
            className="grid grid-cols-1 items-baseline gap-x-5 gap-y-1 py-3 md:grid-cols-[1fr_1fr_9rem_5rem_11rem]"
          >
            <span className="text-[13px]">{actionTitle(proposal.action, decimals, symbol)}</span>
            <span className="mono12 break-all">{reasonLine(proposal.action.reason)}</span>
            <span
              className={`smallcaps ${proposal.state === 'blocked' ? 'refuse' : proposal.state === 'ready' ? '' : 'muted'}`}
            >
              {STATE_LABEL[proposal.state]}
            </span>
            <span className="num text-[12px] md:text-right">
              {proposal.counted} / {proposal.required}
            </span>
            <span className="mono12 muted md:text-right">
              {proposal.executedAt === null
                ? `until ${utc(proposal.expiresAt)}`
                : utc(proposal.executedAt)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

// ─── The new-action form ─────────────────────────────────────────────────────

function NewAction({
  mint,
  decimals,
  paused,
  symbol,
  prefill,
}: {
  mint: string
  decimals: number
  paused: boolean
  symbol: string | null
  prefill: Partial<ActionDraft> | undefined
}) {
  const api = useApi()
  const navigate = useNavigate()
  const session = useConsoleSession()
  const officer = hasRole(session.roles, ROLE.COMPLIANCE)
  const { state, run } = useRun()
  const [draft, setDraft] = useState<ActionDraft>(() => ({
    ...EMPTY_DRAFT,
    kind: officer ? 'freeze' : 'seize',
    targetIs: officer ? 'wallet' : 'tokenAccount',
    ...prefill,
  }))
  const [errors, setErrors] = useState<Partial<Record<DraftField, string>>>({})

  const set = (patch: Partial<ActionDraft>) => setDraft((previous) => ({ ...previous, ...patch }))

  const kinds: { value: ActionKind; label: string }[] = [
    ...(officer ? [{ value: 'freeze' as const, label: 'Freeze an account' }] : []),
    { value: 'seize', label: 'Seize funds' },
    { value: 'circulation', label: paused ? 'Lift the pause' : 'Pause circulation' },
  ]

  const submit = async () => {
    const result = toRequest(draft, decimals, paused)
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    setErrors({})
    const request = result.request
    if (request.kind === 'freeze') {
      await run(() =>
        api.post(`/api/tokens/${mint}/freezes`, request.body, officerTransactionResponseSchema),
      )
      return
    }
    const raised = await run(() =>
      api.post(`/api/tokens/${mint}/actions`, request.body, proposeActionResponseSchema),
    )
    if (raised !== undefined) navigate(`/console/actions/${raised.proposal}`)
  }

  const proposal = draft.kind !== 'freeze'
  const button =
    draft.kind === 'freeze'
      ? 'Freeze the account'
      : draft.kind === 'seize'
        ? 'Propose the seizure'
        : paused
          ? 'Propose lifting the pause'
          : 'Propose the pause'

  return (
    <section className="mt-12 max-w-[46rem]">
      <h2 className="section-head block">New action</h2>
      <Segmented
        options={kinds}
        value={draft.kind}
        onChange={(kind) =>
          set({ kind, targetIs: kind === 'seize' ? 'tokenAccount' : draft.targetIs })
        }
      />

      {draft.kind === 'freeze' && (
        <Segmented
          label="Name the holder by"
          options={[
            { value: 'wallet', label: 'wallet' },
            { value: 'tokenAccount', label: 'token account' },
          ]}
          value={draft.targetIs}
          onChange={(targetIs) => set({ targetIs })}
        />
      )}

      {draft.kind !== 'circulation' && (
        <>
          <Field
            label={draft.targetIs === 'wallet' ? 'Wallet' : 'Token account'}
            value={draft.target}
            onChange={(target) => set({ target })}
            mono
            hint={
              draft.kind === 'seize'
                ? 'The account to take from — as listed under frozen accounts.'
                : draft.targetIs === 'wallet'
                  ? 'Its account for this token is frozen; another account of the same wallet is not.'
                  : ''
            }
          />
          <FieldError text={errors.target} />
        </>
      )}

      {draft.kind === 'seize' && (
        <>
          <Field
            label={`Amount${symbol ? ` (${symbol})` : ''}`}
            value={draft.amount}
            onChange={(amount) => set({ amount })}
            mono
            hint="Exact. If the account holds less when the seizure is executed, it fails rather than take less."
          />
          <FieldError text={errors.amount} />
        </>
      )}

      <ReasonFields
        value={draft}
        onChange={(reason) => set(reason)}
        errors={{ reason: errors.reason, caseRef: errors.caseRef }}
      />

      {proposal && (
        <>
          <Field
            label="Proposal lives (days)"
            value={draft.termDays}
            onChange={(termDays) => set({ termDays })}
            mono
            hint="If the quorum is not reached by then, the proposal lapses and nothing moves."
          />
          <FieldError text={errors.termDays} />
        </>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-6">
        <button
          type="button"
          className={draft.kind === 'circulation' && !paused ? 'btn-destructive' : 'btn-primary'}
          disabled={isBusy(state)}
          onClick={() => void submit()}
        >
          {button}
        </button>
      </div>
      <p className="muted mt-3 text-[12px] leading-relaxed">
        {proposal
          ? 'Your signature raises the proposal and counts as its first approval. Nothing moves until another member signs and someone executes it.'
          : 'One signature, yours. The account can neither send nor receive from the moment it is confirmed.'}
      </p>
      {!officer && (
        <p className="muted mt-1 text-[12px]">
          Freezing an account is a compliance officer’s action, and your role does not include it.
        </p>
      )}
      <RunLine state={state} />
    </section>
  )
}

function FieldError({ text }: { text: string | undefined }) {
  return text ? <p className="refuse -mt-2 mb-2 text-[12px] sm:pl-[14.5rem]">{text}</p> : null
}

export function Failure({ error, what }: { error: Error; what: string }) {
  return (
    <p className="refuse py-6 text-[13px] leading-relaxed">
      The console could not read {what}: {error.message}
      {'requestId' in error && typeof error.requestId === 'string' && (
        <span className="mono12 muted ml-2">request {error.requestId}</span>
      )}
    </p>
  )
}
