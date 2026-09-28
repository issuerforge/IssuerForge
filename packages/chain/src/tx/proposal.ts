// The issuer's quorum actions: raising a proposal, approving it, closing it,
// and the action itself — today only a policy change (FR-009, FR-019b).
//
// **Two paths to one action, never both at once** (T025). `set_policy` takes
// its quorum either from the signers of the same transaction or from a matured
// `ActionProposal`; the program refuses the union (`QuorumSourceAmbiguous`),
// and the builder makes the union unrepresentable instead of leaving it to
// the network — `PolicyQuorum` is one or the other.
//
// **The body travels in `propose`, the account keeps its digest.** So the
// rules an approver is asked to sign are read back from the instruction data
// of the proposing transaction (`decodeProposedAction`), and the execution
// must carry exactly those bytes again: the program recomputes the digest and
// refuses anything else (`ProposalBodyMismatch`).
import { BN, BorshInstructionCoder } from '@coral-xyz/anchor'
import { decodeRules, encodeRules } from '@forge/policy/layout'
import type { PolicyRules } from '@forge/policy/model'
import { U64_MAX } from '@forge/shared/primitives'
import type { PublicKey } from '@solana/web3.js'
import { IDL } from '../idl/issuer-forge.ts'
import { actionProposalPda, issuerConfigPda, policyConfigPda, tokenConfigPda } from '../pda.ts'
import type { ForgeProgram } from '../program.ts'
import { type TxPlan, toPlan } from './plan.ts'

/**
 * What is proposed, with its body in full — the TS side of `ProposedAction`.
 *
 * A union with one member rather than a bare policy: seizure and pause
 * (`T027`, `T028`) each append their kind — the freeze takes no quorum — and a caller that switches over `kind` then fails to compile
 * instead of silently treating a seizure as a policy change.
 */
export type ProposedActionInput = {
  readonly kind: 'set-policy'
  /** The next policy version — exactly `TokenConfig.policy_version + 1`. */
  readonly version: number
  readonly policy: PolicyRules
}

/** The Anchor shape of `ProposedAction`. The rules as canonical bytes, as the program hashes them. */
function toProposedAction(action: ProposedActionInput) {
  return { setPolicy: { version: action.version, rules: Buffer.from(encodeRules(action.policy)) } }
}

export type ProposeActionArgs = {
  readonly issuerId: PublicKey
  readonly mint: PublicKey
  /** The number in the seeds. Chosen at random by the caller, not counted (see `ActionProposal.nonce`). */
  readonly nonce: bigint
  readonly termSeconds: number
  readonly action: ProposedActionInput
  /** Pays the rent and gets it back on close. May be the proposer. */
  readonly payer: PublicKey
  /** The first approval. Must hold an authorising role. */
  readonly proposer: PublicKey
}

export async function buildProposeAction(
  program: ForgeProgram,
  args: ProposeActionArgs,
): Promise<TxPlan> {
  if (args.nonce < 0n || args.nonce > U64_MAX) {
    throw new RangeError(`nonce does not fit in u64: ${args.nonce}`)
  }

  const instruction = await program.methods
    .proposeAction({
      nonce: new BN(args.nonce.toString()),
      termSeconds: new BN(args.termSeconds),
      action: toProposedAction(args.action),
    })
    .accountsPartial({
      issuerConfig: issuerConfigPda(args.issuerId),
      tokenConfig: tokenConfigPda(args.mint),
      proposal: actionProposalPda(args.mint, args.nonce),
      payer: args.payer,
      proposer: args.proposer,
    })
    .instruction()

  return toPlan('propose-action', args.payer, [instruction])
}

export type ApproveActionArgs = {
  readonly issuerId: PublicKey
  readonly proposal: PublicKey
  readonly approver: PublicKey
}

/**
 * One more signature on a live proposal.
 *
 * The approver is also the fee payer: the instruction creates nothing, and a
 * second signer here would be one more wallet to pass the transaction to for
 * no reason.
 */
export async function buildApproveAction(
  program: ForgeProgram,
  args: ApproveActionArgs,
): Promise<TxPlan> {
  const instruction = await program.methods
    .approveAction()
    .accountsPartial({
      issuerConfig: issuerConfigPda(args.issuerId),
      proposal: args.proposal,
      approver: args.approver,
    })
    .instruction()

  return toPlan('approve-action', args.approver, [instruction])
}

