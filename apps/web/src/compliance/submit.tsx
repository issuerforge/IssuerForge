// Signing and sending one transaction the api assembled — as a seam.
//
// The screens ask for "submit this", not for Privy: the officer's screen is
// the first one with a dev stand (`src/stand/`), and the stand must draw the
// real screens without a login provider or a node. The Privy implementation
// lives in its own module (`privy-submitter.tsx`) so that importing a screen
// does not import signing.
import type { UnsignedTransactionView } from '@forge/api/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { createContext, type ReactNode, useCallback, useContext, useState } from 'react'
import { ApiRequestError } from '@/api/client'

export type SubmitPhase = 'signing' | 'sending' | 'confirming'

export interface Submitter {
  /** Resolves with the signature once the transaction is `confirmed`; rejects otherwise. */
  submit(tx: UnsignedTransactionView, onPhase: (phase: SubmitPhase) => void): Promise<string>
}

const SubmitterContext = createContext<Submitter | null>(null)

export function ProvideSubmitter({ value, children }: { value: Submitter; children: ReactNode }) {
  return <SubmitterContext.Provider value={value}>{children}</SubmitterContext.Provider>
}

export function useSubmitter(): Submitter {
  const ctx = useContext(SubmitterContext)
  if (!ctx) throw new Error('useSubmitter must be used inside a submitter provider')
  return ctx
}

export type RunState =
  | { status: 'idle' }
  | { status: 'assembling' }
  | { status: SubmitPhase }
  | { status: 'done'; signature: string }
  | { status: 'failed'; message: string; requestId?: string }

export const isBusy = (state: RunState) =>
  state.status === 'assembling' ||
  state.status === 'signing' ||
  state.status === 'sending' ||
  state.status === 'confirming'

/**
 * Assemble on the api, sign, send, wait — then refetch what the action changed.
 *
 * Every query is invalidated, not a chosen few: a freeze changes the totals,
 * an execution changes the proposal, the totals and the pause, and a list of
 * which action touches which read would be one more thing to get wrong. The
 * reads go to the chain at `confirmed`, the level this waited for.
 */
export function useRun() {
  const submitter = useSubmitter()
  const queries = useQueryClient()
  const [state, setState] = useState<RunState>({ status: 'idle' })

  const run = useCallback(
    async <T extends { transaction: UnsignedTransactionView }>(
      assemble: () => Promise<T>,
    ): Promise<T | undefined> => {
      setState({ status: 'assembling' })
      try {
        const assembled = await assemble()
        const signature = await submitter.submit(assembled.transaction, (phase) =>
          setState({ status: phase }),
        )
        setState({ status: 'done', signature })
        await queries.invalidateQueries()
        return assembled
      } catch (cause) {
        setState({
          status: 'failed',
          message: cause instanceof Error ? cause.message : String(cause),
          ...(cause instanceof ApiRequestError ? { requestId: cause.requestId } : {}),
        })
        return undefined
      }
    },
    [queries, submitter],
  )

  const reset = useCallback(() => setState({ status: 'idle' }), [])
  return { state, run, reset }
}

const PHASE_TEXT: Record<RunState['status'], string> = {
  idle: '',
  assembling: 'Assembling the transaction…',
  signing: 'Waiting for your wallet’s signature…',
  sending: 'Sending to the network…',
  confirming: 'Waiting for confirmation…',
  done: 'Confirmed.',
  failed: '',
}

/** One line under an action button: where it is, or why it stopped. */
export function RunLine({ state }: { state: RunState }) {
  if (state.status === 'idle') return null
  if (state.status === 'failed') {
    return (
      <p className="refuse mt-3 text-[12px] leading-relaxed">
        {state.message}
        {state.requestId && <span className="mono12 muted ml-2">request {state.requestId}</span>}
      </p>
    )
  }
  return (
    <p className="mono12 muted mt-3 break-all">
      {PHASE_TEXT[state.status]}
      {state.status === 'done' && <span className="ml-2">{state.signature}</span>}
    </p>
  )
}
