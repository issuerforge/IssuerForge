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

describe('план підписів', () => {
  // Головне число цього екрана: підписів три транзакції й чотири підписи, а не
  // одна кнопка «підписати» (борг T020).
  it('рахує підписи по транзакціях, а не по кнопках', () => {
    const plans = planSignatures(transactions, [FOUNDER, ATTESTOR])

    expect(plans).toHaveLength(3)
    expect(signatureCount(plans)).toBe(4)
  })

  it('зберігає порядок підписантів, який назвав api', () => {
    const [first] = planSignatures(transactions, [FOUNDER, ATTESTOR])

    // Платник перший — саме в цьому порядку консоль питає підписи.
    expect(first?.signers.map((s) => s.address)).toEqual([FOUNDER, ATTESTOR])
  })

  it('позначає, чиї гаманці є в цій сесії', () => {
    const plans = planSignatures(transactions, [FOUNDER])

    expect(plans[0]?.signers).toEqual([
      { address: FOUNDER, connected: true },
      { address: ATTESTOR, connected: false },
    ])
  })

  // Найчастіший випадок не помилка, а робота: атестатор стоїть у складі
  // окремим гаманцем і в консоль не входить (FR-024).
  it('називає відсутнього підписанта один раз', () => {
    const plans = planSignatures(transactions, [FOUNDER])

    expect(absentSigners(plans)).toEqual([ATTESTOR])
  })

  it('коли всі гаманці під рукою, відсутніх немає', () => {
    expect(absentSigners(planSignatures(transactions, [FOUNDER, ATTESTOR]))).toEqual([])
  })

  it('несе заборону надсилати пачкою', () => {
    const plans = planSignatures(transactions, [FOUNDER, ATTESTOR])

    expect(plans.map((plan) => plan.dependsOnPrevious)).toEqual([false, true, true])
  })
})

describe('очікування підтвердження', () => {
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

  it('повертається, коли транзакція підтверджена', async () => {
    const source = reader([
      null,
      { confirmationStatus: 'processed', err: null },
      { confirmationStatus: 'confirmed', err: null },
    ])

    await expect(
      waitForConfirmation(source, SIGNATURE, { sleep: noSleep }),
    ).resolves.toBeUndefined()
  })

  it('фіналізована теж підтверджена', async () => {
    const source = reader([{ confirmationStatus: 'finalized', err: null }])

    await expect(
      waitForConfirmation(source, SIGNATURE, { sleep: noSleep }),
    ).resolves.toBeUndefined()
  })

  it('відмова мережі — це відмова, а не очікування', async () => {
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
  it('вичерпаний строк каже, що транзакція ще може дійти', async () => {
    const source = reader([null])

    await expect(
      waitForConfirmation(source, SIGNATURE, { attempts: 3, sleep: noSleep }),
    ).rejects.toThrow('may still land')
    expect(source.getSignatureStatuses).toHaveBeenCalledTimes(3)
  })
})
