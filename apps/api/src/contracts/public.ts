// The contract of the public read of a token (FR-021, FR-023a, FR-025): what
// the transparency page shows, with no login.
//
// A separate module so that the page (T041) reads the schema without `hono`.
import { addressSchema, u64Schema, unixSecondsSchema } from '@forge/shared/primitives'
import { z } from 'zod'

/** `reserve − circulation` can be below zero, which a u64 cannot carry. */
const signedIntegerSchema = z.string().regex(/^-?(0|[1-9]\d*)$/, 'expected a decimal integer')

export const publicTokenSchema = z.object({
  mint: addressSchema,
  name: z.string().nullable(),
  symbol: z.string().nullable(),
  decimals: z.number().int().min(0).max(9),
  currency: z.string().min(1),
  /** The mint's supply — what the program's reserve gate counts. */
  circulation: u64Schema,
  /** The latest attestation's amount; zero without one. */
  reserve: u64Schema,
  difference: signedIntegerSchema,
  attestationMaxAge: z.number().int().positive(),
  attestation: z
    .object({
      index: u64Schema,
      attestor: addressSchema,
      attestedAt: unixSecondsSchema,
      expiresAt: unixSecondsSchema,
      ageSeconds: z.number().int().nonnegative(),
    })
    .nullable(),
  /**
   * Two reasons issuance is stopped, kept apart (FR-023a): an expired
   * attestation, and one by an attestor since replaced. A short reserve is
   * `difference`, a third and separate thing.
   */
  expired: z.boolean(),
  attestorReplaced: z.boolean(),
  /** The platform's fee on issuance, declared before any (FR-038a). */
  feeBps: z.number().int().min(0).max(10_000),
  paused: z.boolean(),
  /** When these numbers were read; the response may be served from a short cache. */
  asOf: unixSecondsSchema,
})

export type PublicToken = z.infer<typeof publicTokenSchema>
