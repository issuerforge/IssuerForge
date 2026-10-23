// Executing an issuance a quorum has approved (FR-022, FR-035, FR-038).
//
// **Only the payer signs**, as in `seize.ts`: the quorum is in the proposal,
// and the payer is granted nothing — it pays the transaction fee and, on the
// first platform fee, the treasury's associated account. The approvers
// follow the accounts, in the proposal's order (FR-019c), unsigned.
//
// **The treasury comes as an argument**, read by the caller from
// `TokenConfig.treasury` like the attestation index below; the program
// refuses any other.
//
// **The attestation index comes as an argument and is not read here**, for
// the reason `issue.ts` gives about the token number: the builder stays pure,
// and the caller that read `TokenConfig.attestation_count` passes
// `count - 1`. An attestation that landed in between makes the execution
// refuse (`AttestationNotLatest`) rather than issue against a reserve the
// caller did not show.
import { BN } from '@coral-xyz/anchor'
import { U64_MAX } from '@forge/shared/primitives'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token'
import type { PublicKey } from '@solana/web3.js'
import { freezeRecordPda, issuerConfigPda, reserveAttestationPda, tokenConfigPda } from '../pda.ts'
import type { ForgeProgram } from '../program.ts'
import { type TxPlan, toPlan } from './plan.ts'

export type MintArgs = {
  readonly issuerId: PublicKey
  readonly mint: PublicKey
  /** The matured `ActionProposal` of kind `mint`. */
  readonly proposal: PublicKey
  /** Both fields exactly as the proposal holds them. */
  readonly tokenAccount: PublicKey
  readonly amount: bigint
  /** The index of the latest attestation: `TokenConfig.attestation_count - 1`. */
  readonly attestationIndex: bigint
  /** `ActionProposal.approvals`, in order. */
  readonly approvers: readonly PublicKey[]
  /** `TokenConfig.treasury`: the platform's wallet the fee goes to. */
  readonly treasury: PublicKey
  /** Pays the fee. Grants nothing. */
  readonly payer: PublicKey
}

export async function buildMint(program: ForgeProgram, args: MintArgs): Promise<TxPlan> {
  if (args.amount <= 0n || args.amount > U64_MAX) {
    throw new RangeError(`amount must be 1…u64 max: ${args.amount}`)
  }
  if (args.attestationIndex < 0n || args.attestationIndex > U64_MAX) {
    throw new RangeError(`attestation index does not fit in u64: ${args.attestationIndex}`)
  }
  if (args.approvers.length === 0) {
    throw new RangeError('an issuance lists the approvers of its proposal')
  }

  // Off the curve allowed: a treasury may well be a multisig's PDA.
  const treasuryAccount = getAssociatedTokenAddressSync(
    args.mint,
    args.treasury,
    true,
    TOKEN_2022_PROGRAM_ID,
  )
  const instruction = await program.methods
    .mint({ amount: new BN(args.amount.toString()) })
    .accountsPartial({
      issuerConfig: issuerConfigPda(args.issuerId),
      tokenConfig: tokenConfigPda(args.mint),
      mint: args.mint,
      attestation: reserveAttestationPda(args.mint, args.attestationIndex),
      destination: args.tokenAccount,
      treasury: args.treasury,
      treasuryAccount,
      treasuryFreeze: freezeRecordPda(treasuryAccount),
      proposal: args.proposal,
      payer: args.payer,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .remainingAccounts(
      args.approvers.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
    )
    .instruction()

  return toPlan('mint', args.payer, [instruction])
}
