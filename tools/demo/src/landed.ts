// An attempt that lands on chain, refused or not — the SC-012 and SC-013
// measurement unit.
//
// `expectRefusal` (send.ts) keeps preflight on, so its refusal is the node's
// simulation: the transaction never reaches a block. That is enough to read a
// code, but it is not what an attacker meets — anyone may skip preflight, and
// then only the program stands between the bytes and the state. Here the
// transaction is sent with `skipPreflight`, so each refusal is a failed
// transaction in a block with its own signature, citable from the report and
// checkable by anyone on the explorer.
import { compileTransaction, programErrorByCode, programErrorFrom, toPlan } from '@forge/chain'
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import {
  type Connection,
  type Keypair,
  type PublicKey,
  TransactionExpiredBlockheightExceededError,
  type TransactionInstruction,
} from '@solana/web3.js'

export interface Landed {
  readonly signature: string
  /** The transaction went through: for an attack this is the failure of the criterion. */
  readonly passed: boolean
  /** The refusal number, ours or a built-in program's. */
  readonly code: number | undefined
  /** The refusal as words: our IDL, Anchor's built-ins, or Token-2022's own list. */
  readonly name: string | undefined
  /** Which program refused, read from the log line `Program … failed`. */
  readonly refusedBy: string | undefined
}

/**
 * The Token-2022 codes the run expects to meet, by name.
 *
 * Only the ones that can come up: an unknown number stays a number in the
 * report rather than a guessed word.
 */
const TOKEN_ERRORS: ReadonlyMap<number, string> = new Map([
  [1, 'InsufficientFunds'],
  [4, 'OwnerMismatch'],
  [13, 'InvalidState'],
  [15, 'AuthorityTypeNotSupported'],
  [17, 'AccountFrozen'],
])

const TOKEN_PROGRAM = TOKEN_2022_PROGRAM_ID.toBase58()

/** The program named in the last `Program <id> failed` line. */
function failedProgram(logs: readonly string[]): string | undefined {
  const line = [...logs].reverse().find((entry) => / failed: /.test(entry))
  return line === undefined ? undefined : /^Program (\S+) failed/.exec(line)?.[1]
}

/**
 * Sends past preflight, waits for the block, and reads back what happened.
 *
 * A transaction that does not land at all (the blockhash expired, the node
 * dropped it) is thrown, never reported: "not in a block" is not a refusal,
 * and counting it as one would be the measurement lying in the criterion's
 * favour.
 */
export async function landAttempt(
  connection: Connection,
  feePayer: PublicKey,
  instructions: readonly TransactionInstruction[],
  signers: readonly Keypair[],
): Promise<Landed> {
  // A transaction whose blockhash expired can never land any more, so the
  // same attempt is sent again under a fresh one: the node dropping it is no
  // outcome at all, neither a pass nor a refusal.
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await landOnce(connection, feePayer, instructions, signers)
    } catch (error) {
      if (!(error instanceof TransactionExpiredBlockheightExceededError) || attempt === 3)
        throw error
    }
  }
}

async function landOnce(
  connection: Connection,
  feePayer: PublicKey,
  instructions: readonly TransactionInstruction[],
  signers: readonly Keypair[],
): Promise<Landed> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
  const transaction = compileTransaction(toPlan('transfer', feePayer, [...instructions]), blockhash)
  transaction.sign([...signers])

  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: true,
  })
  let err: unknown
  try {
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    )
    err = confirmation.value.err
  } catch (thrown) {
    // web3.js reports a failed transaction two ways: as `value.err` when the
    // socket answers first, and by rejecting with the bare error when its
    // status poll does (`journal.ts` met the same).
    if (typeof thrown !== 'object' || thrown === null || !('InstructionError' in thrown)) {
      throw thrown
    }
    err = thrown
  }
  if (err === null) {
    return { signature, passed: true, code: undefined, name: undefined, refusedBy: undefined }
  }

  // A confirmed transaction may still read back as `null` for a moment; the
  // log is what names the refusing program, so it is waited for, not skipped.
  let detail = null
  for (let read = 0; detail === null && read < 10; read += 1) {
    if (read > 0) await new Promise((resolve) => setTimeout(resolve, 1_000))
    detail = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    })
  }
  const logs = detail?.meta?.logMessages ?? []
  const refusedBy = failedProgram(logs)
  const code = programErrorFrom(err)?.code ?? codeOf(err)
  // A hook refusal surfaces through Token-2022 with the hook's number, so the
  // failing program alone does not say whose list the number is from.
  const name =
    code === undefined
      ? undefined
      : refusedBy === TOKEN_PROGRAM && code < 100
        ? TOKEN_ERRORS.get(code)
        : programErrorByCode(code)?.name

  return { signature, passed: false, code, name, refusedBy }
}

/** `{ InstructionError: [i, { Custom: n }] }` when the parser did not know the number. */
function codeOf(error: unknown): number | undefined {
  const instruction = (error as { InstructionError?: unknown } | null)?.InstructionError
  if (!Array.isArray(instruction)) return undefined
  const custom = (instruction[1] as { Custom?: unknown } | null)?.Custom
  return typeof custom === 'number' ? custom : undefined
}
