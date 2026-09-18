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

/** A plan the operational key signs by itself. */
const routine = () =>
  toPlan('thaw-holder', OPERATIONAL.publicKey, [
    SystemProgram.transfer({
      fromPubkey: OPERATIONAL.publicKey,
      toPubkey: OTHER,
      lamports: 1,
    }),
  ])

/** A plan lacking someone else's signature — i.e. an action that moves someone else's funds. */
const foreign = () =>
  toPlan('thaw-holder', OPERATIONAL.publicKey, [
    SystemProgram.transfer({ fromPubkey: OTHER, toPubkey: OPERATIONAL.publicKey, lamports: 1 }),
  ])

/**
 * The connection stub is described with its own types, not `Connection`'s:
 * `confirmTransaction` also returns a `context` with a slot that affects
 * nothing here, and repeating it in every test would mean noise instead of
 * intent.
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
    // The signature is actually put on, not left as zeros: an unsigned
    // transaction serialises to the same size, so the bytes are what to check.
    expect(transaction?.signatures[0]?.some((byte) => byte !== 0)).toBe(true)
    expect(transaction?.message.recentBlockhash).toBe(BLOCKHASH)
  })

  /**
   * The main property of this file: the platform key signs nothing that needs
   * anyone else's signature (FR-035a, SC-012). The program checks this itself,
   * but an action with funds must not reach the network even to be refused.
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

  // Preflight may let through a transaction that fails in the block: then the
  // number comes from the confirmation, not from the logs.
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
