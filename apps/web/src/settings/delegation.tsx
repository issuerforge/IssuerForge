// What the platform's operational key may do for this issuer — and taking
// any of it back in one action (FR-035, FR-035b).
//
// **Revocation is one click and one signature.** The program lets a single
// admin narrow the same key; the screen offers exactly that next to every
// held power, and "revoke everything" for the hour a key leaks. No proposal,
// no second signer, no confirmation dialog: the wallet's signature request is
// the confirmation, and a revocation grants nobody anything.
//
// **Giving power back is a proposal.** A grant or a new key hands the
// platform something over the issuer's holders, so it takes the quorum and
// goes to the same proposal page as a seizure. The screen says which path a
// change takes before anyone signs.
//
// **Every number is the chain's.** The key and its powers are read from
// `IssuerConfig` on opening; the history is the indexer's, each row with the
// signature that proves it.

import type { ProposalResponse } from '@forge/api/contracts/actions'
import {
  type DelegationChange,
  delegationResponseSchema,
  proposeDelegationResponseSchema,
  revokeResponseSchema,
} from '@forge/api/contracts/delegation'
import { DELEGATION, hasPower, type PowerName } from '@forge/shared/api'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useApi, useTenant } from '@/auth/providers'
import { Failure } from '@/compliance/ActionsScreen'
import { actionTitle, utc } from '@/compliance/model'
import { isBusy, RunLine, useRun } from '@/compliance/submit'
import { Field, Tick } from '@/components/controls'
import { truncate } from '@/lib/format'
import { ALL_POWERS, CHANGE_LABEL, changeKind, describeMask, maskOf, POWER_TEXT } from './model'

const DAY = 24 * 60 * 60

function useDelegation() {
  const api = useApi()
  const { issuerId } = useTenant()
  return useQuery({
    queryKey: ['delegation', issuerId ?? null],
    queryFn: () => api.get('/api/issuer/delegation', delegationResponseSchema),
  })
}

export default function DelegationScreen() {
  const delegation = useDelegation()

  if (delegation.isPending) {
    return <p className="muted py-8 text-[13px]">Reading the delegation from the network…</p>
  }
  if (delegation.error) return <Failure error={delegation.error} what="the delegation" />

  const data = delegation.data
  const ours = data.operationalKey === data.platformKey

  return (
    <div className="py-8">
      <h1 className="section-head block">The operational key</h1>

      <dl className="mt-6 grid grid-cols-1 border-b border-hairline sm:grid-cols-[13rem_1fr]">
        <dt className="smallcaps muted py-3">Key</dt>
        <dd className="mono12 break-all py-3">{data.operationalKey}</dd>
        <dt className="smallcaps muted border-t border-hairline py-3 sm:border-t-0">Whose</dt>
        <dd className="py-3 text-[13px]">
          {ours
            ? 'The platform’s own key — the one this console’s server signs routine actions with.'
            : 'Not the platform’s key. The server will not sign with it; whoever holds it may, within the powers below.'}
        </dd>
      </dl>
      <p className="muted mt-3 max-w-[46rem] text-[12px] leading-relaxed">
        Whatever this key holds, the program refuses it every action with funds, every policy change
        and every change of the roster — those take the issuer’s own quorum, whoever holds the key.
      </p>

      <Powers mask={data.mask} />
      <InFlight proposals={data.proposals} />
      {/* Keyed by the delegation: the form starts from what the key holds, and
          after a revocation that is a different starting point. */}
      <Propose
        key={`${data.operationalKey}:${data.mask}`}
        current={{ key: data.operationalKey, mask: data.mask }}
      />
      <History rows={data.history} />
    </div>
  )
}

// ─── Powers, each revocable now ──────────────────────────────────────────────

