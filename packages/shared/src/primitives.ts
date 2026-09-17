import { z } from 'zod'

/** base58 has no 0, O, I or l — hence the ranges. A Solana address is 32 bytes. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
/** A transaction signature is 64 bytes, i.e. 86–88 base58 characters. */
const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/
/** Decimal integer string without leading zeros. */
const DECIMAL_U64 = /^(0|[1-9][0-9]*)$/

export const U64_MAX = 18_446_744_073_709_551_615n

export const addressSchema = z.string().regex(BASE58_ADDRESS, 'expected a base58 Solana address')

export const signatureSchema = z
  .string()
  .regex(BASE58_SIGNATURE, 'expected a base58 transaction signature')

/**
 * An amount in the smallest unit travels through JSON as a **string**, not a
 * number.
 *
 * u64 does not fit in a double. This is not a theoretical remark here: the
 * circulation of a two-decimal stablecoin and the attested reserve in the
 * smallest fiat unit are numbers compared against each other in the check
 * "issuance + circulation ≤ attested" (FR-022). Silently losing the low digits
 * in that comparison means issuing beyond the reserve, i.e. exactly what the
 * whole product must never allow.
 */
export const u64Schema = z
  .string()
  .regex(DECIMAL_U64, 'expected a non-negative integer in the smallest unit, as a decimal string')
  // Zod 4 runs every check even when a previous one has already failed, so the
  // shape has to be verified again: `BigInt('1.5')` throws a SyntaxError, and
  // an invalid request body would come back as 500 instead of 400.
  .refine(
    (value) => DECIMAL_U64.test(value) && BigInt(value) <= U64_MAX,
    'value does not fit in u64',
  )

/**
 * Network slot. In the DB it is a `bigint`, but current Solana slots are nine
 * orders of magnitude below `Number.MAX_SAFE_INTEGER`, so it travels as a
 * number without risk.
 */
export const slotSchema = z.number().int().nonnegative()

/**
 * Block time — unix seconds as the RPC returns them, not an ISO string.
 *
 * The journal is reconciled against the network without access to the
 * issuer's systems (FR-018, SC-006): the verifier compares the record's field
 * with what `getTransaction` returned. Any conversion on that path is a place
 * where the reconciliation can diverge on format rather than on substance.
 * Formatting is the UI's job.
 *
 * `null` is not an indexing error: the RPC has no `blockTime` for blocks
 * pruned from the ledger, and the event does not stop being valid because
 * of it.
 */
export const blockTimeSchema = z.number().int().nullable()

/** Unix seconds. On-chain it is `i64`, but negative time does not exist in this system. */
export const unixSecondsSchema = z.number().int().nonnegative()

export type Address = z.infer<typeof addressSchema>
export type Signature = z.infer<typeof signatureSchema>
export type U64String = z.infer<typeof u64Schema>

/** Converts an amount from its transport string into a number for arithmetic. */
export function toU64(value: U64String): bigint {
  return BigInt(value)
}

/** The reverse conversion. Throws on a negative value or on overflow. */
export function fromU64(value: bigint): U64String {
  if (value < 0n) throw new RangeError(`u64 cannot be negative: ${value}`)
  if (value > U64_MAX) throw new RangeError(`value does not fit in u64: ${value}`)
  return value.toString(10)
}
