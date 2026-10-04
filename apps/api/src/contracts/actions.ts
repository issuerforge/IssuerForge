// The contract of the quorum-action handlers (FR-019b, FR-019c): what the api
// accepts and what it returns.
//
// A separate module for the same reason as `tokens.ts`: the officer's screen
// (T034) reads these schemas, and the route file would drag `hono` into the
// browser bundle along with them.
import { policyRulesSchema } from '@forge/policy/model'
import { addressSchema, u64Schema, unixSecondsSchema } from '@forge/shared/primitives'
import { z } from 'zod'
import { unsignedTransactionSchema } from './tokens.ts'

// ─── Bounds taken from the program ───────────────────────────────────────────

/**
 * `MIN_PROPOSAL_TERM` and `MAX_PROPOSAL_TERM` from `state/proposal.rs`. The
 * program stays the authority; the copy turns a devnet refusal into a
 * sentence in the form, as the bounds in `tokens.ts` do.
 */
export const MIN_PROPOSAL_TERM_SECONDS = 60 * 60
export const MAX_PROPOSAL_TERM_SECONDS = 30 * 24 * 60 * 60

// ─── Bodies ──────────────────────────────────────────────────────────────────

/**
 * `ComplianceReason` from `state/action.rs`: a code that is not zero, and a
 * case reference of printable ASCII the program stores in 32 bytes.
 */
export const complianceReasonSchema = z.strictObject({
  code: z.number().int().min(1, 'a reason code must be stated').max(0xffff),
  caseRef: z
    .string()
    .regex(/^[\x20-\x7e]{1,32}$/, 'a case reference is 1…32 printable ASCII characters'),
})

/**
 * What is proposed.
 *
 * For a policy change the version is **not** in the body: it is the next
 * after the token's current one, and the api reads that from the chain. A
 * version typed by a person would only be a second way to be wrong about it.
 *
 * For a seizure the amount is exact and in the smallest unit (FR-015): the
 * approvers authorise a number, and the execution fails rather than take
 * less.
 *
 * A pause and its lifting carry only the reason (FR-016, FR-017): there is
 * one pause per mint, and the mint is in the path. A policy change carries
 * one too (T029): it decides who may hold the token, and the approvers sign
 * the case along with the rules.
 */
export const proposedActionBodySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('set-policy'),
    policy: policyRulesSchema,
    reason: complianceReasonSchema,
  }),
  z.strictObject({
    kind: z.literal('seize'),
    tokenAccount: addressSchema,
    amount: u64Schema.refine((value) => value !== '0', 'a seizure must take a non-zero amount'),
    reason: complianceReasonSchema,
  }),
  z.strictObject({ kind: z.literal('pause'), reason: complianceReasonSchema }),
  z.strictObject({ kind: z.literal('resume'), reason: complianceReasonSchema }),
])

export const proposeActionBodySchema = z.strictObject({
  action: proposedActionBodySchema,
  termSeconds: z
    .number()
    .int()
    .min(MIN_PROPOSAL_TERM_SECONDS, 'a proposal must live at least an hour')
    .max(MAX_PROPOSAL_TERM_SECONDS, 'a proposal may live at most 30 days'),
})

export type ProposeActionBody = z.infer<typeof proposeActionBodySchema>

/**
 * Who signs, as a query parameter — the same shape as the holder routes: it
 * only narrows the choice among this session's authorising wallets and is not
 * part of the action.
 */
export const signerQuerySchema = z.object({ signer: addressSchema.optional() })

// ─── Responses ───────────────────────────────────────────────────────────────

export const PROPOSAL_STATES = ['open', 'ready', 'blocked', 'executed', 'expired'] as const

export const proposalActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('set-policy'),
    version: z.number().int().positive(),
    rulesHash: z.string().regex(/^[0-9a-f]{64}$/),
    reason: complianceReasonSchema,
  }),
  z.object({
    kind: z.literal('seize'),
    tokenAccount: addressSchema,
    amount: u64Schema,
    reason: complianceReasonSchema,
  }),
  z.object({ kind: z.literal('pause'), reason: complianceReasonSchema }),
  z.object({ kind: z.literal('resume'), reason: complianceReasonSchema }),
])

export const proposalSchema = z.object({
  address: addressSchema,
  mint: addressSchema,
  nonce: u64Schema,
  payer: addressSchema,
  action: proposalActionSchema,
  /**
   * Named, in signing order (FR-019c): "two of three" is not an answer to
   * "who authorised this".
   */
  approvals: z.array(addressSchema),
  state: z.enum(PROPOSAL_STATES),
  required: z.number().int().nonnegative(),
  counted: z.number().int().nonnegative(),
  /** Approvals by wallets that lost their authorising role — why a proposal is `blocked`. */
  lapsed: z.array(addressSchema),
  createdAt: unixSecondsSchema,
  expiresAt: unixSecondsSchema,
  executedAt: unixSecondsSchema.nullable(),
})

export type ProposalResponse = z.infer<typeof proposalSchema>

export const proposalListResponseSchema = z.object({ proposals: z.array(proposalSchema) })

/**
 * A member whose signature counts, as the program reads the roster at
 * execution — not the database mirror.
 */
export const quorumMemberSchema = z.object({
  wallet: addressSchema,
  roles: z.number().int().positive(),
})

/**
 * One proposal with its body — what an approver reads before signing — and
 * the members who could still approve it. Without the second list the screen
 * can say "one of two", but not who the second could be.
 */
export const proposalDetailResponseSchema = z.object({
  proposal: proposalSchema,
  body: proposedActionBodySchema,
  authorising: z.array(quorumMemberSchema),
})

/** Every handler that assembles a transaction answers in this shape. */
export const actionTransactionResponseSchema = z.object({
  proposal: addressSchema,
  signer: addressSchema,
  blockhash: z.string().min(1),
  transaction: unsignedTransactionSchema,
})

export type ActionTransactionResponse = z.infer<typeof actionTransactionResponseSchema>

export const proposeActionResponseSchema = actionTransactionResponseSchema.extend({
  nonce: u64Schema,
  /** The policy version a policy change is bound to; absent for every other kind. */
  version: z.number().int().positive().optional(),
})

export type ProposeActionResponse = z.infer<typeof proposeActionResponseSchema>
