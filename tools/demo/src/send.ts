// Sending transactions, and what the demo exists for in the first place:
// numbers.
//
// **Every send returns a measurement.** CU and lamports are not a by-product
// but the subject of SC-003, and taking them in a separate pass would mean
// measuring a different transaction from the one that went through.
import { compileTransaction, programErrorFrom, type TxPlan, toPlan } from '@forge/chain'
import type {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js'

export interface Sent {
  readonly signature: string
  /** Compute units consumed. `undefined` — the node did not return them. */
  readonly computeUnits: number | undefined
  /** The fee in lamports, as the network charged it. */
  readonly feeLamports: number | undefined
  readonly bytes: number
}

export interface Refused {
  /** Our program's code or a built-in Anchor code, if it parsed. */
  readonly code: number | undefined
  readonly name: string | undefined
  readonly message: string
  /** The simulation log: it shows who exactly refused — the token program or the hook. */
  readonly logs: readonly string[]
}

export class TransactionRefused extends Error {
  readonly detail: Refused

  constructor(detail: Refused) {
    super(detail.message)
    this.name = 'TransactionRefused'
    this.detail = detail
  }
}

function refusalOf(error: unknown): Refused {
  const program = programErrorFrom(error)
  const logs =
    typeof error === 'object' && error !== null && Array.isArray((error as { logs?: unknown }).logs)
      ? ((error as { logs: unknown[] }).logs.filter((l) => typeof l === 'string') as string[])
      : []

  return {
    code: program?.code,
    name: program?.name,
    message: program?.message ?? (error instanceof Error ? error.message : String(error)),
    logs,
  }
}

export async function sign(
  connection: Connection,
  plan: TxPlan,
  signers: readonly Keypair[],
): Promise<VersionedTransaction> {
  const { blockhash } = await connection.getLatestBlockhash()
  const transaction = compileTransaction(plan, blockhash)
  transaction.sign([...signers])
  return transaction
}

/**
 * Sends and awaits confirmation; returns a measurement or throws
 * `TransactionRefused`.
 *
 * Preflight stays on: it is what brings the log with the refusal code
 * **before** the fee is charged, and the SC-002 measurement reads the code,
 * not the mere fact of failure.
 */
export async function send(
  connection: Connection,
  transaction: VersionedTransaction,
): Promise<Sent> {
  const bytes = transaction.serialize().length

  let signature: string
  try {
    signature = await connection.sendTransaction(transaction, { preflightCommitment: 'confirmed' })
  } catch (error) {
    throw new TransactionRefused(refusalOf(error))
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
  const confirmation = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed',
  )
  if (confirmation.value.err !== null) {
    throw new TransactionRefused(refusalOf(confirmation.value.err))
  }

  // `maxSupportedTransactionVersion` is mandatory: the transactions here are
  // versioned (v0), and without it the node answers `null` for every one.
  const detail = await connection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  })

  return {
    signature,
    computeUnits: detail?.meta?.computeUnitsConsumed ?? undefined,
    feeLamports: detail?.meta?.fee ?? undefined,
    bytes,
  }
}

/** Sign and send a ready plan (what the T020 builders assembled). */
export async function submitPlan(
  connection: Connection,
  plan: TxPlan,
  signers: readonly Keypair[],
): Promise<Sent> {
  return await send(connection, await sign(connection, plan, signers))
}

/**
 * The same for instructions the builders do not have.
 *
 * The demo does not only walk product paths: creating an issuer, a transfer
 * bypassing our builders, a call to a foreign program. The step label in
 * `TxPlan` describes the **product** (T020), and adding names to it that do
 * not exist in the product would mean widening its vocabulary for the sake
 * of a measurement tool.
 */
export async function submit(
  connection: Connection,
  feePayer: PublicKey,
  instructions: readonly TransactionInstruction[],
  signers: readonly Keypair[],
): Promise<Sent> {
  return await submitPlan(connection, toPlan('transfer', feePayer, instructions), signers)
}

/**
 * An expected refusal: success here is the refusal itself.
 *
 * Returns the parsed reason, and turns a transaction that **went through**
 * into an error. For SC-002 this is the measurement: one hundred percent of
 * attempts must land here.
 */
export async function expectRefusal(
  connection: Connection,
  feePayer: PublicKey,
  instructions: readonly TransactionInstruction[],
  signers: readonly Keypair[],
): Promise<Refused> {
  try {
    await submit(connection, feePayer, instructions, signers)
  } catch (error) {
    if (error instanceof TransactionRefused) return error.detail
    throw error
  }
  throw new PassedThrough('the transaction went through, and it was not supposed to')
}

/**
 * An attempt that **went through**. A separate type, not an ordinary error.
 *
 * The difference is not pedantic: "the transfer went through" is a failure
 * of criterion SC-002, while "the attempt could not even be assembled" is a
 * broken measurement. One `catch` for both would turn the second into the
 * first and show a hole in the rule where there is none (which is exactly
 * what happened on the first run).
 */
export class PassedThrough extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PassedThrough'
  }
}
