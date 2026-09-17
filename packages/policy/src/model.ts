// The policy rule model: types, parameters and value bounds.
//
// This is the source of truth for three consumers — the issuance wizard, the
// API and the binary layout (T012) — and it is **named**, not a list of slots.
// On-chain the rules sit in an array of 16 slots of 24 bytes, but that is the
// storage form: in the model "limit per transfer" is one field, and a second
// rule of that kind does not exist by type. The question "what does a second
// slot of the same kind mean — narrowing or widening?" simply never arises
// here, rather than being answered identically in two implementations.
//
// **The order of checks is set not by this model but by `REFUSAL_CODES`** in
// `@forge/shared/refusal`: a refusal is the first check that failed, and it is
// that order the differential tests compare (SC-008). The fields here order
// nothing.
//
// **There is deliberately no pause among the rules.** FR-007 names it
// alongside the rest, but it is executed by the `Pausable` extension on the
// mint: when paused, the token program rejects the transfer **before** the
// hook is called, which is why `TRANSFERS_PAUSED` is marked
// `source: 'token-program'` with `hookIndex: null`. A pause flag in the policy
// would be a second source of truth about the same state, and a divergence
// between them ("the extension says go, the policy says stop") has no
// resolution. If `Pausable` ever conflicts with the hook (`PLAN.md` → risk 7),
// the flag will move here — and that will be a deliberate change, not the
// filling of a gap.
import { toU64, u64Schema } from '@forge/shared/primitives'
import { z } from 'zod'

// ─── Bounds set by the binary layout ─────────────────────────────────────────
//
// The numbers sit here rather than in `layout.ts` because the value bounds
// the schema checks follow from them. T012 encodes, T011 decides what can be
// encoded at all.

/** Slots in `PolicyConfig.rules`. Fixed for zero-copy reading in the hook. */
export const MAX_RULE_SLOTS = 16

/** Bytes per slot: `kind: u8`, `op: u8`, `params: [u8; 22]`. */
export const RULE_SLOT_BYTES = 24

/** Parameter bytes in a slot — this budget is what limits every rule. */
export const RULE_PARAMS_BYTES = 22

/**
 * Rule kind code — the first byte of a slot.
 *
 * **Zero is reserved for an empty slot**, so numbering starts at 1: a
 * fixed-length array always has a tail of zeros, and a rule kind with code 0
 * would turn that tail into sixteen silent rules.
 *
 * Codes are only ever appended at the end. Renumbering silently changes the
 * meaning of already signed policies that sit in accounts and are never
 * re-read.
 */
export const RULE_KIND = {
  STATUS: 1,
  JURISDICTIONS: 2,
  TRANSFER_LIMIT: 3,
  PERIOD_LIMIT: 4,
} as const

export type RuleKindName = keyof typeof RULE_KIND
export type RuleKind = (typeof RULE_KIND)[RuleKindName]

export const RULE_KIND_NAMES = Object.keys(RULE_KIND) as readonly RuleKindName[]

// ─── Status sources (FR-008a) ────────────────────────────────────────────────

/**
 * Where an address's status comes from.
 *
 * `provider` is an attestation by an external verification service;
 * `register` is the issuer's own on-chain registry. The bit values are
 * declared here and mirrored in Rust (T015/T016), the way the role mask is
 * mirrored from `issuer.rs`.
 */
export const STATUS_SOURCES = ['provider', 'register'] as const

export type StatusSource = (typeof STATUS_SOURCES)[number]

/**
 * Bit values. The tuple order above is also the canonical order in a
 * normalised policy, so the list and the mask cannot diverge.
 */
export const STATUS_SOURCE = {
  provider: 1 << 0,
  register: 1 << 1,
} as const satisfies Record<StatusSource, number>

export const STATUS_SOURCE_ALL = STATUS_SOURCE.provider | STATUS_SOURCE.register

export function statusSourceMask(sources: readonly StatusSource[]): number {
  return sources.reduce((mask, source) => mask | STATUS_SOURCE[source], 0)
}

// ─── Bounds of individual parameters ─────────────────────────────────────────

