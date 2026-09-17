// The catalogue of simulation scenarios (FR-004): "a transfer to a verified
// holder, to an unverified one, over the limit, to a denied address, while
// paused".
//
// **A scenario is derived from the policy, not described next to it.** The
// five names in the requirement are five questions to the rules, and the
// answer to each depends on which rules are enabled: "over the limit" with no
// limit at all is a question without content, and "over the limit" with both a
// per-transfer and a per-period limit means the first of them, because it
// fires earlier. Keeping this logic in the console would mean the wizard
// screen and the demo scenario (T024) diverging on what counts as a violation.
//
// **The catalogue lives in `policy`, not in `apps/api`.** It builds a
// `TransferContext` — i.e. it speaks the language of the rule model, not of
// HTTP; the simulation route only reads from it. A side effect: the same
// function serves both the wizard and the demo, and neither place invents its
// own "over the limit".
//
// **The amount of the verified transfer is exactly the limit**, not one. The
// boundary is demonstrative: "exactly the limit — allowed" and "the limit plus
// one — refused" stand side by side, so a person sees precisely where the line
// runs rather than two unrelated numbers. A policy without limits yields one —
// the smallest amount there is.
import {
  fromU64,
  toU64,
  U64_MAX,
  type U64String,
  unixSecondsSchema,
} from '@forge/shared/primitives'
import { z } from 'zod'
import {
  OPEN_TOKEN_STATE,
  type PartyContext,
  simulateTransfer,
  type TokenProgramState,
  type TransferContext,
  type TransferVerdict,
} from './evaluate.ts'
import { type PolicyRules, policyRulesSchema } from './model.ts'

/**
 * Scenario names in FR-004 order. The order is not decorative: the wizard
 * shows them as a list top to bottom, and the requirement reads in exactly
 * that line.
 */
export const SCENARIO_NAMES = ['verified', 'unverified', 'over-limit', 'denied', 'paused'] as const

export type ScenarioName = (typeof SCENARIO_NAMES)[number]

export const scenarioNameSchema = z.enum(SCENARIO_NAMES)

/**
 * The parties' jurisdiction when the policy does not restrict countries.
 *
 * Needed because a `HolderStatus` without a country does not exist — the
 * field is mandatory in both sources. When there is a jurisdictions rule, the
 * first allowed one is taken, and then this constant is not used at all.
 */
export const SIMULATED_JURISDICTION = 'UA'

/**
 * The policy version in the simulation — the same on both sides.
 *
 * `POLICY_VERSION_MISMATCH` is a state of the network (the wrong
 * `PolicyConfig` slipped in), not a property of the rules, so it does not
 * appear here as a separate scenario: the wizard asks "what does my policy
 * do", not "what happens if the account is swapped".
 */
const SIMULATED_POLICY_VERSION = 1

/** The amount of the verified transfer when the policy has no limit at all. */
const MINIMAL_AMOUNT = 1n

/**
 * One scenario: a question to the rules together with what it is for the
 * evaluator.
 *
 * `applicable` — whether the scenario has content under this policy. An
 * inapplicable scenario is not hidden: "over the limit" under a policy
 * without limits must be a visible line "no limit — transfer allowed",
 * otherwise the wizard silently shows four scenarios out of five, and the
 * disappearance of the fifth reads as "all fine".
 */
export type Scenario = {
  readonly name: ScenarioName
  readonly applicable: boolean
  readonly amount: U64String
  readonly context: TransferContext
  readonly token: TokenProgramState
}

export type ScenarioResult = Scenario & { readonly verdict: TransferVerdict }

/**
 * A party to the transfer as the hook sees it.
 *
 * The record is placed **only in the sources the rule accepts**: a source
 * outside the list would yield `STATUS_SOURCE_NOT_ACCEPTED` — the right
 * refusal to the wrong question, because the "verified" scenario is not
 * asking about that.
 *
 * `expiresAt: null` — a record without a validity period. Expiry has its own
 * codes and its own fixtures (T019); mixing it into every scenario would mean
 * that "over the limit" one day starts refusing for a different reason.
 */
