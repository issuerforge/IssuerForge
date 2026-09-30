// Executing a pause or its lifting that a quorum has approved (FR-016, FR-019).
//
// **The same shape as a seizure** (`seize.ts`): the proposal is the
// authority, the reason is repeated because the program compares it and the
// indexer reads it from here, and the approvers follow the accounts in the
// proposal's order (FR-019c) without signing again. The payer only pays.
//
// The pause itself is the mint's `Pausable` flag; the program signs for it as
// the pause authority and writes `TokenConfig.paused_at` beside it as a
// mirror.

import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import type { PublicKey } from '@solana/web3.js'
import { issuerConfigPda, tokenConfigPda } from '../pda.ts'
import type { ForgeProgram } from '../program.ts'
import { type TxPlan, toPlan } from './plan.ts'
import { type ComplianceReasonInput, toReason } from './reason.ts'

export type CirculationDirection = 'pause' | 'resume'

export type ChangeCirculationArgs = {
  readonly direction: CirculationDirection
  readonly issuerId: PublicKey
  readonly mint: PublicKey
  /** The matured `ActionProposal` of kind `pause` or `resume` — the same as `direction`. */
  readonly proposal: PublicKey
  /** Exactly as the proposal holds it. */
  readonly reason: ComplianceReasonInput
  /** `ActionProposal.approvals`, in order. */
  readonly approvers: readonly PublicKey[]
  /** Pays the fee. Grants nothing. */
  readonly payer: PublicKey
}

export async function buildChangeCirculation(
  program: ForgeProgram,
  args: ChangeCirculationArgs,
): Promise<TxPlan> {
  if (args.approvers.length === 0) {
    // As in `buildSeize`: a caller that forgot to read the proposal.
    throw new RangeError(`a ${args.direction} lists the approvers of its proposal`)
  }

  const reason = { reason: toReason(args.reason) }
  const method =
    args.direction === 'pause'
      ? program.methods.pauseCirculation(reason)
      : program.methods.resumeCirculation(reason)
  const instruction = await method
    .accountsPartial({
      issuerConfig: issuerConfigPda(args.issuerId),
      tokenConfig: tokenConfigPda(args.mint),
      mint: args.mint,
      proposal: args.proposal,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .remainingAccounts(
      args.approvers.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
    )
    .instruction()

  return toPlan(
    args.direction === 'pause' ? 'pause-circulation' : 'resume-circulation',
    args.payer,
    [instruction],
  )
}
