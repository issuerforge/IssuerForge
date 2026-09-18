// The three issuance transactions: assemble, sign, send, await.
//
// **The browser signs, the browser sends.** The api has no issuer keys, and
// the contract has no relay route either: the signed bytes go straight to the
// node whose address the console reads from its own environment. That node
// is public and keyless — precisely because the address is visible to
// everyone who opens the page.
//
// **The order is not decorative.** `set_token_metadata` and
// `initialize_extra_account_meta_list` read a `TokenConfig` that does not
// exist until `create_token` is confirmed (T018, T020), so each next one is
// sent only after the previous is confirmed. Without that the second
// transaction fails on an account that does not exist yet, and it looks like
// an assembly error.
import {
  type CreateTokenBody,
  type CreateTokenResponse,
  createTokenResponseSchema,
} from '@forge/api/contracts'
import { bytesFromBase64 } from '@forge/chain/plan'
import { useSignTransaction, useWallets } from '@privy-io/react-auth/solana'
import { Connection } from '@solana/web3.js'
import { useCallback, useMemo, useState } from 'react'
import { useApi } from '@/auth/providers'
import { planSignatures, type SigningPlan, waitForConfirmation } from './issuance.ts'

export type TxPhase = 'waiting' | 'signing' | 'sending' | 'confirming' | 'confirmed' | 'failed'

export interface TxProgress {
  readonly step: SigningPlan['step']
  readonly phase: TxPhase
  readonly signature?: string
  readonly error?: string
}

export interface IssueState {
  /** Assembled but not yet signed: three transactions and the addresses known in advance. */
  assembled: CreateTokenResponse | undefined
  plans: SigningPlan[]
  progress: readonly TxProgress[]
  busy: boolean
  error: string | undefined
  assemble: (body: CreateTokenBody) => Promise<void>
  submit: () => Promise<void>
  /** Back to editing: the assembled result is dropped, the token number frees itself. */
  reset: () => void
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function useIssue(rpcUrl: string): IssueState {
  const api = useApi()
  const { wallets } = useWallets()
  const { signTransaction } = useSignTransaction()

  const [assembled, setAssembled] = useState<CreateTokenResponse | undefined>(undefined)
  const [progress, setProgress] = useState<readonly TxProgress[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const connected = useMemo(() => wallets.map((wallet) => wallet.address), [wallets])

  const plans = useMemo(
    () => (assembled === undefined ? [] : planSignatures(assembled.transactions, connected)),
    [assembled, connected],
  )

  const assemble = useCallback(
    async (body: CreateTokenBody) => {
      setBusy(true)
      setError(undefined)
      try {
        const response = await api.post('/api/tokens', body, createTokenResponseSchema)
        setAssembled(response)
        setProgress(response.transactions.map((tx) => ({ step: tx.step, phase: 'waiting' })))
      } catch (cause) {
        setError(message(cause))
      } finally {
        setBusy(false)
      }
    },
    [api],
  )

  const submit = useCallback(async () => {
    if (assembled === undefined) return

    const connection = new Connection(rpcUrl, 'confirmed')
    const advance = (index: number, patch: Partial<TxProgress>) =>
      setProgress((previous) =>
        previous.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
      )

    setBusy(true)
    setError(undefined)

    try {
      for (const [index, plan] of plans.entries()) {
        advance(index, { phase: 'signing' })

        // The signatures are put on in turn over **the same bytes**: each wallet
        // adds its own into its own slot, and the transaction cannot be
        // assembled a second time between signatures — a signature is over
        // specific bytes (T020).
        let bytes = bytesFromBase64(plan.base64)
        for (const signer of plan.signers) {
          const wallet = wallets.find((candidate) => candidate.address === signer.address)
          if (wallet === undefined) {
            throw new Error(`this session has no wallet for ${signer.address}`)
          }
          const { signedTransaction } = await signTransaction({ transaction: bytes, wallet })
          bytes = signedTransaction
        }

        advance(index, { phase: 'sending' })
        const signature = await connection.sendRawTransaction(bytes, {
          preflightCommitment: 'confirmed',
        })

        advance(index, { phase: 'confirming', signature })
        await waitForConfirmation(connection, signature)
        advance(index, { phase: 'confirmed', signature })
      }
    } catch (cause) {
      const failed = progressIndexOf(plans.length)
      setError(message(cause))
      setProgress((previous) =>
        previous.map((entry, i) =>
          i === failed(previous) ? { ...entry, phase: 'failed', error: message(cause) } : entry,
        ),
      )
    } finally {
      setBusy(false)
    }
  }, [assembled, plans, rpcUrl, signTransaction, wallets])

  const reset = useCallback(() => {
    setAssembled(undefined)
    setProgress([])
    setError(undefined)
  }, [])

  return { assembled, plans, progress, busy, error, assemble, submit, reset }
}

/**
 * Which transaction to mark as failed.
 *
 * The one that did not reach `confirmed` — i.e. the first unfinished one.
 * Marking the last would be a lie: the issuance stops at the first that did
 * not pass, and the rest were never even sent.
 */
const progressIndexOf =
  (total: number) =>
  (progress: readonly TxProgress[]): number => {
    const index = progress.findIndex((entry) => entry.phase !== 'confirmed')
    return index === -1 ? total - 1 : index
  }
