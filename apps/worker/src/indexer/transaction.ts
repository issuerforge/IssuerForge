// A transaction as the decoder wants to see it: every instruction, outer and
// inner, in execution order, with account addresses resolved and instruction
// data as bytes.
//
// The subscription delivers only log lines, and the program writes no
// events into them: it has no `emit!` and no `msg!`. So every transaction is
// fetched in full through `getTransaction`, and this is the one place that
// knows the shape of that answer — versioned messages, address-table
// lookups, base58 inner instruction data, the three shapes of `err`. The
// decoder reads a flat view and never sees any of it.
import { decodeBase58 } from '@forge/chain'
import type { PublicKey, TokenBalance, VersionedTransactionResponse } from '@solana/web3.js'

export interface InstructionView {
  readonly programId: string
  readonly accounts: readonly string[]
  readonly data: Uint8Array
  /** Index of the outer instruction this one belongs to — its own, for an outer one. */
  readonly outerIndex: number
}

/**
 * Why the transaction failed, when it did. `custom` is the program's error
 * number (`{ Custom: n }`), or `null` when the runtime refused it with a
 * named error (`InvalidAccountData`, …) that carries no number.
 */
export interface TransactionFailure {
  readonly outerIndex: number
  readonly custom: number | null
}

export interface TransactionView {
  readonly signature: string
  readonly slot: number
  /** Unix seconds; `null` where the node did not report it. */
  readonly blockTime: number | null
  readonly instructions: readonly InstructionView[]
  readonly failure: TransactionFailure | null
  /**
   * Token account → owner wallet, from the balances the node recorded. The
   * owner is not in the transfer instruction itself, and this is the one
   * source of it that costs no extra request.
   */
  readonly tokenOwners: ReadonlyMap<string, string>
}

/**
 * The account list as the runtime numbers it: the static keys first, then
 * the addresses loaded from lookup tables — writable before readonly. An
 * instruction's `accountKeyIndexes` index this list, not the static one.
 */
function accountKeysOf(response: VersionedTransactionResponse): string[] {
  const loaded = response.meta?.loadedAddresses
  const keys: PublicKey[] = [
    ...response.transaction.message.staticAccountKeys,
    ...(loaded?.writable ?? []),
    ...(loaded?.readonly ?? []),
  ]
  return keys.map((key) => key.toBase58())
}

function failureOf(err: unknown): TransactionFailure | null {
  if (err === null || err === undefined) return null
  if (typeof err !== 'object') return { outerIndex: 0, custom: null }

  const instruction = (err as { InstructionError?: unknown }).InstructionError
  if (!Array.isArray(instruction) || typeof instruction[0] !== 'number') {
    return { outerIndex: 0, custom: null }
  }

  const detail: unknown = instruction[1]
  const custom =
    typeof detail === 'object' && detail !== null
      ? (detail as { Custom?: unknown }).Custom
      : undefined
  return { outerIndex: instruction[0], custom: typeof custom === 'number' ? custom : null }
}

function ownersOf(
  keys: readonly string[],
  ...balances: readonly (readonly TokenBalance[] | null | undefined)[]
): Map<string, string> {
  const owners = new Map<string, string>()
  for (const list of balances) {
    for (const balance of list ?? []) {
      const account = keys[balance.accountIndex]
      if (account !== undefined && balance.owner !== undefined) owners.set(account, balance.owner)
    }
  }
  return owners
}

/**
 * Flattens a node's answer into the view.
 *
 * Inner instructions are placed right after the outer instruction that
 * invoked them, which is the order they executed in — and the order the
 * event indices inside one transaction follow.
 */
export function toTransactionView(
  signature: string,
  response: VersionedTransactionResponse,
): TransactionView {
  const keys = accountKeysOf(response)
  const at = (index: number): string => {
    const key = keys[index]
    if (key === undefined) {
      throw new Error(`${signature}: account index ${index} is outside the ${keys.length} keys`)
    }
    return key
  }

  const innerByOuter = new Map<number, InstructionView[]>()
  for (const group of response.meta?.innerInstructions ?? []) {
    innerByOuter.set(
      group.index,
      group.instructions.map((inner) => ({
        programId: at(inner.programIdIndex),
        accounts: inner.accounts.map(at),
        data: decodeBase58(inner.data),
        outerIndex: group.index,
      })),
    )
  }

  const instructions: InstructionView[] = []
  response.transaction.message.compiledInstructions.forEach((outer, index) => {
    instructions.push({
      programId: at(outer.programIdIndex),
      accounts: outer.accountKeyIndexes.map(at),
      data: outer.data,
      outerIndex: index,
    })
    instructions.push(...(innerByOuter.get(index) ?? []))
  })

  return {
    signature,
    slot: response.slot,
    blockTime: response.blockTime ?? null,
    instructions,
    failure: failureOf(response.meta?.err),
    tokenOwners: ownersOf(keys, response.meta?.preTokenBalances, response.meta?.postTokenBalances),
  }
}
