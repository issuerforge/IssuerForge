// The contract of the wizard's two handlers: what the api accepts and what it
// returns.
//
// **Why a separate module rather than the route.** The schemas were declared
// in `routes/tokens.ts` (T021) with the intent that the console take them
// from there rather than write a second description of the same body. The
// intent was right, the place was not: along with the schema the console
// would pull `hono`, `drizzle` and `postgres` into the bundle — packages that
// never exist in a browser. Nothing is imported here except `zod`, the rule
// model and the primitives — and both sides read the same file.
//
// **The value bounds below mirror `create_token.rs`.** The program checks all
// of this itself and remains the authority; the check here exists so that a
// mistake in the wizard is a sentence in the form, not a devnet refusal half a
// minute later.
import { TX_STEPS } from '@forge/chain/plan'
import { transferVerdictSchema } from '@forge/policy/evaluate'
import { jurisdictionSchema, policyRulesSchema, tierSchema } from '@forge/policy/model'
import { SCENARIO_NAMES, scenarioNameSchema } from '@forge/policy/scenarios'
import { addressSchema, toU64, u64Schema, unixSecondsSchema } from '@forge/shared/primitives'
import { z } from 'zod'

// ─── Bounds taken from the program ───────────────────────────────────────────

/** `MAX_NAME_LEN`, `MAX_SYMBOL_LEN`, `MAX_URI_LEN` from `create_token.rs`. */
export const MAX_NAME_BYTES = 32
export const MAX_SYMBOL_BYTES = 12
export const MAX_URI_BYTES = 200
/** `MAX_FEE_BPS`: one hundred percent in basis points. */
export const MAX_FEE_BPS = 10_000
/** Token decimals. The ceiling is the same as the `CHECK` on the `tokens` table. */
export const MAX_DECIMALS = 9

/**
 * A string bounded in **bytes**, not characters.
 *
 * The program measures `args.name.len()`, i.e. the UTF-8 length. A check by
 * characters would let through a non-Latin name twice as long as allowed —
 * and the refusal would come from the network after two signatures.
 */
