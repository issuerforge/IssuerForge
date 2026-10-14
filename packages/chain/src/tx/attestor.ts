// The terms a token's reserve is attested under — who attests, and how long
// an attestation stays current (T037, FR-023b, FR-024a): `set_attestor` on
// both paths. The proposal that feeds the deferred one is raised through
// `buildProposeAction` with a `set-attestor` body, under the token.
//
// **Both terms travel together.** The instruction takes the attestor and
// the period whole; a change of one carries the other as it is. The builder
// does not read the current terms to fill the unchanged half — a stale read
// would turn a valid change into a refused one. The caller who shows the
// terms knows them.
import { BN } from '@coral-xyz/anchor'
import type { PublicKey } from '@solana/web3.js'
import { issuerConfigPda, tokenConfigPda } from '../pda.ts'
import type { ForgeProgram } from '../program.ts'
import { type TxPlan, toPlan } from './plan.ts'
import type { PolicyQuorum } from './proposal.ts'
import { type ComplianceReasonInput, toReason } from './reason.ts'

/** `MAX_ATTESTATION_MAX_AGE` in `programs/issuer-forge/src/reserve.rs`: ninety days. */
export const ATTESTATION_MAX_AGE_MAX = 90 * 24 * 60 * 60

/** The period as the program accepts it, or a refusal at assembly rather than after a signature. */
export function checkMaxAge(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > ATTESTATION_MAX_AGE_MAX) {
    throw new RangeError(
      `attestation lifetime must be 1…${ATTESTATION_MAX_AGE_MAX} seconds: ${seconds}`,
    )
  }
  return seconds
}

export type SetAttestorArgs = {
  readonly issuerId: PublicKey
  readonly mint: PublicKey
  /** The attestor from now on — the current one when only the period changes. */
  readonly attestor: PublicKey
  /** Seconds — the current period when only the attestor changes. */
  readonly attestationMaxAge: number
  /** Why (FR-017). On the deferred path, the one the proposal holds. */
  readonly reason: ComplianceReasonInput
  /** Pays the fee. Grants nothing — the instruction has no signer of its own. */
  readonly payer: PublicKey
  readonly quorum: PolicyQuorum
}

export async function buildSetAttestor(
  program: ForgeProgram,
  args: SetAttestorArgs,
): Promise<TxPlan> {
  if (args.quorum.kind === 'immediate' && args.quorum.signers.length === 0) {
    throw new RangeError('the immediate path needs the signers of the quorum')
  }
  if (args.quorum.kind === 'proposal' && args.quorum.approvers.length === 0) {
    throw new RangeError('the deferred path lists the approvers of its proposal')
  }

  const instruction = await program.methods
    .setAttestor({
      attestor: args.attestor,
      attestationMaxAge: new BN(checkMaxAge(args.attestationMaxAge)),
      reason: toReason(args.reason),
    })
    .accountsPartial({
      issuerConfig: issuerConfigPda(args.issuerId),
      tokenConfig: tokenConfigPda(args.mint),
      proposal: args.quorum.kind === 'proposal' ? args.quorum.proposal : null,
    })
    .remainingAccounts(
      args.quorum.kind === 'immediate'
        ? args.quorum.signers.map((pubkey) => ({ pubkey, isSigner: true, isWritable: false }))
        : args.quorum.approvers.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
    )
    .instruction()

  return toPlan('set-attestor', args.payer, [instruction])
}
