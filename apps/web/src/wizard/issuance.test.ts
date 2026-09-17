import type { UnsignedTransactionView } from '@forge/api/contracts'
import { describe, expect, it, vi } from 'vitest'
import {
  absentSigners,
  ConfirmationError,
  planSignatures,
  type SignatureReader,
  signatureCount,
  waitForConfirmation,
} from './issuance.ts'

const FOUNDER = 'SysvarC1ock11111111111111111111111111111111'
const ATTESTOR = 'SysvarRent111111111111111111111111111111111'
const SIGNATURE = '5'.repeat(88)

const transactions: UnsignedTransactionView[] = [
  {
    step: 'create-token',
    base64: 'AAAA',
    signers: [FOUNDER, ATTESTOR],
    dependsOnPrevious: false,
    bytes: 1180,
  },
  {
    step: 'token-metadata',
    base64: 'BBBB',
    signers: [FOUNDER],
    dependsOnPrevious: true,
    bytes: 417,
  },
  {
    step: 'hook-accounts',
    base64: 'CCCC',
    signers: [FOUNDER],
    dependsOnPrevious: true,
    bytes: 312,
  },
]

describe('the signing plan', () => {
  // Головне число цього екрана: підписів три транзакції й чотири підписи, а не
  // одна кнопка «підписати» (борг T020).
  it('counts signatures per transaction, not per button', () => {
    const plans = planSignatures(transactions, [FOUNDER, ATTESTOR])

    expect(plans).toHaveLength(3)
    expect(signatureCount(plans)).toBe(4)
  })

  it('keeps the signer order the api named', () => {
    const [first] = planSignatures(transactions, [FOUNDER, ATTESTOR])

    // Платник перший — саме в цьому порядку консоль питає підписи.
    expect(first?.signers.map((s) => s.address)).toEqual([FOUNDER, ATTESTOR])
  })

  it('marks whose wallets are in this session', () => {
    const plans = planSignatures(transactions, [FOUNDER])

    expect(plans[0]?.signers).toEqual([
      { address: FOUNDER, connected: true },
      { address: ATTESTOR, connected: false },
    ])
  })

  // Найчастіший випадок не помилка, а робота: атестатор стоїть у складі
  // окремим гаманцем і в консоль не входить (FR-024).
  it('names a missing signer once', () => {
    const plans = planSignatures(transactions, [FOUNDER])

    expect(absentSigners(plans)).toEqual([ATTESTOR])
  })

  it('when every wallet is at hand, nobody is missing', () => {
    expect(absentSigners(planSignatures(transactions, [FOUNDER, ATTESTOR]))).toEqual([])
  })

  it('carries the ban on sending as a batch', () => {
    const plans = planSignatures(transactions, [FOUNDER, ATTESTOR])

    expect(plans.map((plan) => plan.dependsOnPrevious)).toEqual([false, true, true])
  })
})

describe('awaiting confirmation', () => {
  const reader = (statuses: readonly (object | null)[]): SignatureReader => {
    let call = 0
    return {
      getSignatureStatuses: vi.fn(async () => {
        const value = statuses[Math.min(call, statuses.length - 1)] ?? null
        call += 1
        return { value: [value as never] }
      }),
    }
  }

  const noSleep = async () => {}

  it('returns when the transaction is confirmed', async () => {
    const source = reader([
      null,
      { confirmationStatus: 'processed', err: null },
      { confirmationStatus: 'confirmed', err: null },
    ])

    await expect(
      waitForConfirmation(source, SIGNATURE, { sleep: noSleep }),
    ).resolves.toBeUndefined()
  })

  it('finalized counts as confirmed too', async () => {
    const source = reader([{ confirmationStatus: 'finalized', err: null }])

    await expect(
      waitForConfirmation(source, SIGNATURE, { sleep: noSleep }),
    ).resolves.toBeUndefined()
  })

  it('a network refusal is a refusal, not a wait', async () => {
    const source = reader([{ confirmationStatus: 'confirmed', err: { InstructionError: [0] } }])

    await expect(waitForConfirmation(source, SIGNATURE, { sleep: noSleep })).rejects.toBeInstanceOf(
      ConfirmationError,
    )
  })

  /**
   * Строк — не «не вдалося»: транзакція могла пройти й після нього. Різниця
   * важлива, бо повторна відправка тієї самої випускної транзакції отримає
   * «акаунт уже існує», і сказати людині треба саме це.
   */
  it('a timeout says the transaction may still land', async () => {
    const source = reader([null])

    await expect(
      waitForConfirmation(source, SIGNATURE, { attempts: 3, sleep: noSleep }),
    ).rejects.toThrow('may still land')
    expect(source.getSignatureStatuses).toHaveBeenCalledTimes(3)
  })
})
