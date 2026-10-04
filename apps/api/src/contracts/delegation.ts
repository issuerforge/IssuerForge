// The contract of the delegation handlers (FR-035, FR-035b): what the
// platform's operational key may do for this issuer, the history of it, and
// the two ways to change it.
//
// A separate module for the same reason as the other contracts: the
// delegation screen reads these schemas without dragging `hono` along.
import { POWER_NAMES } from '@forge/shared/api'
import { addressSchema, u64Schema } from '@forge/shared/primitives'
import { z } from 'zod'
import {
  actionTransactionResponseSchema,
  delegationMaskSchema,
  MAX_PROPOSAL_TERM_SECONDS,
  MIN_PROPOSAL_TERM_SECONDS,
  proposalSchema,
} from './actions.ts'
import { unsignedTransactionSchema } from './tokens.ts'

export const powerNameSchema = z.enum(POWER_NAMES as [string, ...string[]])

// ─── Bodies ──────────────────────────────────────────────────────────────────

/**
 * Revoking: the powers to take away from the current key, by name.
 *
 * Names, not a mask: "revoke THAW_HOLDER" is the action the admin means, and
 * the resulting mask is computed against the chain at the moment of
 * assembly — a mask typed by the console would be computed against what the
 * console last saw. Revoking everything is naming every held power.
 */
export const revokeBodySchema = z.strictObject({
  powers: z
    .array(powerNameSchema)
    .min(1, 'name at least one power to revoke')
    .refine((powers) => new Set(powers).size === powers.length, 'powers must be unique'),
})

export type RevokeBody = z.infer<typeof revokeBodySchema>

/**
 * Granting or rotating: the delegation as it should be — key and full mask.
 * A destination, because that is what the program stores; the start is read
 * from the chain and bound into the proposal by the program itself.
 */
export const proposeDelegationBodySchema = z.strictObject({
  operationalKey: addressSchema,
  mask: delegationMaskSchema,
  termSeconds: z
    .number()
    .int()
    .min(MIN_PROPOSAL_TERM_SECONDS, 'a proposal must live at least an hour')
    .max(MAX_PROPOSAL_TERM_SECONDS, 'a proposal may live at most 30 days'),
})

export type ProposeDelegationBody = z.infer<typeof proposeDelegationBodySchema>

// ─── Responses ───────────────────────────────────────────────────────────────

export const delegationChangeSchema = z.object({
  signature: z.string().min(64).max(88),
  slot: z.number().int().nonnegative(),
  blockTime: z.number().int().nullable(),
  /** `null` only if the mirror had no key when the change was applied. */
  previousKey: addressSchema.nullable(),
  previousMask: delegationMaskSchema,
  operationalKey: addressSchema,
  mask: delegationMaskSchema,
  path: z.enum(['immediate', 'proposal']),
  proposal: addressSchema.nullable(),
  signers: z.array(addressSchema).min(1),
})

export type DelegationChange = z.infer<typeof delegationChangeSchema>

export const delegationResponseSchema = z.object({
  /** From the chain, not the mirror: this is what decides whether our key may sign. */
  operationalKey: addressSchema,
  mask: delegationMaskSchema,
  powers: z.array(powerNameSchema),
  /** The platform's own key. A delegation to any other key is not one this api will use. */
  platformKey: addressSchema,
  /** The issuer's own proposals still on chain — grants and rotations in flight. */
  proposals: z.array(proposalSchema),
  history: z.array(delegationChangeSchema),
})

export type DelegationResponse = z.infer<typeof delegationResponseSchema>

export const revokeResponseSchema = z.object({
  signer: addressSchema,
  blockhash: z.string().min(1),
  /** The mask the transaction sets, computed against the chain at assembly. */
  mask: delegationMaskSchema,
  transaction: unsignedTransactionSchema,
})

export type RevokeResponse = z.infer<typeof revokeResponseSchema>

export const proposeDelegationResponseSchema = actionTransactionResponseSchema.extend({
  nonce: u64Schema,
})

export type ProposeDelegationResponse = z.infer<typeof proposeDelegationResponseSchema>
