// A transfer of a token with a hook (FR-002, FR-012).
//
// **The only builder that goes to the network, and that is not our choice.**
// The hook's account list lives on chain, and the client must resolve it:
// `ExtraAccountMetaList` describes addresses through seeds, among which are
// slices of **other accounts' data** (`TokenConfig.policy_version`, credential
// and schema — the decision of spike T057). They cannot be read without RPC.
//
// **Assembling a transfer by hand is not allowed, and that is a repository
// rule, not advice.** The token program hands the hook exactly the accounts it
// derives from the list; on a single unguessed account it rejects the
// transfer **before** our check, so the holder sees a token program error
// instead of a named reason (FR-011). That is why the resolution is done by
// `createTransferCheckedWithTransferHookInstruction`, not by us.
import {
  createTransferCheckedWithTransferHookInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token'
import type { Commitment, Connection, PublicKey } from '@solana/web3.js'
import { type TxPlan, toPlan } from './plan.ts'

export type TransferArgs = {
  readonly mint: PublicKey
  readonly owner: PublicKey
  readonly recipient: PublicKey
  readonly amount: bigint
  /**
   * The token's decimals. Passed as an argument rather than read from the
   * mint: in `transferChecked` they exist precisely so that the client
   * **declares** which units the amount is in — and a mismatch with the mint is
   * rejected by the token program. Reading them here would mean checking the
   * mint against itself.
   */
  readonly decimals: number
}

/**
 * An unsigned transfer between the parties' associated token accounts.
 *
 * Both accounts are ATAs: the product has no others, because `thaw_holder`
 * thaws exactly those, and the status and the counter are derived from the
 * owner, not from the account.
 */
export async function buildTransfer(
  connection: Connection,
  args: TransferArgs,
  commitment?: Commitment,
): Promise<TxPlan> {
  const source = getAssociatedTokenAddressSync(args.mint, args.owner, false, TOKEN_2022_PROGRAM_ID)
  const destination = getAssociatedTokenAddressSync(
    args.mint,
    args.recipient,
    false,
    TOKEN_2022_PROGRAM_ID,
  )

  const instruction = await createTransferCheckedWithTransferHookInstruction(
    connection,
    source,
    args.mint,
    destination,
    args.owner,
    args.amount,
    args.decimals,
    [],
    commitment,
    TOKEN_2022_PROGRAM_ID,
  )

  return toPlan('transfer', args.owner, [instruction])
}