/**
 * Jurisdictions in one rule.
 *
 * The ceiling is not chosen but computed: an ISO 3166-1 alpha-2 code is two
 * ASCII bytes, and a slot has exactly 22 parameter bytes. It has to be said
 * out loud when displayed: a token whose circle of jurisdictions is wider than
 * eleven cannot be expressed by this model.
 */
export const MAX_JURISDICTIONS = RULE_PARAMS_BYTES / 2

/**
 * Window of the period limit.
 *
 * The floor is an hour: a window shorter than the confirmation time of a few
 * transactions turns the limit into a random variable. The ceiling is 31
 * days: `VelocityCounter` resets at the window boundary, and a yearly window
 * means a counter that never resets, i.e. a limit for the whole life of the
 * account — which is a different requirement from "limit per period".
 */
export const MIN_PERIOD_SECONDS = 3600
export const MAX_PERIOD_SECONDS = 31 * 24 * 3600

/**
 * Validity period of a provider attestation (FR-008a2).
 *
 * The floor is an hour, because an attestation that expires faster than a
 * transfer confirms refuses by the clock, not by substance. The ceiling is a
 * year: a period that outlives any KYC check is equivalent to having none.
 */
export const MIN_ATTESTATION_AGE_SECONDS = 3600
export const MAX_ATTESTATION_AGE_SECONDS = 365 * 24 * 3600

// ─── Schemas ─────────────────────────────────────────────────────────────────

/**
 * Upper-case ISO 3166-1 alpha-2 code.
 *
 * Exported because the jurisdiction **in a status record**, which the
 * evaluator reads (T013), has the same shape. A second regexp for the same
 * country code would diverge from this one silently — and would diverge
 * precisely in the comparison "the recipient's jurisdiction is among the
 * allowed ones", i.e. where the cost of a divergence is highest.
 */
export const jurisdictionSchema = z
  .string()
  .regex(/^[A-Z]{2}$/, 'expected an upper-case ISO 3166-1 alpha-2 code')

/**
 * Verification tier — a byte.
 *
 * Exported for the same reason: `minTier` in the rule and `tier` in the
 * status record are compared against each other, so their bounds must be one
 * value, not two identical ones.
 */
export const tierSchema = z.number().int().min(0).max(255)

/**
 * Limit amount in the smallest unit.
 *
 * Zero is rejected: a rule with a zero limit refuses every transfer, and that
 * is not a "limit" but a halt of circulation, for which a pause exists. More
 * importantly, the convention "no rule = no check" sits right next to it, and
 * two different ways of saying opposite things with zero and absence would
 * read equally badly.
 */
const limitAmountSchema = u64Schema.refine(
  (value) => toU64(value) > 0n,
  'a limit of zero refuses every transfer; omit the rule instead, or pause the token',
)

/**
 * The status rule — **the only mandatory one**.
 *
 * A policy without an answer to "who may hold" is impossible by type. This is
 * not strictness for its own sake: FR-008b1 requires that an account thawed
 * yesterday be refused today if its status no longer satisfies the policy —
 * and that is a continuous check, not a one-off thaw. "No status
 * restrictions" is written out explicitly: all sources, `minTier: 0`.
 *
 * `sources` names the sources that may **allow**. A denial applies from any
 * source regardless of this list (FR-008a1): the issuer's own registry
 * narrows the circle allowed by the provider and never widens it. So there is
 * no "denial sources" field here, and there cannot be one.
 */