export type CloseActionProposalArgs = {
  readonly issuerId: PublicKey
  readonly proposal: PublicKey
  /** `ActionProposal.payer` — the program pins the rent recipient to it. */
  readonly rentRecipient: PublicKey
  readonly member: PublicKey
}

export async function buildCloseActionProposal(
  program: ForgeProgram,
  args: CloseActionProposalArgs,
): Promise<TxPlan> {
  const instruction = await program.methods
    .closeActionProposal()
    .accountsPartial({
      issuerConfig: issuerConfigPda(args.issuerId),
      proposal: args.proposal,
      rentRecipient: args.rentRecipient,
      member: args.member,
    })
    .instruction()

  return toPlan('close-action-proposal', args.member, [instruction])
}

/**
 * Where the quorum of a policy change comes from.
 *
 * `immediate`: the authorising wallets sign this very transaction and travel
 * in `remaining_accounts`. `proposal`: they signed an `ActionProposal` on
 * other days, and the transaction carries only the payer's signature.
 */
export type PolicyQuorum =
  | { readonly kind: 'immediate'; readonly signers: readonly PublicKey[] }
  | { readonly kind: 'proposal'; readonly proposal: PublicKey }

export type SetPolicyArgs = {
  readonly issuerId: PublicKey
  readonly mint: PublicKey
  readonly version: number
  readonly policy: PolicyRules
  /** Pays the rent for the new version. Grants nothing. */
  readonly payer: PublicKey
  readonly quorum: PolicyQuorum
}

export async function buildSetPolicy(program: ForgeProgram, args: SetPolicyArgs): Promise<TxPlan> {
  if (args.quorum.kind === 'immediate' && args.quorum.signers.length === 0) {
    // The program would refuse it as `QuorumNotReached`, but an empty list
    // here is a caller that forgot the quorum, not a quorum of zero.
    throw new RangeError('the immediate path needs the signers of the quorum')
  }

  const instruction = await program.methods
    .setPolicy({ version: args.version, rules: Buffer.from(encodeRules(args.policy)) })
    .accountsPartial({
      issuerConfig: issuerConfigPda(args.issuerId),
      tokenConfig: tokenConfigPda(args.mint),
      policyConfig: policyConfigPda(args.mint, args.version),
      payer: args.payer,
      // `null` is how Anchor spells an absent optional account: it puts the
      // program id in its place, which is what the program reads as `None`.
      proposal: args.quorum.kind === 'proposal' ? args.quorum.proposal : null,
    })
    .remainingAccounts(
      args.quorum.kind === 'immediate'
        ? args.quorum.signers.map((pubkey) => ({ pubkey, isSigner: true, isWritable: false }))
        : [],
    )
    .instruction()

  return toPlan('set-policy', args.payer, [instruction])
}

/**
 * The concrete coder, not `program.coder.instruction`: the latter is typed as
 * the encoding-only interface, and the worker's indexer decodes the same way.
 */
const coder = new BorshInstructionCoder(IDL)

/**
 * The body of a proposal, read back from the data of its `propose_action`.
 *
 * `undefined` — these bytes are not a `propose_action` of this program. The
 * caller hands in every instruction of the proposing transaction and keeps
 * the one that decodes, so "not this one" is an ordinary answer, not an error.
 */
export function decodeProposedAction(
  data: Uint8Array,
): { readonly nonce: bigint; readonly action: ProposedActionInput } | undefined {
  const decoded = coder.decode(Buffer.from(data))
  if (decoded === null || decoded.name !== 'proposeAction') return undefined

  const args = (decoded.data as { args: DecodedProposeArgs }).args
  const setPolicy = args.action.setPolicy
  if (setPolicy === undefined) return undefined

  return {
    nonce: BigInt(args.nonce.toString()),
    action: {
      kind: 'set-policy',
      version: setPolicy.version,
      // Through the same decoder the program's layout mirrors: bytes that do
      // not decode could not have passed `propose_action`'s own validation.
      policy: decodeRules(Uint8Array.from(setPolicy.rules)),
    },
  }
}

type DecodedProposeArgs = {
  readonly nonce: { toString(): string }
  readonly action: { readonly setPolicy?: { readonly version: number; readonly rules: Uint8Array } }
}
