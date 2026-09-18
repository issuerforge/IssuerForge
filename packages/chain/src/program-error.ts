// The program's refusal, extracted from whatever the network throws.
//
// Needed exactly where the transaction is sent not by the browser but by us
// (`OperationalDelegation`, FR-035b): the console shows a refusal of a
// human-signed transaction by itself, while a delegated operation is seen
// only by the API — and without this parsing it would turn into "something
// failed" with a 500.
//
// **The code number is looked up in the vendored IDL, not in a list next to
// it.** A second list would diverge from the program on the first new
// refusal; here the source is the same one the program has, and the name and
// explanation come from it.
import { LangErrorCode, LangErrorMessage } from '@coral-xyz/anchor'
import { IDL } from './idl/issuer-forge.ts'

export interface ProgramError {
  /** The number as the network sees it: 6000+ are ours, 100…3013 are Anchor's built-ins. */
  readonly code: number
  readonly name: string
  readonly message: string
}

/**
 * Anchor's built-in codes (`AccountNotInitialized`, `ConstraintSeeds`, …)
 * must read as words too: in a delegated operation they are what means "the
 * token is not yet confirmed by the network" or "wrong account", and a person
 * needs to be told that.
 *
 * `LangErrorCode` has no reverse map — it is a "name → number" object, not an
 * enum with double entries — so it is built here once.
 */
const LANG_ERROR_NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(LangErrorCode).map(([name, code]) => [code, name] as const),
)

export function programErrorByCode(code: number): ProgramError | undefined {
  const declared = IDL.errors.find((error) => error.code === code)
  if (declared !== undefined) {
    return { code, name: declared.name, message: declared.msg }
  }

  const message = LangErrorMessage.get(code)
  if (message !== undefined) {
    return { code, name: LANG_ERROR_NAMES.get(code) ?? 'anchorError', message }
  }

  return undefined
}

/** Simulation log lines, if any. The shape is `SendTransactionError`. */
function logsOf(error: object): readonly string[] {
  const logs = (error as { logs?: unknown }).logs
  return Array.isArray(logs) ? logs.filter((line): line is string => typeof line === 'string') : []
}

/**
 * The refusal number from the three shapes it arrives in.
 *
 * The shapes differ not by the library's whim: `sendTransaction` fails with
 * simulation logs, `confirmTransaction` returns a parsed `TransactionError`
 * without logs, and wrappers along the way keep only the message text.
 * Parsing just one of them would mean the refusal reads as words only every
 * other time.
 */
function codeOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined

  // `Error Number: 6033.` — the line Anchor itself writes into the program log.
  for (const line of logsOf(error)) {
    const match = /Error Number: (?<code>\d+)/.exec(line)
    const code = match?.groups?.code
    if (code !== undefined) return Number(code)
  }

  // `InstructionError: [0, { Custom: 6033 }]` — the parsed transaction error.
  const instruction = (error as { InstructionError?: unknown }).InstructionError
  if (Array.isArray(instruction)) {
    const detail = instruction[1]
    if (typeof detail === 'object' && detail !== null) {
      const custom = (detail as { Custom?: unknown }).Custom
      if (typeof custom === 'number') return custom
    }
  }

  // `custom program error: 0x1798` — what is left in the message text.
  const message = (error as { message?: unknown }).message
  if (typeof message === 'string') {
    const match = /custom program error: 0x(?<hex>[0-9a-f]+)/i.exec(message)
    const hex = match?.groups?.hex
    if (hex !== undefined) return Number.parseInt(hex, 16)
  }

  return undefined
}

/**
 * What exactly the program refused — or `undefined` if it is not the
 * program's refusal at all.
 *
 * `undefined` is significant here: a dropped connection, an expired blockhash
 * and a broken RPC are not answers about the state of the chain, and showing
 * them as a rule refusal would be lying about the reason.
 */
export function programErrorFrom(error: unknown): ProgramError | undefined {
  const code = codeOf(error)
  return code === undefined ? undefined : programErrorByCode(code)
}
