// The contract of the officer's handlers (FR-014, FR-016, FR-020): the
// issuer's tokens, a token's compliance totals, and the freeze with its
// lifting.
//
// A separate module for the same reason as `tokens.ts` and `actions.ts`: the
// officer's screen reads these schemas, and the route file would drag `hono`
// into the browser bundle along with them.
import { addressSchema, u64Schema, unixSecondsSchema } from '@forge/shared/primitives'
import { z } from 'zod'
import { complianceReasonSchema } from './actions.ts'
import { unsignedTransactionSchema } from './tokens.ts'

// ─── Bodies ──────────────────────────────────────────────────────────────────

/**
 * Whom to freeze: a wallet, or one of its token accounts.
 *
 * The program freezes a token account (T026), and that is what the record is
 * keyed by. An officer holding an order usually has a wallet, though, so the
 * wallet form names its associated account for this mint; an account opened
 * some other way is named directly. Two members rather than one object with
 * two optional fields: "both" and "neither" are not requests.
 */
export const freezeBodySchema = z.union([
  z.strictObject({ wallet: addressSchema, reason: complianceReasonSchema }),
  z.strictObject({ tokenAccount: addressSchema, reason: complianceReasonSchema }),
])

export type FreezeBody = z.infer<typeof freezeBodySchema>

/** Lifting carries its own reason: "why it was lifted" is a separate line in the journal. */
export const unfreezeBodySchema = z.strictObject({ reason: complianceReasonSchema })

export type UnfreezeBody = z.infer<typeof unfreezeBodySchema>

// ─── Responses ───────────────────────────────────────────────────────────────

export const tokenListingSchema = z.object({
  mint: addressSchema,
  index: z.number().int().nonnegative(),
  decimals: z.number().int().min(0).max(9),
  supply: u64Schema,
  paused: z.boolean(),
  pausedAt: unixSecondsSchema.nullable(),
  name: z.string().nullable(),
  symbol: z.string().nullable(),
  policyVersion: z.number().int().nonnegative(),
})

export type TokenListing = z.infer<typeof tokenListingSchema>

export const tokenListResponseSchema = z.object({ tokens: z.array(tokenListingSchema) })

export const freezeSchema = z.object({
  tokenAccount: addressSchema,
  wallet: addressSchema,
  officer: addressSchema,
  payer: addressSchema,
  reason: complianceReasonSchema,
  frozenAt: unixSecondsSchema,
  wasThawed: z.boolean(),
  amount: u64Schema,
})

export type FreezeResponse = z.infer<typeof freezeSchema>

/**
 * A token's totals, each one apart (FR-020).
 *
 * `free` is what is left when the frozen balances and the vault are taken out
 * of the supply. A seizure moves funds into the vault without changing the
 * supply (T027), so a "circulating" figure that is just the supply would count
 * seized money as if anyone could spend it.
 */
export const complianceSummarySchema = z.object({
  mint: addressSchema,
  decimals: z.number().int().min(0).max(9),
  supply: u64Schema,
  paused: z.boolean(),
  frozen: z.object({ amount: u64Schema, accounts: z.array(freezeSchema) }),
  seized: z.object({ vault: addressSchema, amount: u64Schema }),
  free: u64Schema,
})

export type ComplianceSummary = z.infer<typeof complianceSummarySchema>

/** A freeze or its lifting: one transaction, one signature — the officer's. */
export const officerTransactionResponseSchema = z.object({
  tokenAccount: addressSchema,
  signer: addressSchema,
  blockhash: z.string().min(1),
  transaction: unsignedTransactionSchema,
})

export type OfficerTransactionResponse = z.infer<typeof officerTransactionResponseSchema>