const bounded = (maxBytes: number, label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .refine(
      (value) => new TextEncoder().encode(value).length <= maxBytes,
      `${label} must be at most ${maxBytes} bytes`,
    )

/** `validate_currency` from `state/reserve.rs`: 3–8 upper-case Latin letters. */
const currencySchema = z
  .string()
  .regex(/^[A-Z]{3,8}$/, 'expected 3 to 8 uppercase letters, like USD or NGN')

// ─── POST /api/policy/simulate ───────────────────────────────────────────────

/**
 * The simulation body: a policy draft and, optionally, a narrowed set of
 * scenarios.
 *
 * Scenarios are named, not described as contexts: what "over the limit"
 * means under this policy is decided by the catalogue in `@forge/policy`
 * (T021), and the wizard and the demo scenario see the same number. A client
 * assembling contexts itself would have its own answer to that question.
 */
export const simulatePolicyBodySchema = z.strictObject({
  policy: policyRulesSchema,
  /**
   * The ceiling and the ban on repeats are not pedantry but a bound on the
   * work a request orders.
   *
   * The list is named and finite, so there is nothing to ask for beyond the
   * catalogue; without the ceiling the same name repeated 50 000 times would
   * cost seconds of CPU and four megabytes of response per request
   * (measured). A duplicate is a client error, not a way to order a scenario
   * twice.
   */
  scenarios: z
    .array(scenarioNameSchema)
    .min(1)
    .max(SCENARIO_NAMES.length)
    .refine((names) => new Set(names).size === names.length, 'a scenario is named twice')
    .optional(),
})

export type SimulatePolicyBody = z.infer<typeof simulatePolicyBodySchema>

/**
 * The simulation response.
 *
 * `applicable: false` is no reason to vanish from the list: "over the limit"
 * under a policy without limits stays a visible line "no limit — allowed".
 * Four scenarios instead of five would read as "all fine" (decision T021),
 * and the console is obliged to show that line separately rather than hide
 * it.
 */
export const simulatePolicyResponseSchema = z.object({
  /** The **server's** clock: the expiries in the scenarios were computed by it. */
  now: unixSecondsSchema,
  scenarios: z.array(
    z.object({
      name: scenarioNameSchema,
      applicable: z.boolean(),
      amount: u64Schema,
      verdict: transferVerdictSchema,
    }),
  ),
})

export type SimulatePolicyResponse = z.infer<typeof simulatePolicyResponseSchema>

// ─── POST /api/tokens ────────────────────────────────────────────────────────

/**
 * The issuance body.
 *
 * **An unknown field is an error, not noise.** The schema is strict:
 * `attestedat` instead of `attestedAt` would otherwise simply vanish, and the
 * reserve attestation would get the request time instead of the date of the
 * auditor's report — i.e. silently a different value, where the whole point
 * of the product is that numbers are not substituted.
 *
 * What is deliberately absent here:
 * - **the token number** — it is dictated by `issuer_config.token_count`,
 *   not by the client;
 * - **`issuer_id`** — it comes from the session and is not overridden by a
 *   parameter (FR-036);
 * - **`denied` in the founder's status** — an issuer does not blacklist its
 *   own founder at the moment of issuance, and a field that is always `false`
 *   would be a place where an issuance can be made inoperable by one stray
 *   field in the JSON.
 */
export const createTokenBodySchema = z
  .strictObject({
    name: bounded(MAX_NAME_BYTES, 'name'),
    symbol: bounded(MAX_SYMBOL_BYTES, 'symbol'),
    uri: bounded(MAX_URI_BYTES, 'uri'),
    decimals: z.number().int().min(0).max(MAX_DECIMALS),
    policy: policyRulesSchema,
    initialSupply: u64Schema,
    reserve: z.strictObject({
      amount: u64Schema,
      currency: currencySchema,
      /**
       * When the reserve was attested. Defaults to the request time.
       *
       * The field exists because an attestation may have been made before the
       * issuance (the report was signed yesterday), and the program compares
       * exactly this moment against the allowed age. It rejects a time from
       * the future, and so does the route.
       */
      attestedAt: unixSecondsSchema.optional(),
    }),
    attestation: z.strictObject({
      credential: addressSchema,
      schema: addressSchema,
      /**
       * How long a reserve attestation stays current. No ceiling: the period
       * is set by the issuer with its auditor, and a bound invented here would
       * reject a valid issuance for a reason found in no requirement.
       */
      maxAgeSeconds: z.number().int().positive(),
    }),
    fee: z.strictObject({
      treasury: addressSchema,
      bps: z.number().int().min(0).max(MAX_FEE_BPS),
    }),
    founderStatus: z.strictObject({
      tier: tierSchema,
      jurisdiction: jurisdictionSchema,
      /** Zero — no expiry, as in `HolderStatus` itself. */
      expiresAt: unixSecondsSchema.default(0),
    }),
    /** Needed only when the membership has several admins or attestors. */
    founder: addressSchema.optional(),
    attestor: addressSchema.optional(),
  })
  // The same inequality as in `ReserveCheck`: circulation is zero, so the
  // whole issuance must fit into the attested reserve (FR-022). The program
  // checks this again and remains the authority.
  .refine((body) => toU64(body.initialSupply) <= toU64(body.reserve.amount), {
    error: 'initial supply exceeds the attested reserve',
    path: ['initialSupply'],
  })

export type CreateTokenBody = z.infer<typeof createTokenBodySchema>

/**
 * An unsigned transaction in the shape it travels to the browser in.
 *
 * `signers` are the addresses whose signatures it lacks, in the order
 * "payer, then the rest" (T020). The console asks for signatures in exactly
 * that order rather than inventing its own. `dependsOnPrevious` forbids
 * sending as a batch: `set_token_metadata` and
 * `initialize_extra_account_meta_list` read a `TokenConfig` that does not
 * exist until `create_token` is confirmed.
 */
export const unsignedTransactionSchema = z.object({
  step: z.enum(TX_STEPS),
  base64: z.string().min(1),
  signers: z.array(addressSchema).min(1),
  dependsOnPrevious: z.boolean(),
  bytes: z.number().int().positive(),
})

export type UnsignedTransactionView = z.infer<typeof unsignedTransactionSchema>

/**
 * The issuance response: three transactions and the addresses known in
 * advance.
 *
 * The addresses are in the response because the mint is a PDA of the token
 * number, and the console must show them **before** signing: a person signing
 * the creation of a token must see its address, not learn it from the
 * confirmation.
 */
export const createTokenResponseSchema = z.object({
  tokenIndex: z.number().int().nonnegative(),
  mint: addressSchema,
  tokenConfig: addressSchema,
  policyConfig: addressSchema,
  attestation: addressSchema,
  extraAccountMetaList: addressSchema,
  founder: addressSchema,
  attestor: addressSchema,
  blockhash: z.string().min(1),
  transactions: z.array(unsignedTransactionSchema).min(1),
})

export type CreateTokenResponse = z.infer<typeof createTokenResponseSchema>