function Powers({ mask }: { mask: number }) {
  const api = useApi()
  const { state, run } = useRun()
  const held = ALL_POWERS.filter((power) => hasPower(mask, DELEGATION[power]))

  const revoke = (powers: PowerName[]) =>
    void run(() => api.post('/api/issuer/delegation/revoke', { powers }, revokeResponseSchema))

  return (
    <section className="mt-12 max-w-[46rem]">
      <h2 className="section-head block">What it may do</h2>
      <ul>
        {ALL_POWERS.map((power) => {
          const has = held.includes(power)
          return (
            <li
              key={power}
              className="grid grid-cols-[1fr_auto] items-baseline gap-4 border-b border-hairline py-3"
            >
              <span>
                <span
                  className="block text-[13px]"
                  style={{ color: has ? 'var(--ink)' : 'var(--ink-muted)' }}
                >
                  {POWER_TEXT[power].label}
                  <span className="mono12 muted ml-2">{power}</span>
                </span>
                <span className="muted mt-1 block text-[12px] leading-relaxed">
                  {POWER_TEXT[power].does}
                </span>
              </span>
              {has ? (
                <button
                  type="button"
                  className="btn-plain"
                  disabled={isBusy(state)}
                  onClick={() => revoke([power])}
                >
                  Revoke
                </button>
              ) : (
                <span className="mono12 muted">not delegated</span>
              )}
            </li>
          )
        })}
      </ul>

      <div className="mt-6 flex flex-wrap items-center gap-6">
        <button
          type="button"
          className="btn-destructive"
          disabled={held.length === 0 || isBusy(state)}
          onClick={() => revoke(held)}
        >
          Revoke everything
        </button>
      </div>
      <p className="muted mt-3 text-[12px] leading-relaxed">
        {held.length === 0
          ? 'The key holds nothing: every routine action now needs an issuer wallet.'
          : 'One signature, yours, and it is in force from confirmation. A grant raised before it cannot undo it — the program refuses a proposal whose starting point has moved.'}
      </p>
      <RunLine state={state} />
    </section>
  )
}

// ─── Grants and rotations in flight ──────────────────────────────────────────

