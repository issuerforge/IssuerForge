// Test fixtures: node answers built from instructions, and one world of
// account state that both the verifier and the indexer can be asked about.
//
// The answers are `VersionedTransactionResponse`s, not anybody's flattened
// view, so that each side's own flattening is under test as well.
import { BN, BorshInstructionCoder, type Idl } from '@coral-xyz/anchor'
import { encodeBase58, IDL, issuerConfigPda, PROGRAM_ID, tokenConfigPda } from '@forge/chain'
import { encodeRules } from '@forge/policy/layout'
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { Keypair, PublicKey, type VersionedTransactionResponse } from '@solana/web3.js'
import type { Chain, Mention } from '../chain.ts'
import type { ChainState, TokenFacts } from '../decode.ts'

export const PROGRAM = PROGRAM_ID.toBase58()
export const TOKEN_2022 = TOKEN_2022_PROGRAM_ID.toBase58()

export const key = (): string => Keypair.generate().publicKey.toBase58()

/** A real-looking 64-byte signature, distinct per call. */
export function signature(): string {
  return encodeBase58(Keypair.generate().secretKey)
}

export const ISSUER_ID = key()
export const ISSUER_CONFIG = issuerConfigPda(new PublicKey(ISSUER_ID)).toBase58()
export const MINT = key()
export const TOKEN_CONFIG = tokenConfigPda(new PublicKey(MINT)).toBase58()
export const POLICY_CONFIG = key()
export const ATTESTATION = key()
export const FOUNDER = key()
export const OFFICER = key()
export const ADMIN = key()
export const ATTESTOR = key()
export const OPERATIONAL = key()
export const ALICE = key()
export const BOB = key()
export const ALICE_ATA = key()
export const BOB_ATA = key()
/** A token account whose owner the balances never name — asked of the state. */
export const CAROL = key()
export const CAROL_ATA = key()

/** The demo policy: status, jurisdictions, transfer limit, period limit — slots 0…3. */
export const RULES = encodeRules({
  status: { sources: ['register'], minTier: 2 },
  jurisdictions: ['GH', 'NG'],
  transferLimit: '50000000',
  periodLimit: { amount: '200000000', windowSeconds: 86_400 },
})

export const TOKEN: TokenFacts = { mint: MINT, issuerId: ISSUER_ID, attestationMaxAge: 86_400 }

/** The account state behind every fixture. */
export const WORLD = {
  issuers: new Map([[ISSUER_CONFIG, ISSUER_ID]]),
  tokens: new Map([[TOKEN_CONFIG, TOKEN]]),
  rules: new Map([[POLICY_CONFIG, RULES]]),
  attestations: new Map([[ATTESTATION, 7]]),
  owners: new Map([[CAROL_ATA, CAROL]]),
}

export const state: ChainState = {
  issuerIdOf: async (address) => WORLD.issuers.get(address),
  tokenAt: async (address) => WORLD.tokens.get(address),
  ownerOf: async (address) => WORLD.owners.get(address),
  rulesAt: async (address) => WORLD.rules.get(address),
  attestationIndexAt: async (address) => WORLD.attestations.get(address),
}

// ─── Instructions ────────────────────────────────────────────────────────────

const coder = new BorshInstructionCoder(IDL as unknown as Idl)

export interface Ix {
  readonly programId: string
  readonly accounts: readonly string[]
  readonly data: Uint8Array
  readonly inner?: readonly Ix[]
}

export function ours(name: string, args: object, accounts: readonly string[], inner?: Ix[]): Ix {
  const data = Uint8Array.from(coder.encode(name, { args }))
  return inner === undefined
    ? { programId: PROGRAM, accounts, data }
    : { programId: PROGRAM, accounts, data, inner }
}

/** An instruction with no arguments at all (`approveAction`, `closeActionProposal`). */
export function oursBare(name: string, accounts: readonly string[]): Ix {
  return { programId: PROGRAM, accounts, data: Uint8Array.from(coder.encode(name, {})) }
}

export function ascii(text: string, width: number): number[] {
  const bytes = new Array<number>(width).fill(0)
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i)
  return bytes
}

export const reason = (code: number, caseRef: string) => ({ code, caseRef: ascii(caseRef, 32) })
export const STATUS = { tier: 2, jurisdiction: ascii('NG', 2), denied: false, expiresAt: new BN(0) }

