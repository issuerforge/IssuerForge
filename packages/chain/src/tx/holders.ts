// Holder onboarding and status updates (FR-008b, FR-008b1).
//
// **Thawing is not a permission to transfer.** It lifts
// `DefaultAccountState = Frozen` and creates the two accounts without which
// the hook refuses; the policy rules are then checked on every transfer
// separately. Hence a pair of instructions here, not one: `set_holder_status`
// changes the status without touching the freeze, and it is what makes
// FR-008b1 enforceable.
import { BN } from '@coral-xyz/anchor'
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import type { PublicKey } from '@solana/web3.js'
import { holderStatusPda, issuerConfigPda, tokenConfigPda, velocityCounterPda } from '../pda.ts'
import type { ForgeProgram } from '../program.ts'
import type { HolderStatusInput } from './issue.ts'
import { type TxPlan, toPlan } from './plan.ts'

const jurisdictionBytes = (code: string): number[] => {
  const bytes = new TextEncoder().encode(code)
  if (bytes.length !== 2) throw new RangeError(`jurisdiction must be an alpha-2 code: ${code}`)
  return [...bytes]
}

const toStatusInput = (status: HolderStatusInput) => ({
  tier: status.tier,
  jurisdiction: jurisdictionBytes(status.jurisdiction),
  denied: status.denied,
  // The same conversion as in `issue.ts`: `bigint` at the boundary, `BN` inside.
  expiresAt: new BN(status.expiresAt.toString()),
})

export type ThawHolderArgs = {
  readonly issuerId: PublicKey
  readonly mint: PublicKey
  /** The account owner. The status lands at the address derived from it. */
  readonly wallet: PublicKey
  readonly payer: PublicKey
  /** The platform's operational key within its delegation, or an authorised member. */
  readonly authority: PublicKey
  /**
   * The status — only for the **first** thaw.
   *
   * `null` means "the record already exists, I am not touching it": that is
   * what a repeat thaw after an officer's freeze looks like. A mismatch
   * between the intent and the account state is rejected by the program, not
   * interpreted.
   */
  readonly status: HolderStatusInput | null
}

export async function buildThawHolder(
  program: ForgeProgram,
  args: ThawHolderArgs,
): Promise<TxPlan> {
  const instruction = await program.methods
    .thawHolder({
      wallet: args.wallet,
      status: args.status === null ? null : toStatusInput(args.status),
    })
    .accountsPartial({
      issuerConfig: issuerConfigPda(args.issuerId),
      tokenConfig: tokenConfigPda(args.mint),
      mint: args.mint,
      tokenAccount: getAssociatedTokenAddressSync(
        args.mint,
        args.wallet,
        false,
        TOKEN_2022_PROGRAM_ID,
      ),
      holderStatus: holderStatusPda(args.mint, args.wallet),
      velocityCounter: velocityCounterPda(args.mint, args.wallet),
      payer: args.payer,
      authority: args.authority,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .instruction()

  return toPlan('thaw-holder', args.payer, [instruction])
}

export type SetHolderStatusArgs = {
  readonly issuerId: PublicKey
  readonly mint: PublicKey
  readonly wallet: PublicKey
  readonly authority: PublicKey
  readonly status: HolderStatusInput
}

/**
 * A status update in the issuer's own registry.
 *
 * There is deliberately no token account here: a status change freezes
 * nothing. The account stays thawed, and a transfer from it stops passing
 * that very moment — because the status is read on every transfer, not at
 * thaw time.
 *
 * No separate payer: the account already exists, the action needs no rent,
 * so whoever authorises pays.
 */
export async function buildSetHolderStatus(
  program: ForgeProgram,
  args: SetHolderStatusArgs,
): Promise<TxPlan> {
  const instruction = await program.methods
    .setHolderStatus({ wallet: args.wallet, status: toStatusInput(args.status) })
    .accountsPartial({
      issuerConfig: issuerConfigPda(args.issuerId),
      tokenConfig: tokenConfigPda(args.mint),
      holderStatus: holderStatusPda(args.mint, args.wallet),
      authority: args.authority,
    })
    .instruction()

  return toPlan('set-holder-status', args.authority, [instruction])
}
