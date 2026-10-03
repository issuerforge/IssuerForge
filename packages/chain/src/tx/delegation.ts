// What the platform's operational key may do, and which key it is (T030,
// FR-035, FR-035b): `set_delegation` on both paths, and the proposal that
// feeds the deferred one.
//
// **Who signs is the program's rule, not this file's.** Narrowing the powers
// of the key in place takes one admin; a grant or a rotation takes the
// quorum. The builder does not decide which a call is — it would have to
// read the current delegation to know, and a stale read would turn a
// rejected transaction into a confusing one. It assembles what it is given
// and leaves the refusal to the program.
//
// **The proposal is the issuer's, not a token's.** It is raised without a
// `TokenConfig` and lives at `["proposal", issuer_config, nonce]`. The
// program stores the delegation it was raised against and refuses to execute
// once that has changed, so a grant that was circulating when an admin
// revoked in a hurry does not undo the revocation.
import { BN } from '@coral-xyz/anchor'
import { DELEGATION_ALL } from '@forge/shared/api'
import { U64_MAX } from '@forge/shared/primitives'
import type { PublicKey } from '@solana/web3.js'
import { actionProposalPda, issuerConfigPda } from '../pda.ts'
import type { ForgeProgram } from '../program.ts'
import { type TxPlan, toPlan } from './plan.ts'
import type { PolicyQuorum } from './proposal.ts'

/** Where a delegation change gets its authorisation. The same two paths as a policy change. */
export type DelegationQuorum = PolicyQuorum

export type DelegationTarget = {
  /** The key that will hold the delegation: the current one, or its successor. */
  readonly operationalKey: PublicKey
  /** A mask over `DELEGATION`. Zero is a full revocation. */
  readonly mask: number
}

function checkMask(mask: number): void {
  if (!Number.isInteger(mask) || mask < 0 || (mask & ~DELEGATION_ALL) !== 0) {
    // The program refuses it as `UndelegatablePower`; here it is a caller
    // that tried to express a power the list does not have.
    throw new RangeError(`delegation mask outside the closed list: ${mask}`)
  }
}

export type ProposeDelegationArgs = DelegationTarget & {
  readonly issuerId: PublicKey
  /** The number in the seeds. Chosen at random by the caller, not counted. */
  readonly nonce: bigint
  readonly termSeconds: number
  /** Pays the rent and gets it back on close. May be the proposer. */
  readonly payer: PublicKey
  /** The first approval. Must hold an authorising role. */
  readonly proposer: PublicKey
}

/** Where a delegation proposal lives: under the issuer's own scope. */
export function delegationProposalPda(issuerId: PublicKey, nonce: bigint): PublicKey {
  return actionProposalPda(issuerConfigPda(issuerId), nonce)
}

export async function buildProposeDelegation(
  program: ForgeProgram,
  args: ProposeDelegationArgs,
): Promise<TxPlan> {
  checkMask(args.mask)
  if (args.nonce < 0n || args.nonce > U64_MAX) {
    throw new RangeError(`nonce does not fit in u64: ${args.nonce}`)
  }

  const instruction = await program.methods
    .proposeAction({
      nonce: new BN(args.nonce.toString()),
      termSeconds: new BN(args.termSeconds),
      action: { setDelegation: { operationalKey: args.operationalKey, mask: args.mask } },
    })
    .accountsPartial({
      issuerConfig: issuerConfigPda(args.issuerId),
      // No token: the program refuses a delegation change raised under one.
      tokenConfig: null,
      proposal: delegationProposalPda(args.issuerId, args.nonce),
      payer: args.payer,
      proposer: args.proposer,
    })
    .instruction()

  return toPlan('propose-action', args.payer, [instruction])
}

export type SetDelegationArgs = DelegationTarget & {
  readonly issuerId: PublicKey
  /**
   * Pays the fee. Grants nothing — the instruction has no signer of its own;
   * on the immediate path the payer may well be one of the signers.
   */
  readonly payer: PublicKey
  readonly quorum: DelegationQuorum
}

export async function buildSetDelegation(
  program: ForgeProgram,
  args: SetDelegationArgs,
): Promise<TxPlan> {
  checkMask(args.mask)
  if (args.quorum.kind === 'immediate' && args.quorum.signers.length === 0) {
    // Even a revocation names the admin who made it.
    throw new RangeError('the immediate path needs at least one signing member')
  }
  if (args.quorum.kind === 'proposal' && args.quorum.approvers.length === 0) {
    throw new RangeError('the deferred path lists the approvers of its proposal')
  }

  const instruction = await program.methods
    .setDelegation({ operationalKey: args.operationalKey, mask: args.mask })
    .accountsPartial({
      issuerConfig: issuerConfigPda(args.issuerId),
      proposal: args.quorum.kind === 'proposal' ? args.quorum.proposal : null,
    })
    .remainingAccounts(
      args.quorum.kind === 'immediate'
        ? args.quorum.signers.map((pubkey) => ({ pubkey, isSigner: true, isWritable: false }))
        : args.quorum.approvers.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
    )
    .instruction()

  return toPlan('set-delegation', args.payer, [instruction])
}
