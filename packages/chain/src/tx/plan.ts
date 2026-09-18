// A transaction plan: the instructions plus what the instructions do not
// show (FR-001).
//
// **Two levels, and the boundary between them is the network.** The builders
// for issuance, thawing and statuses are pure: they assemble instructions from
// known addresses and are tested without a single mock. Everything that needs
// RPC lives here (`toUnsignedTransaction`) or in `transfer.ts`, where reading
// is unavoidable — the resolution of the hook's extra accounts is done by the
// token program from the list on chain.
//
// **The package holds no key and does not sign.** Hence the shape: what comes
// out is an unsigned transaction and the list of addresses whose signatures
// it lacks. The signature is put on by the wallet in the browser or by the
// issuer's quorum.
import {
  type Connection,
  type PublicKey,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'

/**
 * The step a transaction performs. Not decoration: token issuance is
 * **three** transactions (T018), and the console must show which one the
 * wizard stopped at, not "something failed".
 */
export const TX_STEPS = [
  'create-token',
  'token-metadata',
  'hook-accounts',
  'thaw-holder',
  'set-holder-status',
  'transfer',
] as const

export type TxStep = (typeof TX_STEPS)[number]

export type TxPlan = {
  readonly step: TxStep
  readonly instructions: readonly TransactionInstruction[]
  /** Who pays for the transaction. Also the first signer. */
  readonly feePayer: PublicKey
  /**
   * The addresses whose signatures are needed — **derived from the
   * instructions**, not declared next to them.
   *
   * A second list would diverge from the first exactly when an instruction
   * gains a new signer: the list would be left un-updated, the console would
   * not ask for the signature, and the transaction would fail on the network
   * instead of failing to assemble here.
   */
  readonly signers: readonly PublicKey[]
  /**
   * Whether the previous step must be **confirmed** before this one is sent.
   *
   * For issuance it must: `set_token_metadata` and
   * `initialize_extra_account_meta_list` read a `TokenConfig` that does not
   * exist until `create_token` is confirmed. The addresses are known in
   * advance (the mint is a PDA), so all three can be assembled at once; sent —
   * no.
   */
  readonly dependsOnPrevious: boolean
}

/**
 * The signers in the order "payer, then the rest as they appear".
 *
 * The order matters to a person, not to the network: the console asks for
 * signatures one by one, and the payer goes first because they are the one
 * who opens the transaction.
 */
function requiredSigners(
  instructions: readonly TransactionInstruction[],
  feePayer: PublicKey,
): PublicKey[] {
  const seen = new Set<string>([feePayer.toBase58()])
  const signers = [feePayer]

  for (const instruction of instructions) {
    for (const key of instruction.keys) {
      if (!key.isSigner) continue
      const address = key.pubkey.toBase58()
      if (seen.has(address)) continue
      seen.add(address)
      signers.push(key.pubkey)
    }
  }

  return signers
}

export function toPlan(
  step: TxStep,
  feePayer: PublicKey,
  instructions: readonly TransactionInstruction[],
  dependsOnPrevious = false,
): TxPlan {
  return {
    step,
    instructions,
    feePayer,
    signers: requiredSigners(instructions, feePayer),
    dependsOnPrevious,
  }
}

/** An unsigned transaction in the shape it travels to the browser in. */
export type UnsignedTransaction = {
  readonly step: TxStep
  readonly transaction: VersionedTransaction
  /** The transport form: what goes into the JSON of the API response. */
  readonly base64: string
  readonly signers: readonly PublicKey[]
  readonly dependsOnPrevious: boolean
}

/**
 * Plan + blockhash → unsigned transaction.
 *
 * A pure function, and that is not cosmetics: the size of a transaction is
 * visible only after compilation, and the issuance budget (1232 bytes) is the
 * tightest constraint in the project. Having this step without the network
 * means having a budget test that does not depend on a node.
 *
 * **The transaction is versioned (v0) with an empty list of address lookup
 * tables.** Two extra bytes buy the ability to add a table without changing
 * either the API contract or the console code: if a quorum on issuance does
 * turn out to be needed (open debt T018), the room for it comes from exactly
 * there.
 */
export function compileTransaction(plan: TxPlan, blockhash: string): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: plan.feePayer,
    recentBlockhash: blockhash,
    instructions: [...plan.instructions],
  }).compileToV0Message()

  return new VersionedTransaction(message)
}

/**
 * Base64 without `Buffer`.
 *
 * `fromBase64` exists precisely for the browser — a transaction with two
 * signatures travels between wallets as a string — and `Buffer` is never a
 * global there: Vite does not inject it, and the call would fail with
 * `Buffer is not defined` after the person has already clicked "sign".
 * `btoa`/`atob` exist on both sides.
 */
export const base64FromBytes = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))

export const bytesFromBase64 = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0))

/** The largest transaction size the network accepts. */
export const MAX_TRANSACTION_BYTES = 1232

/**
 * How many bytes the transaction takes **with all signatures**.
 *
 * `serialize()` on an unsigned transaction writes empty (zero) signatures of
 * exactly the same size as real ones, so the number does not change after
 * signing. That is why the budget can be measured here rather than on the
 * network.
 */
export function transactionBytes(transaction: VersionedTransaction): number {
  return transaction.serialize().length
}

/**
 * Plan → unsigned transaction with a fresh blockhash.
 *
 * The only place on the issuance path that goes to the network. Both signers
 * of `create_token` sign **the same** serialised transaction in turn, so
 * there must be one blockhash — fetching it separately for each signature
 * would mean two different transactions.
 */
export async function toUnsignedTransaction(
  connection: Connection,
  plan: TxPlan,
): Promise<UnsignedTransaction> {
  return toUnsigned(plan, await connection.getLatestBlockhash().then((r) => r.blockhash))
}

/**
 * Plan + an already known blockhash → unsigned transaction.
 *
 * The counterpart of `toUnsignedTransaction` for the case where the blockhash
 * **must be shared by several transactions**: the API route returns the three
 * issuance transactions together, and giving them three different blockhashes
 * would mean three different lifetimes for what a person signs in one action.
 */
export function toUnsigned(plan: TxPlan, blockhash: string): UnsignedTransaction {
  const transaction = compileTransaction(plan, blockhash)

  return {
    step: plan.step,
    transaction,
    base64: base64FromBytes(transaction.serialize()),
    signers: plan.signers,
    dependsOnPrevious: plan.dependsOnPrevious,
  }
}

/**
 * Parsing the transport form back.
 *
 * The counterpart of `base64`, and it is needed precisely because of the two
 * signatures on `create_token`: the founder's wallet signs and hands back a
 * string, the attestor's wallet parses it and adds its own signature. The
 * transaction cannot be assembled a second time here — a signature is over
 * specific bytes.
 */
export function fromBase64(base64: string): VersionedTransaction {
  return VersionedTransaction.deserialize(bytesFromBase64(base64))
}