export const statusRuleSchema = z
  .object({
    /** At least one source: an empty list is "allow no one". */
    sources: z
      .array(z.enum(STATUS_SOURCES))
      .min(1, 'name at least one source of status')
      .max(STATUS_SOURCES.length)
      .refine((s) => new Set(s).size === s.length, 'a source is named twice')
      // The order is normalised: a set of sources has no order, and
      // `rules_hash` (T012) must be the same for the same policy. Otherwise
      // the wizard would show "policy changed" on swapping two checkboxes.
      .transform((s) => STATUS_SOURCES.filter((source) => s.includes(source))),
    /**
     * Minimum verification tier of the recipient. `0` — the tier is not
     * checked, a current status is enough.
     *
     * The ceiling is a byte, not a product number: tiers are assigned by the
     * verification provider, and a bound invented here would reject a valid
     * policy for a reason found in no requirement.
     */
    minTier: tierSchema,
    /**
     * How long a provider attestation stays current (FR-008a2). An expired one
     * is treated as absent, not as a denial: the same rule then makes the
     * decision, so the outcome is `*_STATUS_MISSING` or an allow from another
     * source.
     *
     * The field is mandatory when `provider` is among the sources: an
     * attestation without a validity period is a verification done once and
     * valid forever.
     */
    maxAttestationAgeSeconds: z
      .number()
      .int()
      .min(MIN_ATTESTATION_AGE_SECONDS)
      .max(MAX_ATTESTATION_AGE_SECONDS)
      .optional(),
  })
  // Not a decorative check: a policy that accepts provider attestations and
  // does not name their validity period is a verification done once and valid
  // forever. FR-008a2 exists precisely against that, and the field must not be
  // forgettable.
  .refine(
    (rule) => !rule.sources.includes('provider') || rule.maxAttestationAgeSeconds !== undefined,
    {
      error: 'a policy that accepts provider attestations must say how long one stays current',
      path: ['maxAttestationAgeSeconds'],
    },
  )

export type StatusRule = z.infer<typeof statusRuleSchema>

/** Allowed recipient jurisdictions. No rule — the jurisdiction is not checked. */
export const jurisdictionsRuleSchema = z
  .array(jurisdictionSchema)
  .min(1, 'name at least one jurisdiction, or omit the rule to allow all')
  .max(MAX_JURISDICTIONS, `a rule holds at most ${MAX_JURISDICTIONS} jurisdictions`)
  .refine((codes) => new Set(codes).size === codes.length, 'a jurisdiction is named twice')
  // Sorting is the same determinism as in `sources`: a set of countries has
  // no order, and the policy hash must be identical for identical content.
  .transform((codes) => [...codes].sort())

/** Period limit: the amount and the window in which it is counted. */
export const periodLimitRuleSchema = z.object({
  amount: limitAmountSchema,
  windowSeconds: z.number().int().min(MIN_PERIOD_SECONDS).max(MAX_PERIOD_SECONDS),
})

export type PeriodLimitRule = z.infer<typeof periodLimitRuleSchema>

/**
 * The policy body.
 *
 * A rule that is absent is a check that is absent. One convention for all
 * fields, which is exactly why zero is not a valid limit amount and an empty
 * list of jurisdictions is not a way to say "all".
 */
export const policyRulesSchema = z.object({
  status: statusRuleSchema,
  jurisdictions: jurisdictionsRuleSchema.optional(),
  /** Limit per single transfer, in the smallest unit. */
  transferLimit: limitAmountSchema.optional(),
  periodLimit: periodLimitRuleSchema.optional(),
})

export type PolicyRules = z.infer<typeof policyRulesSchema>

/**
 * How many slots the policy takes when encoded (T012).
 *
 * Lives here because it is a property of the model, not of the encoder: if
 * the number of rule kinds ever exceeds `MAX_RULE_SLOTS`, it is the model that
 * breaks, and the test next to it should be what catches it.
 */
export function usedRuleSlots(rules: PolicyRules): number {
  return (
    1 +
    (rules.jurisdictions === undefined ? 0 : 1) +
    (rules.transferLimit === undefined ? 0 : 1) +
    (rules.periodLimit === undefined ? 0 : 1)
  )
}

/**
 * The weakest policy the model allows to be written.
 *
 * Not "empty": there is no such thing. It accepts both status sources,
 * requires no tier and gives the attestation the longest allowed validity —
 * but a status is still required, and a denial from the issuer's registry
 * applies here too (FR-008a1).
 *
 * Exists as a reference point: the issuance wizard starts from it (T023) and
 * the differential test fixtures build on it (T019). There should be no
 * second "zero" policy value in the project.
 */
export const OPEN_POLICY: PolicyRules = {
  status: {
    sources: [...STATUS_SOURCES],
    minTier: 0,
    maxAttestationAgeSeconds: MAX_ATTESTATION_AGE_SECONDS,
  },
}
