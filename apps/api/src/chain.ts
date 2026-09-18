// Reading from the network — exactly what cannot be known without it.
//
// The same shape as `Directory`: an interface plus a factory from a ready
// connection. The server is assembled from dependencies and opens nothing
// itself (T009), so a test brings up the same routes without a node, swapping
// only this object.
//
// **There is no signing here, and there will be none.** `@forge/chain` holds
// no key, and the provider is deliberately made without a wallet (T020):
// everything that changes on-chain state leaves the API as an unsigned
// transaction.
import {
  createForgeProgram,
  type ForgeProgram,
  holderStatusPda,
  issuerConfigPda,
} from '@forge/chain'
import type { Connection, PublicKey } from '@solana/web3.js'

/**
 * What the routes need to know about an issuer from the chain itself.
 *
 * Roles and membership come from the database (the mirror of
 * `IssuerConfig.members`), but these three fields do not: `delegation_mask`
 * decides whether our key may sign, and reading it from the mirror would mean
 * allowing an operation on a state the issuer has already revoked (FR-035b).
 * A revocation is in force from the moment the transaction is confirmed, not
 * from the moment the indexer learns about it.
 */
export interface IssuerConfigView {
  readonly tokenCount: number
  readonly operationalKey: string
  readonly delegationMask: number
}

export interface ChainReader {
  /** The program client: instructions are assembled from it by the IDL. */
  readonly program: ForgeProgram
  /**
   * How many tokens the issuer has already issued, i.e. the number of the
   * next one.
   *
   * `undefined` — there is no `IssuerConfig` on the network: the issuer exists
   * in the database, but its creation transaction is not confirmed. These are
   * different answers, and the route tells them apart rather than showing
   * zero instead of "the issuer does not exist yet".
   */
  tokenCount(issuerId: PublicKey): Promise<number | undefined>
  /** The same account in full — for delegation (T022). `undefined` — the same. */
  issuerConfig(issuerId: PublicKey): Promise<IssuerConfigView | undefined>
  /**
   * Whether this holder's on-chain status record has already been **written**.
   *
   * The question is not "does the account exist": `thaw_holder` creates it
   * together with the counter, and whether to write the status is decided by
   * the `updated_at` field (T016). Zero means "no record yet", and that is
   * exactly the boundary between the first thaw (the status comes with it)
   * and a repeat one (`status: null`, otherwise `HolderStatusAlreadySet`).
   */
  holderStatusWritten(mint: PublicKey, wallet: PublicKey): Promise<boolean>
  /** A fresh blockhash. One for all three issuance transactions (decision T021). */
  latestBlockhash(): Promise<string>
}

/**
 * How long to wait for an RPC answer.
 *
 * `Connection` has no timeout at all: a hung node would hold the console's
 * request until the browser gives up, and the process until the socket does.
 * Five seconds is two reads in a row within the wizard's budget (SC-001,
 * ≤ 5 min) with enormous headroom, and at the same time the limit past which
 * the answer is no longer needed anyway: a blockhash older than that reaches
 * the signature with a shorter life already.
 */
export const RPC_TIMEOUT_MS = 5_000

/**
 * `fetch` with a timeout. Handed to `Connection` at creation — otherwise the
 * timeout would have to be set on every call separately, and the first
 * forgotten call would bring back the behaviour without one.
 */
export function fetchWithTimeout(timeoutMs = RPC_TIMEOUT_MS): typeof globalThis.fetch {
  return (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) })
}

export function createChainReader(connection: Connection): ChainReader {
  const program = createForgeProgram(connection)

  const readIssuerConfig = async (issuerId: PublicKey): Promise<IssuerConfigView | undefined> => {
    const config = await program.account.issuerConfig.fetchNullable(issuerConfigPda(issuerId))
    if (config === null) return undefined

    return {
      tokenCount: config.tokenCount,
      operationalKey: config.operationalKey.toBase58(),
      delegationMask: config.delegationMask,
    }
  }

  return {
    program,

    issuerConfig: readIssuerConfig,

    // Through the same read rather than its own request: two accesses to one
    // account would one day disagree on what counts as the issuer's absence.
    async tokenCount(issuerId) {
      return (await readIssuerConfig(issuerId))?.tokenCount
    },

    async holderStatusWritten(mint, wallet) {
      const status = await program.account.holderStatus.fetchNullable(holderStatusPda(mint, wallet))
      // `!isZero()`, not `!== 0`: Anchor returns i64 as a `BN`, and a comparison
      // with a number would always be true (T020, the same trap from the other
      // side).
      return status !== null && !status.updatedAt.isZero()
    },

    async latestBlockhash() {
      const { blockhash } = await connection.getLatestBlockhash()
      return blockhash
    },
  }
}
