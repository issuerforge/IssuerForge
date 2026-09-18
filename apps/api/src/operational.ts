// The platform's operational key: the only place in the whole project where
// the API signs anything.
//
// **Why the exception exists at all.** Every handler that changes on-chain
// state returns an unsigned transaction (`docs/PLAN.md` → "API contracts").
// The three routine operations of `OperationalDelegation` are the exception
// named in the same document: thawing an account is not an action with
// funds, and an onboarding that requires the issuer's wallet every time is
// not an onboarding (FR-035).
//
// **Why this is safe, and exactly where the boundary runs.** The key's powers
// are bounded on chain: `authority::require_routine` checks every instruction
// against `delegation_mask`, and the mask itself has no power that moves
// funds and cannot have one (FR-035a). Here stands a **second** barrier,
// cheap and our own: only a plan lacking no one else's signature can be
// signed. A plan with a second signer is a quorum action, and it must not
// even reach the network to be refused there.

import type { TxPlan } from '@forge/chain'
import { compileTransaction, decodeBase58, type ProgramError, programErrorFrom } from '@forge/chain'
import { type Connection, Keypair, type PublicKey } from '@solana/web3.js'

export interface OperationalSigner {
  /** The key's address. It is what the issuer enters into `IssuerConfig.operational_key`. */
  readonly publicKey: PublicKey
  /**
   * Sign the plan, send it, await confirmation. Returns the signature.
   *
   * The blockhash is fetched here, one per transaction. A batch of thaws runs
   * sequentially, and one blockhash for all would mean the last accounts of
   * the batch are signed with a window living out its last seconds — the
   * longer the queue, the likelier the refusal.
   */
  submit(plan: TxPlan): Promise<string>
}

/**
 * A failed delegated operation.
 *
 * `program` is filled when the **program** refused: then it is an answer
 * about the state of the chain ("power not delegated", "token not created
 * yet"), and that is what the person needs to see. An empty `program` means
 * the network — a dropped connection, an expiry, a broken RPC — and that is
 * an API failure, not an answer.
 */
export class SubmitError extends Error {
  readonly program: ProgramError | undefined

  constructor(message: string, program: ProgramError | undefined, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SubmitError'
    this.program = program
  }
}

export function createOperationalSigner(
  connection: Connection,
  secretKey: string,
): OperationalSigner {
  // The parse is not wrapped in try: the config already checked the length at
  // start-up, and a second soft handling here would mean a process that came
  // up without a key and keeps quiet about it.
  const keypair = Keypair.fromSecretKey(decodeBase58(secretKey))

  return {
    publicKey: keypair.publicKey,

    async submit(plan) {
      const foreign = plan.signers.filter((signer) => !signer.equals(keypair.publicKey))
      if (foreign.length > 0) {
        throw new SubmitError(
          `${plan.step} needs signatures the operational key must not give`,
          undefined,
        )
      }

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
      const transaction = compileTransaction(plan, blockhash)
      transaction.sign([keypair])

      let signature: string
      try {
        // Preflight stays on deliberately: it is what brings the log with the
        // program's refusal number **before** the fee is charged, and without
        // it `PowerNotDelegated` would look like "the transaction failed".
        signature = await connection.sendTransaction(transaction, {
          preflightCommitment: 'confirmed',
        })
      } catch (error) {
        throw new SubmitError(`${plan.step} was refused`, programErrorFrom(error), { cause: error })
      }

      const confirmation = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed',
      )
      if (confirmation.value.err !== null) {
        throw new SubmitError(
          `${plan.step} failed on chain`,
          programErrorFrom(confirmation.value.err),
          { cause: confirmation.value.err },
        )
      }

      return signature
    },
  }
}