function party(
  policy: PolicyRules,
  options: { readonly now: number; readonly known: boolean; readonly denied: boolean },
): PartyContext {
  const accepts = new Set(policy.status.sources)
  const record = {
    denied: options.denied,
    tier: policy.status.minTier,
    jurisdiction: policy.jurisdictions?.[0] ?? SIMULATED_JURISDICTION,
    expiresAt: null,
  }
  const known = (source: 'provider' | 'register') => options.known && accepts.has(source)

  return {
    provider: known('provider')
      ? { kind: 'record', record: { ...record, issuedAt: options.now } }
      : { kind: 'absent' },
    register: known('register') ? { kind: 'record', record } : { kind: 'absent' },
  }
}

/**
 * The limit that fires first — the smallest of those in force.
 *
 * Not "the per-transfer limit, and if there is none, the per-period one": a
 * policy with both limits rejects the amount by the smaller of them, and an
 * "over the limit" scenario built from the larger one would show a refusal
 * with a code the person does not expect.
 */
function bindingLimit(policy: PolicyRules): bigint | undefined {
  const limits = [policy.transferLimit, policy.periodLimit?.amount]
    .filter((value): value is U64String => value !== undefined)
    .map(toU64)
  return limits.length === 0 ? undefined : limits.reduce((a, b) => (a < b ? a : b))
}

/** The transfer context: everything except what the scenario itself decides. */
function context(
  policy: PolicyRules,
  options: {
    readonly now: number
    readonly amount: bigint
    readonly recipient: PartyContext
  },
): TransferContext {
  return {
    sender: party(policy, { now: options.now, known: true, denied: false }),
    recipient: options.recipient,
    amount: fromU64(options.amount),
    // The sender's counter exists exactly when the policy has a period limit:
    // its absence under such a policy is `VELOCITY_COUNTER_MISSING`, i.e. a
    // state of the account, not a rules scenario.
    velocity:
      policy.periodLimit === undefined
        ? undefined
        : { windowStart: options.now, spentInWindow: '0' },
    mintPolicyVersion: SIMULATED_POLICY_VERSION,
    policyVersion: SIMULATED_POLICY_VERSION,
    now: options.now,
  }
}

/**
 * One scenario by name.
 *
 * The policy is run through the schema: normalisation (the order of sources,
 * the order of jurisdictions) affects which country the scenario takes, so it
 * has to be computed from the same value the evaluator will later see.
 */
export function buildScenario(rules: PolicyRules, name: ScenarioName, now: number): Scenario {
  const policy = policyRulesSchema.parse(rules)
  const at = unixSecondsSchema.parse(now)
  const limit = bindingLimit(policy)
  const withinLimit = limit ?? MINIMAL_AMOUNT
  const known = (denied = false) => party(policy, { now: at, known: true, denied })

  const scenario = (
    amount: bigint,
    recipient: PartyContext,
    token: TokenProgramState = OPEN_TOKEN_STATE,
    applicable = true,
  ): Scenario => ({
    name,
    applicable,
    amount: fromU64(amount),
    context: context(policy, { now: at, amount, recipient }),
    token,
  })

  switch (name) {
    case 'verified':
      return scenario(withinLimit, known())

    case 'unverified':
      return scenario(withinLimit, party(policy, { now: at, known: false, denied: false }))

    case 'over-limit': {
      // There is nothing to exceed a limit at the u64 ceiling with: the
      // scenario does not exist, and inventing an amount for it would show
      // "allowed" as the answer to a question that was not asked.
      const exceeds = limit !== undefined && limit < U64_MAX
      return scenario(exceeds ? withinLimit + 1n : withinLimit, known(), OPEN_TOKEN_STATE, exceeds)
    }

    case 'denied':
      return scenario(withinLimit, known(true))

    case 'paused':
      return scenario(withinLimit, known(), { ...OPEN_TOKEN_STATE, paused: true })
  }
}

/**
 * The whole set (or a named part of it) together with the verdicts.
 *
 * `simulateTransfer`, not `evaluateTransfer`: the "while paused" scenario
 * lives on the token program layer, and without it the five of FR-004 are
 * incomplete.
 */
export function simulateScenarios(
  rules: PolicyRules,
  options: { readonly now: number; readonly names?: readonly ScenarioName[] | undefined },
): ScenarioResult[] {
  const names = options.names ?? SCENARIO_NAMES
  return names.map((name) => {
    const scenario = buildScenario(rules, name, options.now)
    return { ...scenario, verdict: simulateTransfer(rules, scenario.context, scenario.token) }
  })
}
