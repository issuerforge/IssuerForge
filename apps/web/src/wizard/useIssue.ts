// Три транзакції випуску: зібрати, підписати, відправити, дочекатись.
//
// **Підписує браузер, відправляє браузер.** Ключів емітента api не має, і
// маршруту-ретранслятора в контракті немає теж: підписані байти йдуть просто у
// вузол, адресу якого консоль читає з власного оточення. Вузол там публічний і
// без ключа — саме тому, що цю адресу видно кожному, хто відкрив сторінку.
//
// **Порядок не декоративний.** `set_token_metadata` і
// `initialize_extra_account_meta_list` читають `TokenConfig`, якого до
// підтвердження `create_token` не існує (T018, T020), тож кожна наступна
// відправляється тільки після підтвердження попередньої. Без цього друга
// транзакція падає на акаунті, якого ще немає, і виглядає це як помилка збірки.
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
  /** Зібране, але ще не підписане: три транзакції й адреси, відомі наперед. */
  assembled: CreateTokenResponse | undefined
  plans: SigningPlan[]
  progress: readonly TxProgress[]
  busy: boolean
  error: string | undefined
  assemble: (body: CreateTokenBody) => Promise<void>
  submit: () => Promise<void>
  /** Повернутись до правки: зібране скидається, номер токена звільниться сам. */
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

        // Підписи ставляться по черзі на **ті самі байти**: кожен гаманець
        // дописує свій у власний слот, і зібрати транзакцію вдруге між
        // підписами не можна — підпис стосується конкретних байтів (T020).
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
 * Яку транзакцію позначити невдалою.
 *
 * Ту, що не дійшла до `confirmed`, — тобто першу незавершену. Позначати
 * останню було б неправдою: випуск зупиняється на першій, що не пройшла, а
 * решта навіть не відправлялась.
 */
const progressIndexOf =
  (total: number) =>
  (progress: readonly TxProgress[]): number => {
    const index = progress.findIndex((entry) => entry.phase !== 'confirmed')
    return index === -1 ? total - 1 : index
  }
