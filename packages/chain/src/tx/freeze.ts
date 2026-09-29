// An officer's freeze and its lifting (FR-014, FR-017).
//
// **One signature, the officer's.** A freeze moves no funds, so it takes no
// quorum and no proposal; it is also not among the powers the operational key
// can be delegated (FR-035), so no builder here offers a delegated path.
//
// **The target is a token account, not a wallet.** Token-2022 freezes an
// account, and the program keys its `FreezeRecord` by that account's address:
// an owner with a second account keeps it. Stopping the person is
// `set_holder_status` with `denied`.
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import type { PublicKey } from '@solana/web3.js'
import { freezeRecordPda, issuerConfigPda, tokenConfigPda } from '../pda.ts'
import type { ForgeProgram } from '../program.ts'
import { type TxPlan, toPlan } from './plan.ts'
import { type ComplianceReasonInput, toReason } from './reason.ts'

export type FreezeHolderArgs = {
  readonly issuerId: PublicKey
  readonly mint: PublicKey
  readonly tokenAccount: PublicKey
  /** Pays the record's rent and gets it back when the freeze is lifted. */
  readonly payer: PublicKey
  readonly officer: PublicKey
  readonly reason: ComplianceReasonInput
}

export async function buildFreezeHolder(
  program: ForgeProgram,
  args: FreezeHolderArgs,
): Promise<TxPlan> {
  const instruction = await program.methods
    .freezeHolder({ reason: toReason(args.reason) })
    .accountsPartial({
      issuerConfig: issuerConfigPda(args.issuerId),
      tokenConfig: tokenConfigPda(args.mint),
      mint: args.mint,
      tokenAccount: args.tokenAccount,
      freezeRecord: freezeRecordPda(args.tokenAccount),
      payer: args.payer,
      officer: args.officer,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .instruction()

  return toPlan('freeze-holder', args.payer, [instruction])
}

export type UnfreezeHolderArgs = {
  readonly issuerId: PublicKey
  readonly mint: PublicKey
  readonly tokenAccount: PublicKey
  /**
   * Whoever paid for the record — `FreezeRecord.payer`. The program pins the
   * rent recipient to it, so the caller reads it from the record rather than
   * choosing it.
   */
  readonly rentRecipient: PublicKey
  /** Any officer of the issuer, not only the one who froze the account. */
  readonly officer: PublicKey
  readonly reason: ComplianceReasonInput
}

export async function buildUnfreezeHolder(
  program: ForgeProgram,
  args: UnfreezeHolderArgs,
): Promise<TxPlan> {
  const instruction = await program.methods
    .unfreezeHolder({ reason: toReason(args.reason) })
    .accountsPartial({
      issuerConfig: issuerConfigPda(args.issuerId),
      tokenConfig: tokenConfigPda(args.mint),
      mint: args.mint,
      tokenAccount: args.tokenAccount,
      freezeRecord: freezeRecordPda(args.tokenAccount),
      rentRecipient: args.rentRecipient,
      officer: args.officer,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .instruction()

  return toPlan('unfreeze-holder', args.officer, [instruction])
}
