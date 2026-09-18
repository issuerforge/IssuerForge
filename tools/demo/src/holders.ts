// Holder onboarding: ATAs, thawing, statuses.
//
// **The platform's operational key signs, not the issuer.** This is the first
// delegated operation (FR-035b, T022): the delegation mask has `THAW_HOLDER`
// and `SET_HOLDER_STATUS`, and exactly those are what the key uses. An
// attempt to step outside the mask is checked separately, in the violation
// set.
import { buildSetHolderStatus, buildThawHolder, type HolderStatusInput } from '@forge/chain'
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token'
import type { Keypair, PublicKey } from '@solana/web3.js'
import type { DemoContext } from './context.ts'
import type { Sent } from './send.ts'
import { submit, submitPlan } from './send.ts'

export interface OnboardResult {
  readonly wallet: PublicKey
  readonly tokenAccount: PublicKey
  readonly createdAta: Sent
  readonly thawed: Sent
}

export const ataOf = (mint: PublicKey, owner: PublicKey): PublicKey =>
  getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID)

/**
 * Only the ATA, no thaw.
 *
 * Needed for the measurement: an account the issuer never let in must still
 * **exist**, otherwise a transfer to it does not assemble on the client side
 * — the hook's account resolution reads the account's own data (`owner`,
 * decision T017), and without it the attempt stops in the browser, not at
 * the rule. A frozen account with no status is "the one who was not let in".
 */
export async function createAta(
  context: DemoContext,
  mint: PublicKey,
  owner: PublicKey,
): Promise<PublicKey> {
  const { connection, keys } = context
  const tokenAccount = ataOf(mint, owner)

  await submit(
    connection,
    keys.founder.publicKey,
    [
      createAssociatedTokenAccountInstruction(
        keys.founder.publicKey,
        tokenAccount,
        owner,
        mint,
        TOKEN_2022_PROGRAM_ID,
      ),
    ],
    [keys.founder],
  )

  return tokenAccount
}

/**
 * A holder account from nothing to thawed.
 *
 * Two steps, and the second does not follow from the first: a fresh ATA
 * arrives in the `Frozen` state through `DefaultAccountState` on the mint
 * (FR-008b), so without `thaw_holder` it exists and accepts nothing. That is
 * exactly what makes thawing an action rather than a formality.
 */
export async function onboard(
  context: DemoContext,
  mint: PublicKey,
  issuerId: PublicKey,
  holder: Keypair,
  status: HolderStatusInput,
): Promise<OnboardResult> {
  const { connection, program, keys } = context
  const tokenAccount = ataOf(mint, holder.publicKey)

  // The founder pays the ATA rent: the demo holder has no SOL at all, and
  // that is the very case `payer` and `founder` are separated for in
  // `initialize_issuer`.
  const createdAta = await submit(
    connection,
    keys.founder.publicKey,
    [
      createAssociatedTokenAccountInstruction(
        keys.founder.publicKey,
        tokenAccount,
        holder.publicKey,
        mint,
        TOKEN_2022_PROGRAM_ID,
      ),
    ],
    [keys.founder],
  )

  const plan = await buildThawHolder(program, {
    issuerId,
    mint,
    wallet: holder.publicKey,
    // The founder pays, the operational key authorises: in a delegated
    // operation these are two different addresses, and the program checks
    // only the second.
    payer: keys.founder.publicKey,
    authority: keys.operational.publicKey,
    status,
  })

  const thawed = await submitPlan(connection, plan, [keys.founder, keys.operational])

  return { wallet: holder.publicKey, tokenAccount, createdAta, thawed }
}

/** A status change in the issuer's own registry — the second delegated operation. */
export async function setStatus(
  context: DemoContext,
  mint: PublicKey,
  issuerId: PublicKey,
  wallet: PublicKey,
  status: HolderStatusInput,
): Promise<Sent> {
  const { connection, program, keys } = context

  const plan = await buildSetHolderStatus(program, {
    issuerId,
    mint,
    wallet,
    authority: keys.operational.publicKey,
    status,
  })

  return await submitPlan(connection, plan, [keys.operational])
}
