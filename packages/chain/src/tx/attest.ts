// Publishing a reserve attestation (FR-021, FR-024): `attest_reserve`.
//
// **The index is an argument, not a read.** The program writes the record at
// `TokenConfig.attestation_count` and derives the address from it, so the
// caller who read the counter passes it in and the builder stays pure. Two
// attestations raced against one counter end as a visible refusal of the
// second on an existing account, never as an overwritten record.
//
// **The currency and the period travel although the program knows both.**
// It compares them rather than filling them in: an attestor who signed
// seven days under a token whose period the quorum just shortened must be
// refused, not quietly published for one (FR-023b).
import { BN } from '@coral-xyz/anchor'
import { U64_MAX } from '@forge/shared/primitives'
import type { PublicKey } from '@solana/web3.js'
import { reserveAttestationPda, tokenConfigPda } from '../pda.ts'
import type { ForgeProgram } from '../program.ts'
import { currencyBytes } from './issue.ts'
import { type TxPlan, toPlan } from './plan.ts'

export type AttestReserveArgs = {
  readonly mint: PublicKey
  /** `TokenConfig.attestation_count` as read: the record this one becomes. */
  readonly index: bigint
  /** In the smallest unit of the reserve currency. */
  readonly amount: bigint
  /** The token's reserve currency — the program refuses any other. */
  readonly currency: string
  /** The moment the attested balance refers to, not the moment of signing. */
  readonly attestedAt: number
  /** The token's current period, seconds — the program refuses any other. */
  readonly attestationMaxAge: number
  /** The token's attestor: `TokenConfig.attestor`, the only key the program accepts. */
  readonly attestor: PublicKey
  /** Pays the record's rent. Grants nothing; usually the attestor. */
  readonly payer: PublicKey
}

export async function buildAttestReserve(
  program: ForgeProgram,
  args: AttestReserveArgs,
): Promise<TxPlan> {
  if (args.amount < 0n || args.amount > U64_MAX) {
    throw new RangeError(`amount does not fit in u64: ${args.amount}`)
  }
  if (args.index < 0n || args.index > U64_MAX) {
    throw new RangeError(`attestation index does not fit in u64: ${args.index}`)
  }

  const instruction = await program.methods
    .attestReserve({
      amount: new BN(args.amount.toString()),
      currency: currencyBytes(args.currency),
      attestedAt: new BN(args.attestedAt),
      attestationMaxAge: new BN(args.attestationMaxAge),
    })
    .accountsPartial({
      tokenConfig: tokenConfigPda(args.mint),
      attestation: reserveAttestationPda(args.mint, args.index),
      attestor: args.attestor,
      payer: args.payer,
    })
    .instruction()

  return toPlan('attest-reserve', args.payer, [instruction])
}
