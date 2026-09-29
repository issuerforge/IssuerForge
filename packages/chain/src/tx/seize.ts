// Executing a seizure a quorum has approved (FR-015, FR-019, FR-020).
//
// **The proposal is the authority; this transaction carries only the payer.**
// The seizure itself — whose account, how much, why — was fixed in
// `propose_action` and is repeated here only because the program compares
// the two, and because the indexer reads the whole seizure from this one
// instruction.
//
// **The approvers follow the accounts, in the proposal's order** (FR-019c).
// They do not sign again: the program checks that the list is exactly the
// one it counts, so the journal can name them from this instruction alone.
//
// There is no transfer here and so no hook accounts: the program burns from
// the account and mints into the vault, because a transfer it signed would
// call its own hook through the token program, and the runtime refuses that
// as reentrancy.

import { BN } from '@coral-xyz/anchor'
import { U64_MAX } from '@forge/shared/primitives'
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import type { PublicKey } from '@solana/web3.js'
import { issuerConfigPda, seizureVaultAddress, tokenConfigPda } from '../pda.ts'
import type { ForgeProgram } from '../program.ts'
import { type TxPlan, toPlan } from './plan.ts'
import { type ComplianceReasonInput, toReason } from './reason.ts'

export type SeizeArgs = {
  readonly issuerId: PublicKey
  readonly mint: PublicKey
  /** The matured `ActionProposal` of kind `seize`. */
  readonly proposal: PublicKey
  /** The three fields exactly as the proposal holds them. */
  readonly tokenAccount: PublicKey
  readonly amount: bigint
  readonly reason: ComplianceReasonInput
  /** `ActionProposal.approvals`, in order. */
  readonly approvers: readonly PublicKey[]
  /** Pays for the vault on the first seizure. Grants nothing. */
  readonly payer: PublicKey
}

export async function buildSeize(program: ForgeProgram, args: SeizeArgs): Promise<TxPlan> {
  if (args.amount <= 0n || args.amount > U64_MAX) {
    throw new RangeError(`amount must be 1…u64 max: ${args.amount}`)
  }
  if (args.approvers.length === 0) {
    // The program would refuse it, but an empty list here is a caller that
    // forgot to read the proposal, not a proposal without approvers.
    throw new RangeError('a seizure lists the approvers of its proposal')
  }

  const instruction = await program.methods
    .seize({ amount: new BN(args.amount.toString()), reason: toReason(args.reason) })
    .accountsPartial({
      issuerConfig: issuerConfigPda(args.issuerId),
      tokenConfig: tokenConfigPda(args.mint),
      mint: args.mint,
      source: args.tokenAccount,
      vault: seizureVaultAddress(args.mint),
      proposal: args.proposal,
      payer: args.payer,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .remainingAccounts(
      args.approvers.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
    )
    .instruction()

  return toPlan('seize', args.payer, [instruction])
}
