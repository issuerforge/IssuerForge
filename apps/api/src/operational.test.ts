import { encodeBase58, toPlan } from '@forge/chain'
import {
  type Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  type VersionedTransaction,
} from '@solana/web3.js'
import { describe, expect, it, vi } from 'vitest'
import { createOperationalSigner, SubmitError } from './operational.ts'

const OPERATIONAL = Keypair.fromSeed(new Uint8Array(32).fill(9))
const SECRET = encodeBase58(OPERATIONAL.secretKey)
const OTHER = new PublicKey('SysvarC1ock11111111111111111111111111111111')
const BLOCKHASH = 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq2h'
const SIGNATURE = '5'.repeat(88)

/** План, який операційний ключ підписує сам. */
const routine = () =>
  toPlan('thaw-holder', OPERATIONAL.publicKey, [
    SystemProgram.transfer({
      fromPubkey: OPERATIONAL.publicKey,
      toPubkey: OTHER,
      lamports: 1,
    }),
  ])

/** План, якому бракує чужого підпису, — тобто дія, що рухає чужі кошти. */
const foreign = () =>
  toPlan('thaw-holder', OPERATIONAL.publicKey, [
    SystemProgram.transfer({ fromPubkey: OTHER, toPubkey: OPERATIONAL.publicKey, lamports: 1 }),
  ])

/**
 * Заглушка з'єднання описана власними типами, а не типами `Connection`:
 * `confirmTransaction` віддає ще й `context` зі слотом, який тут ні на що не
 * впливає, і повторювати його в кожному тесті означало б шум замість наміру.
 */
type Fakes = {
  send?: () => Promise<string>
  confirm?: () => Promise<{ value: { err: unknown } }>
}

function signer(fakes: Fakes = {}) {
  const sent: VersionedTransaction[] = []

  const connection = {
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 100 }),
    sendTransaction:
      fakes.send ??
      (async (transaction: VersionedTransaction) => {
        sent.push(transaction)
        return SIGNATURE
      }),
    confirmTransaction: fakes.confirm ?? (async () => ({ value: { err: null } })),
  } as unknown as Connection

  return { sent, signer: createOperationalSigner(connection, SECRET) }
}

const failure = async (promise: Promise<unknown>): Promise<SubmitError> => {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(SubmitError)
  return error as SubmitError
}

describe('the operational key', () => {
  it('exposes the address the issuer writes into IssuerConfig', () => {
    expect(signer().signer.publicKey.toBase58()).toBe(OPERATIONAL.publicKey.toBase58())
  })

  it('signs a routine plan and returns the signature', async () => {
    const { signer: operational, sent } = signer()

    expect(await operational.submit(routine())).toBe(SIGNATURE)

    const transaction = sent[0]
    expect(transaction).toBeDefined()
    // Підпис саме поставлений, а не залишений нульовим: непідписана транзакція
    // серіалізується того ж розміру, тож перевіряти треба байти.
    expect(transaction?.signatures[0]?.some((byte) => byte !== 0)).toBe(true)
    expect(transaction?.message.recentBlockhash).toBe(BLOCKHASH)
  })

  /**
   * Головна властивість цього файла: ключ платформи не підписує нічого, що
   * потребує ще чийогось підпису (FR-035a, SC-012). Програма перевіряє це сама,
   * але дія з коштами не має доходити до мережі навіть заради відмови.
   */
  it('refuses to sign a plan with a foreign signer', async () => {
    const { signer: operational, sent } = signer()

    const error = await failure(operational.submit(foreign()))

    expect(error.program).toBeUndefined()
    expect(error.message).toContain('must not give')
    expect(sent).toHaveLength(0)
  })

  it('turns a program refusal into a parsed error', async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error('Simulation failed'), {
        logs: ['Program log: AnchorError occurred. Error Number: 6033. Error Message: no.'],
      })
    })

    const error = await failure(signer({ send }).signer.submit(routine()))

    expect(error.program?.name).toBe('powerNotDelegated')
  })

  // Preflight може пропустити транзакцію, яка відмовиться в блоці: тоді номер
  // приходить із підтвердження, а не з логів.
  it('parses a refusal that arrived from confirmation', async () => {
    const confirm = vi.fn(async () => ({
      value: { err: { InstructionError: [0, { Custom: 6037 }] } },
    }))

    const error = await failure(signer({ confirm }).signer.submit(routine()))

    expect(error.program?.name).toBe('holderStatusRequired')
  })

  it('leaves a network failure without a program code', async () => {
    const send = vi.fn(async () => {
      throw new Error('fetch failed')
    })

    expect((await failure(signer({ send }).signer.submit(routine()))).program).toBeUndefined()
  })
})
