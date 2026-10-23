// The contract of publishing a reserve attestation (FR-021).
//
// A separate module for the same reason as the other contracts: the
// attestor's screen reads these schemas, and the route file would drag `hono`
// into the browser bundle along with them.
import { addressSchema, u64Schema, unixSecondsSchema } from '@forge/shared/primitives'
import { z } from 'zod'
import { unsignedTransactionSchema } from './tokens.ts'

/**
 * What the attestor vouches for: an amount at a moment.
 *
 * `attestedAt` has no default. The attestor attests a statement of a certain
 * date, and "now" filled in by the server is ahead of the chain's own clock
 * often enough for the program to refuse it as dated in the future. The
 * currency and the period are not here at all: the token has exactly one of
 * each, and the route reads them from the chain.
 */
export const attestationBodySchema = z.strictObject({
  amount: u64Schema,
  attestedAt: unixSecondsSchema,
})

export type AttestationBody = z.infer<typeof attestationBodySchema>

/** One transaction, the attestor's signature alone — the attestor also pays the rent. */
export const attestationResponseSchema = z.object({
  mint: addressSchema,
  /** The record this one becomes; a second attestation raced against it fails on this index. */
  index: u64Schema,
  attestor: addressSchema,
  currency: z.string().min(1),
  attestationMaxAge: z.number().int().positive(),
  blockhash: z.string().min(1),
  transaction: unsignedTransactionSchema,
})

export type AttestationResponse = z.infer<typeof attestationResponseSchema>