/** A `TransferChecked` with the hook's extra accounts, as the token program receives it. */
export function transferChecked(
  amount: bigint,
  parties: { source: string; destination: string; authority: string; mint?: string } = {
    source: ALICE_ATA,
    destination: BOB_ATA,
    authority: ALICE,
  },
  hooked = true,
): Ix {
  const data = new Uint8Array(10)
  data[0] = 12
  new DataView(data.buffer).setBigUint64(1, amount, true)
  data[9] = 2
  const extras = hooked ? [TOKEN_CONFIG, POLICY_CONFIG, key(), key(), key(), PROGRAM, key()] : []
  return {
    programId: TOKEN_2022,
    accounts: [
      parties.source,
      parties.mint ?? MINT,
      parties.destination,
      parties.authority,
      ...extras,
    ],
    data,
  }
}

/** A token-program instruction that is not a transfer (burn 8, mint-to 7). */
export const tokenOp = (tag: number): Ix => ({
  programId: TOKEN_2022,
  accounts: [key(), MINT],
  data: Uint8Array.from([tag, 1, 0, 0, 0, 0, 0, 0, 0]),
})

// ─── Node answers ────────────────────────────────────────────────────────────

export interface TxShape {
  readonly instructions: readonly Ix[]
  readonly signature?: string
  readonly slot?: number
  readonly blockTime?: number | null
  readonly err?: unknown
  /** Token account → owner, as the node's balances would carry them. */
  readonly balances?: readonly (readonly [string, string])[]
  /** Move the last N keys of the message into an address lookup table. */
  readonly lookedUp?: number
}

export const DEFAULT_BALANCES = [
  [ALICE_ATA, ALICE],
  [BOB_ATA, BOB],
] as const

export function response(shape: TxShape): VersionedTransactionResponse {
  const order: string[] = []
  const index = (address: string): number => {
    const at = order.indexOf(address)
    if (at >= 0) return at
    order.push(address)
    return order.length - 1
  }
  const compile = (ix: Ix) => ({
    programIdIndex: index(ix.programId),
    accountKeyIndexes: ix.accounts.map(index),
    data: ix.data,
  })

  const compiled = shape.instructions.map(compile)
  const innerInstructions = shape.instructions.flatMap((ix, outer) =>
    ix.inner === undefined || ix.inner.length === 0
      ? []
      : [
          {
            index: outer,
            instructions: ix.inner.map((inner) => {
              const c = compile(inner)
              return {
                programIdIndex: c.programIdIndex,
                accounts: c.accountKeyIndexes,
                data: encodeBase58(inner.data),
              }
            }),
          },
        ],
  )
  const balances = (shape.balances ?? DEFAULT_BALANCES).map(([account, owner]) => ({
    accountIndex: index(account),
    mint: MINT,
    owner,
    uiTokenAmount: { amount: '0', decimals: 2, uiAmount: 0, uiAmountString: '0' },
  }))

  // Static keys first, then the looked-up ones — exactly how indices resolve.
  const split = order.length - (shape.lookedUp ?? 0)
  const toKey = (address: string) => new PublicKey(address)
  return {
    slot: shape.slot ?? 412_003_881,
    blockTime: shape.blockTime === undefined ? 1_772_600_000 : shape.blockTime,
    transaction: {
      signatures: [shape.signature ?? signature()],
      message: {
        staticAccountKeys: order.slice(0, split).map(toKey),
        compiledInstructions: compiled,
      },
    },
    meta: {
      err: shape.err ?? null,
      loadedAddresses: { writable: [], readonly: order.slice(split).map(toKey) },
      innerInstructions,
      preTokenBalances: balances,
      postTokenBalances: balances,
    },
  } as unknown as VersionedTransactionResponse
}

// ─── A chain made of answers ─────────────────────────────────────────────────

export interface Landed {
  readonly signature: string
  readonly slot: number
  readonly response: VersionedTransactionResponse
}

/** Lands a transaction at a slot under a fresh signature. */
export function landed(slot: number, shape: Omit<TxShape, 'slot' | 'signature'>): Landed {
  const sig = signature()
  return { signature: sig, slot, response: response({ ...shape, slot, signature: sig }) }
}

export function fakeChain(transactions: readonly Landed[], finalized = 500_000_000): Chain {
  const bySignature = new Map(transactions.map((tx) => [tx.signature, tx.response]))
  return {
    state,
    finalizedSlot: async () => finalized,
    mentions: async (_programId, fromSlot, toSlot): Promise<Mention[]> =>
      transactions
        .filter((tx) => tx.slot >= fromSlot && tx.slot <= toSlot)
        .map(({ signature: sig, slot }) => ({ signature: sig, slot })),
    transaction: async (sig) => bySignature.get(sig) ?? null,
  }
}
