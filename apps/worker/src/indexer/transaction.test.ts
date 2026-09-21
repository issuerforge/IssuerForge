import { encodeBase58 } from '@forge/chain'
import { Keypair, type PublicKey, type VersionedTransactionResponse } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { toTransactionView } from './transaction.ts'

const keys: PublicKey[] = Array.from({ length: 6 }, () => Keypair.generate().publicKey)
const loaded = {
  writable: [Keypair.generate().publicKey],
  readonly: [Keypair.generate().publicKey],
}
const at = (index: number): string =>
  [...keys, ...loaded.writable, ...loaded.readonly][index]?.toBase58() ?? ''

const SIGNATURE = 'sig'

/** Only the fields the view reads; the rest of the node's answer is not looked at. */
function response(
  overrides: { err?: unknown; innerInstructions?: unknown; blockTime?: number | null } = {},
): VersionedTransactionResponse {
  const meta = {
    err: overrides.err ?? null,
    loadedAddresses: loaded,
    innerInstructions:
      overrides.innerInstructions ??
      ([
        {
          index: 0,
          instructions: [
            { programIdIndex: 3, accounts: [1, 6], data: encodeBase58(Uint8Array.from([9, 9])) },
          ],
        },
      ] as const),
    preTokenBalances: [{ accountIndex: 1, mint: at(4), owner: at(2), uiTokenAmount: {} }],
    postTokenBalances: [
      { accountIndex: 1, mint: at(4), owner: at(2), uiTokenAmount: {} },
      { accountIndex: 7, mint: at(4), owner: at(5), uiTokenAmount: {} },
    ],
  }
  return {
    slot: 100,
    blockTime: overrides.blockTime === undefined ? 1_772_600_000 : overrides.blockTime,
    transaction: {
      signatures: [SIGNATURE],
      message: {
        staticAccountKeys: keys,
        compiledInstructions: [
          { programIdIndex: 0, accountKeyIndexes: [1, 2], data: Uint8Array.from([1]) },
          { programIdIndex: 3, accountKeyIndexes: [7], data: Uint8Array.from([2]) },
        ],
      },
    },
    meta,
  } as unknown as VersionedTransactionResponse
}

describe('toTransactionView', () => {
  it('places inner instructions right after the outer one that invoked them', () => {
    const view = toTransactionView(SIGNATURE, response())
    expect(view.instructions.map((i) => [i.programId, i.outerIndex, [...i.data]])).toEqual([
      [at(0), 0, [1]],
      [at(3), 0, [9, 9]],
      [at(3), 1, [2]],
    ])
  })

  it('numbers loaded addresses after the static keys, writable first', () => {
    const view = toTransactionView(SIGNATURE, response())
    expect(view.instructions[1]?.accounts).toEqual([at(1), at(6)])
    expect(view.instructions[2]?.accounts).toEqual([at(7)])
    expect(at(6)).toBe(loaded.writable[0]?.toBase58())
  })

  it('collects token account owners from both balance lists', () => {
    const view = toTransactionView(SIGNATURE, response())
    expect(view.tokenOwners.get(at(1))).toBe(at(2))
    expect(view.tokenOwners.get(at(7))).toBe(at(5))
  })

  it('reads the failing instruction and its custom code', () => {
    const view = toTransactionView(
      SIGNATURE,
      response({ err: { InstructionError: [1, { Custom: 6009 }] } }),
    )
    expect(view.failure).toEqual({ outerIndex: 1, custom: 6009 })
  })

  it('reads a named runtime error as a failure without a code', () => {
    const view = toTransactionView(
      SIGNATURE,
      response({ err: { InstructionError: [0, 'InvalidAccountData'] } }),
    )
    expect(view.failure).toEqual({ outerIndex: 0, custom: null })
    expect(toTransactionView(SIGNATURE, response({ err: 'AccountNotFound' })).failure).toEqual({
      outerIndex: 0,
      custom: null,
    })
  })

  it('has no failure for a transaction that succeeded', () => {
    expect(toTransactionView(SIGNATURE, response()).failure).toBeNull()
  })

  it('keeps a missing block time as null', () => {
    expect(toTransactionView(SIGNATURE, response({ blockTime: null })).blockTime).toBeNull()
  })

  it('refuses an account index outside the key list rather than guessing', () => {
    const broken = response({
      innerInstructions: [
        { index: 0, instructions: [{ programIdIndex: 40, accounts: [], data: '' }] },
      ],
    })
    expect(() => toTransactionView(SIGNATURE, broken)).toThrow(/account index 40/)
  })
})
