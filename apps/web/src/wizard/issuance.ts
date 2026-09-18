// The path from assembled transactions to confirmed ones — the pure part.
//
// **Why signing is in the browser at all.** The API holds no issuer keys and
// never will: what leaves it is unsigned transactions (`docs/PLAN.md` → "API
// contracts"). The one exception is the platform's operational key, and it
// signs routine, not issuance (T022).
//
// **Why three signatures, not one.** An issuance is three transactions
// (T018), and the first of them requires two signatures: the founder-admin's
// and the reserve attestor's. A screen that shows a single "sign" button lies
// about what is about to happen — and that is exactly what is recorded as
// debt in block T020.
import type { UnsignedTransactionView } from '@forge/api/contracts'

/** An address whose signature is missing, and whether it is among the connected wallets. */
export interface SignerNeed {
  readonly address: string
  readonly connected: boolean
}

export interface SigningPlan {
  readonly step: UnsignedTransactionView['step']
  readonly base64: string
  readonly bytes: number
  readonly dependsOnPrevious: boolean
  /** In the order the api named: the payer first (T020). */
  readonly signers: readonly SignerNeed[]
}

/**
 * What exactly will have to be signed, and with what.
 *
 * The order of transactions and the order of signers within them are not
 * reshuffled: the payer is first, and `dependsOnPrevious` says the next one
 * cannot even be sent until the previous is confirmed. The console shows
 * this to the person as the same list it will execute.
 */
export function planSignatures(
  transactions: readonly UnsignedTransactionView[],
  connected: readonly string[],
): SigningPlan[] {
  const wallets = new Set(connected)

  return transactions.map((transaction) => ({
    step: transaction.step,
    base64: transaction.base64,
    bytes: transaction.bytes,
    dependsOnPrevious: transaction.dependsOnPrevious,
    signers: transaction.signers.map((address) => ({
      address,
      connected: wallets.has(address),
    })),
  }))
}

/**
 * The addresses this session does not have — once each, in order of
 * appearance.
 *
 * The commonest case is not a mistake but work: the reserve attestor is in
 * the membership as a separate wallet and does not log into the console
 * (FR-024 gives them no other powers). Then the transaction has to be handed
 * to them as a string, rather than demanding from the founder a signature
 * they cannot give.
 */
export function absentSigners(plans: readonly SigningPlan[]): string[] {
  const absent: string[] = []
  for (const plan of plans) {
    for (const signer of plan.signers) {
      if (!signer.connected && !absent.includes(signer.address)) absent.push(signer.address)
    }
  }
  return absent
}

/** How many signatures this session will collect — the number the button shows. */
export function signatureCount(plans: readonly SigningPlan[]): number {
  return plans.reduce((total, plan) => total + plan.signers.length, 0)
}

// ─── Confirmation ────────────────────────────────────────────────────────────

/** Exactly what is needed from `Connection` to await a confirmation. */
export interface SignatureReader {
  getSignatureStatuses(signatures: string[]): Promise<{
    value: ({ confirmationStatus?: string | null; err: unknown } | null)[]
  }>
}

export class ConfirmationError extends Error {
  readonly signature: string

  constructor(message: string, signature: string) {
    super(message)
    this.name = 'ConfirmationError'
    this.signature = signature
  }
}

/** How long to wait for confirmation: 60 attempts of 500 ms — thirty seconds. */
export const CONFIRM_ATTEMPTS = 60
export const CONFIRM_DELAY_MS = 500

/**
 * Waits until the transaction becomes `confirmed`.
 *
 * By polling, not `connection.confirmTransaction`: the overload our call
 * would hit requires `lastValidBlockHeight`, while the api returns only the
 * blockhash — and inventing a block height to satisfy a function signature
 * would mean waiting for the wrong thing.
 *
 * The timeout here is not decorative: the next issuance transaction reads a
 * `TokenConfig` that does not exist until the first is confirmed, so "timed
 * out" and "may proceed" are different states, and they must not be
 * confused.
 */
export async function waitForConfirmation(
  reader: SignatureReader,
  signature: string,
  options: {
    attempts?: number
    delayMs?: number
    sleep?: (ms: number) => Promise<void>
  } = {},
): Promise<void> {
  const attempts = options.attempts ?? CONFIRM_ATTEMPTS
  const delayMs = options.delayMs ?? CONFIRM_DELAY_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { value } = await reader.getSignatureStatuses([signature])
    const status = value[0]

    if (status != null) {
      if (status.err != null) {
        throw new ConfirmationError('the network refused this transaction', signature)
      }
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        return
      }
    }

    await sleep(delayMs)
  }

  // Not "failed": the transaction may have gone through after the timeout
  // too. The difference matters — re-sending the same issuance transaction
  // gets "account already exists", and the person must be told exactly that,
  // not "try again".
  throw new ConfirmationError(
    'the network did not confirm this transaction in time; it may still land',
    signature,
  )
}