function InFlight({ proposals }: { proposals: readonly ProposalResponse[] }) {
  if (proposals.length === 0) return null
  return (
    <section className="mt-12">
      {/* Not "waiting": an executed proposal stays on chain until someone
          closes it and returns its rent, and it is listed until then. */}
      <h2 className="section-head block">Proposals on this key</h2>
      <ul>
        {proposals.map((proposal) => (
          <li key={proposal.address} className="border-b border-hairline">
            <Link
              to={`/console/actions/${proposal.address}`}
              className="grid grid-cols-1 items-baseline gap-x-5 gap-y-1 py-3 md:grid-cols-[1fr_9rem_5rem_11rem]"
            >
              <span className="text-[13px]">{actionTitle(proposal.action, 0, null)}</span>
              <span className={`smallcaps ${proposal.state === 'ready' ? '' : 'muted'}`}>
                {proposal.state}
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
    </section>
  )
}

// ─── Grant or rotate: a proposal ─────────────────────────────────────────────

function Propose({ current }: { current: { key: string; mask: number } }) {
  const api = useApi()
  const navigate = useNavigate()
  const { state, run } = useRun()
  const [key, setKey] = useState(current.key)
  const [powers, setPowers] = useState<PowerName[]>(() =>
    ALL_POWERS.filter((power) => hasPower(current.mask, DELEGATION[power])),
  )
  const [days, setDays] = useState('3')
  const [error, setError] = useState<string | undefined>(undefined)

  const mask = maskOf(powers)
  const rotation = key.trim() !== current.key
  const unchanged = !rotation && mask === current.mask
  const narrowingOnly = !rotation && (mask & ~current.mask) === 0

  const submit = async () => {
    const termSeconds = Math.round(Number(days) * DAY)
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(key.trim())) {
      setError('the key is a base58 address')
      return
    }
    if (!Number.isFinite(termSeconds) || termSeconds < 3600 || termSeconds > 30 * DAY) {
      setError('a proposal lives between one hour and 30 days')
      return
    }
    setError(undefined)
    const raised = await run(() =>
      api.post(
        '/api/issuer/delegation/proposals',
        { operationalKey: key.trim(), mask, termSeconds },
        proposeDelegationResponseSchema,
      ),
    )
    if (raised !== undefined) navigate(`/console/actions/${raised.proposal}`)
  }

  return (
    <section className="mt-12 max-w-[46rem]">
      <h2 className="section-head block">Grant or rotate</h2>
      <p className="muted mt-3 text-[12px] leading-relaxed">
        Handing the platform a power, or moving the powers to another key, takes the quorum: your
        signature raises the proposal, and nothing changes until another member signs and someone
        executes it.
      </p>
      <Field label="Key" value={key} onChange={setKey} mono />
      <div className="mt-2">
        {ALL_POWERS.map((power) => (
          <Tick
            key={power}
            checked={powers.includes(power)}
            onChange={(on) =>
              setPowers((previous) =>
                on ? [...previous, power] : previous.filter((name) => name !== power),
              )
            }
          >
            {POWER_TEXT[power].label} <span className="mono12 muted">{power}</span>
          </Tick>
        ))}
      </div>
      <Field label="Proposal lives (days)" value={days} onChange={setDays} mono />

      <p className="mono12 muted mt-4">
        {unchanged
          ? 'This is the delegation as it stands.'
          : `${rotation ? `New key ${truncate(key.trim(), 6, 4)} would hold` : 'The key would hold'} ${describeMask(mask)}.`}
      </p>
      {narrowingOnly && !unchanged && (
        <p className="muted mt-1 text-[12px]">
          Only taking powers away? Revoke them above — one signature, in force at once.
        </p>
      )}
      {error && <p className="refuse mt-2 text-[12px]">{error}</p>}

      <div className="mt-5">
        <button
          type="button"
          className="btn-primary"
          disabled={unchanged || isBusy(state)}
          onClick={() => void submit()}
        >
          {rotation ? 'Propose the new key' : 'Propose the grant'}
        </button>
      </div>
      <RunLine state={state} />
    </section>
  )
}

// ─── History ─────────────────────────────────────────────────────────────────

function History({ rows }: { rows: readonly DelegationChange[] }) {
  return (
    <section className="mt-12">
      <h2 className="section-head block">Changes</h2>
      {rows.length === 0 ? (
        <p className="muted mt-3 text-[13px]">
          No change since the issuer was created. The delegation above is the one it was founded
          with.
        </p>
      ) : (
        <ul>
          {rows.map((row) => {
            const kind = changeKind(row)
            return (
              <li
                key={row.signature}
                className="grid grid-cols-1 items-baseline gap-x-5 gap-y-1 border-b border-hairline py-3 md:grid-cols-[9rem_7rem_1fr_9rem]"
              >
                <span className="mono12">
                  {row.blockTime === null ? `slot ${row.slot}` : `${utc(row.blockTime)}`}
                </span>
                <span className={`smallcaps ${kind === 'revocation' ? '' : 'muted'}`}>
                  {CHANGE_LABEL[kind]}
                </span>
                <span className="text-[13px]">
                  {describeMask(row.previousMask)} → {describeMask(row.mask)}
                  {kind === 'rotation' && (
                    <span className="mono12 muted ml-2">
                      key {truncate(row.previousKey ?? '—', 6, 4)} →{' '}
                      {truncate(row.operationalKey, 6, 4)}
                    </span>
                  )}
                  <span className="mono12 muted block">
                    {row.path === 'immediate' ? 'signed by ' : 'by proposal, approved by '}
                    {row.signers.map((signer) => truncate(signer, 6, 4)).join(', ')}
                  </span>
                </span>
                <span className="mono12 muted md:text-right" title={row.signature}>
                  {truncate(row.signature, 8, 6)}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      <p className="muted mt-3 text-[12px] leading-relaxed">
        From the platform’s indexer. Each line names its transaction, so it can be checked against
        the network without this console.
      </p>
    </section>
  )
}
