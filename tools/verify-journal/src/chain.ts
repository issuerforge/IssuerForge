// The network, as the verifier asks it. A plain JSON-RPC endpoint and nothing
// else: no api, no database, no credentials of the issuer (SC-006).
//
// Account state is read raw and decoded here with the IDL's account coder,
// after checking the account belongs to the program: a lookalike account
// with the right bytes but another owner would otherwise answer for ours.
import { BorshAccountsCoder, type Idl } from '@coral-xyz/anchor'
import { IDL, tokenConfigPda } from '@forge/chain'
import { RULE_SLOT_BYTES } from '@forge/policy/model'
import { TOKEN_2022_PROGRAM_ID, unpackAccount } from '@solana/spl-token'
import {
  type Commitment,
  type Connection,
  type Finality,
  PublicKey,
  type VersionedTransactionResponse,
} from '@solana/web3.js'
import type { ChainState, TokenFacts } from './decode.ts'

/** A transaction that mentions the program, as the signature index lists it. */
export interface Mention {
  readonly signature: string
  readonly slot: number
}

/** What the verification needs from the network, as one seam for tests. */
export interface Chain {
  readonly state: ChainState
  /** The highest slot the chain has finalized. */
  finalizedSlot(): Promise<number>
  /** Every transaction mentioning `programId` in `fromSlot…toSlot`, failed ones included. */
  mentions(programId: string, fromSlot: number, toSlot: number): Promise<Mention[]>
  transaction(signature: string): Promise<VersionedTransactionResponse | null>
}

const accounts = new BorshAccountsCoder(IDL as unknown as Idl)

/**
 * A `fetch` for public endpoints, which answer a burst with 429 as a matter
 * of course. Requests are spaced to a steady rate, and a 429, a 5xx or a
 * dropped connection is retried with a growing pause (or the one the node
 * asks for). `Connection`'s own retry gives up after five quick tries, and a
 * verifier that gives up reports every line it could not read as
 * unconfirmed — a failed verification that says nothing about the journal.
 */
export function patientFetch(perSecond = 4, attempts = 8): typeof fetch {
  const spacing = 1000 / perSecond
  let next = 0
  const turn = async (): Promise<void> => {
    const now = Date.now()
    const at = Math.max(now, next)
    next = at + spacing
    if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now))
  }
  return async (input, init) => {
    for (let attempt = 1; ; attempt += 1) {
      await turn()
      let response: Response | undefined
      try {
        response = await fetch(input, init)
      } catch (error) {
        if (attempt >= attempts) throw error
      }
      if (response !== undefined && response.status !== 429 && response.status < 500) {
        return response
      }
      if (attempt >= attempts && response !== undefined) return response
      const asked = Number(response?.headers.get('retry-after'))
      const pause =
        Number.isFinite(asked) && asked > 0 ? asked * 1000 : Math.min(30_000, 500 * 2 ** attempt)
      await new Promise((resolve) => setTimeout(resolve, pause))
    }
  }
}

/** The getSignaturesForAddress page limit. */
const PAGE = 1000

export function rpcChain(connection: Connection, programId: string): Chain {
  const program = new PublicKey(programId)
  const commitment: Finality = 'finalized'

  const known = new Map<string, Promise<unknown>>()
  /** Decoded program account, or `undefined` if it is missing, foreign or of another type. */
  function read<T>(name: string, address: string): Promise<T | undefined> {
    const cacheKey = `${name}:${address}`
    const hit = known.get(cacheKey)
    if (hit !== undefined) return hit as Promise<T | undefined>
    const reading = (async () => {
      const info = await connection.getAccountInfo(new PublicKey(address), commitment as Commitment)
      if (info === null || !info.owner.equals(program)) return undefined
      try {
        return accounts.decode<T>(name, info.data)
      } catch {
        return undefined
      }
    })()
    known.set(cacheKey, reading)
    return reading
  }

  type Key = { toBase58(): string }
  type Int = { toString(): string }

  const state: ChainState = {
    async issuerIdOf(issuerConfig) {
      const config = await read<{ issuerId: Key }>('issuerConfig', issuerConfig)
      return config?.issuerId.toBase58()
    },
    async tokenAt(tokenConfig): Promise<TokenFacts | undefined> {
      const config = await read<{ mint: Key; issuer: Key; attestationMaxAge: Int }>(
        'tokenConfig',
        tokenConfig,
      )
      if (config === undefined) return undefined
      const issuerId = await state.issuerIdOf(config.issuer.toBase58())
      if (issuerId === undefined) return undefined
      return {
        mint: config.mint.toBase58(),
        issuerId,
        attestationMaxAge: Number(config.attestationMaxAge.toString()),
      }
    },
    async rulesAt(policyConfig) {
      const policy = await read<{ rules: { kind: number; op: number; params: number[] }[] }>(
        'policyConfig',
        policyConfig,
      )
      if (policy === undefined) return undefined
      const bytes = new Uint8Array(policy.rules.length * RULE_SLOT_BYTES)
      policy.rules.forEach((slot, index) => {
        bytes.set([slot.kind, slot.op, ...slot.params], index * RULE_SLOT_BYTES)
      })
      return bytes
    },
    async attestationIndexAt(attestation) {
      const record = await read<{ index: Int }>('reserveAttestation', attestation)
      return record === undefined ? undefined : Number(record.index.toString())
    },
    async ownerOf(tokenAccount) {
      // Only asked when the transaction's balances did not name the owner,
      // and not cached: unlike the program's accounts, an owner can change.
      const key = new PublicKey(tokenAccount)
      const info = await connection.getAccountInfo(key, commitment as Commitment)
      if (info === null) return undefined
      try {
        return unpackAccount(key, info, TOKEN_2022_PROGRAM_ID).owner.toBase58()
      } catch {
        return undefined
      }
    },
  }

  return {
    state,
    finalizedSlot: () => connection.getSlot('finalized'),

    async mentions(address, fromSlot, toSlot) {
      // The index runs newest first; page back until the window's start is behind us.
      const found: Mention[] = []
      let before: string | undefined
      for (;;) {
        const page = await connection.getSignaturesForAddress(
          new PublicKey(address),
          before === undefined ? { limit: PAGE } : { limit: PAGE, before },
          commitment,
        )
        for (const entry of page) {
          if (entry.slot >= fromSlot && entry.slot <= toSlot) {
            found.push({ signature: entry.signature, slot: entry.slot })
          }
        }
        const last = page.at(-1)
        if (last === undefined || page.length < PAGE || last.slot < fromSlot) return found
        before = last.signature
      }
    },

    transaction: (signature) =>
      connection.getTransaction(signature, { commitment, maxSupportedTransactionVersion: 0 }),
  }
}

/** The `TokenConfig` the program derives for a mint. */
export function tokenConfigAddress(mint: string, programId: string): string {
  return tokenConfigPda(new PublicKey(mint), new PublicKey(programId)).toBase58()
}
