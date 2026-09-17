// The rule evaluator in TS: policy + transfer context → a verdict with a code
// (FR-004).
//
// This is the second implementation of the model; the first is executed by the
// Rust hook (T015). It does not exist "for UI convenience": the wizard shows
// the outcome before signing, and what it shows must be exactly what the chain
// will say afterwards. A divergence between the two implementations is caught
// by differential tests on shared fixtures (SC-008, T019).
//
// **The input mirrors what the hook sees, not a summarised result.** Each
// party's status arrives separately from each source, in three states
// (`unavailable` / `absent` / `record`), rather than as one ready-made
// "denied/tier/country". This is a deliberately more expensive shape: merging
// the two sources (FR-008a1) and attestation expiry (FR-008a2) are exactly
// what T013 is charged with, and passing them in already done would take out
// of the differential comparison the very step where two implementations
// diverge most quietly.
//
// **The order of checks is not rewritten here.** It is declared once in
// `REFUSAL_CODES` (`@forge/shared/refusal`) and repeated in `docs/PLAN.md` →
// "Order of checks in the hook". The code below **walks** that list rather
// than reproducing it: `CHECKS` is a table "code → check", and the loop
// iterates `REFUSAL_CODES`. A check added with a new code falls into place by
// itself; reordering checks here is impossible, because there is no list here.
//
// **Pause and freeze are not part of this.** `TRANSFERS_PAUSED` and
// `ACCOUNT_FROZEN` are returned by the token program **before** the hook is
// called (`source: 'token-program'`, `hookIndex: null`), so `evaluateTransfer`
// has neither such fields nor such answers: its input is exactly the hook's
// domain, which is why a T019 fixture cannot carry what the Rust half does not
// see. The "while paused" scenario of FR-004 is expressed by
// `simulateTransfer` — a thin layer on top.
import { toU64, u64Schema, unixSecondsSchema } from '@forge/shared/primitives'
import { REFUSAL_CODES, type RefusalCode, refusalCodeSchema } from '@forge/shared/refusal'
import { z } from 'zod'
import {
  jurisdictionSchema,
  type PolicyRules,
  policyRulesSchema,
  type StatusSource,
  tierSchema,
} from './model.ts'

// ─── Status record ───────────────────────────────────────────────────────────

/**
 * Shared fields of a record about an address: both sources say the same
 * circle of things about it, in different accounts.
 *
 * `denied` — an issuer's denial or a revoked attestation. It applies from
 * **any** source, regardless of whether the rule accepts that source
 * (FR-008a1): the `sources` list names the sources that may allow, and never
 * narrows the circle of those that may deny.
 *
 * `expiresAt` — the record's own expiry (`HolderStatus.expires_at`,
 * `Attestation.expiry`). `null` means "no expiry", not "expired": a record
 * without an expiry is a valid state of both sources.
 */
const statusFields = {
  denied: z.boolean(),
  tier: tierSchema,
  jurisdiction: jurisdictionSchema,
  expiresAt: unixSecondsSchema.nullable(),
}

/** A record from the issuer's own registry — the `HolderStatus` PDA. */
export const registerStatusSchema = z.object(statusFields)

/**
 * A provider attestation — the SAS account the hook reads directly (spike
 * T057).
 *
 * `issuedAt` exists only here, and that is not asymmetry for its own sake:
 * `maxAttestationAgeSeconds` in the rule (FR-008a2) is the **age** of the
 * attestation, and there is no age without a moment of issue. `HolderStatus`
 * has no such field, so carrying it in the shared shape would mean inventing
 * in the fixture a value the Rust half does not read.
 */
export const providerStatusSchema = z.object({ ...statusFields, issuedAt: unixSecondsSchema })

export type RegisterStatus = z.infer<typeof registerStatusSchema>
export type ProviderStatus = z.infer<typeof providerStatusSchema>

/**
 * The state of one source for one party. There are three states, not two,
 * and the third is the most important.
 *
 * `unavailable` — the account was not passed into the transfer, or the wrong
 * one was. This is **not** "no record": we do not know whether one exists,
 * and source unavailability must not weaken the policy (FR-013), so it gets a
 * separate state and a separate refusal code. `absent` — the source is
 * available and has no record about the address.
 */
const unavailableSchema = z.object({ kind: z.literal('unavailable') })
const absentSchema = z.object({ kind: z.literal('absent') })

export const providerStateSchema = z.discriminatedUnion('kind', [
  unavailableSchema,
  absentSchema,
  z.object({ kind: z.literal('record'), record: providerStatusSchema }),
])

export const registerStateSchema = z.discriminatedUnion('kind', [
  unavailableSchema,
  absentSchema,
  z.object({ kind: z.literal('record'), record: registerStatusSchema }),
])

/** Both sources for one party to the transfer. */
export const partyContextSchema = z.object({
  provider: providerStateSchema,
  register: registerStateSchema,
})

export type PartyContext = z.infer<typeof partyContextSchema>

// ─── Transfer context ────────────────────────────────────────────────────────

/** The `PolicyConfig` version — a `u32`, like the account seed. */
const U32_MAX = 0xff_ff_ff_ff

export const policyVersionSchema = z.number().int().min(0).max(U32_MAX)

/**
 * The sender's `VelocityCounter`: the window start and what was spent in it.
 *
 * The counter belongs to the sender specifically — the period limit restricts
 * whoever sends. It is created at `thaw_holder`, and its absence is a
 * refusal, not a skipped check (FR-013), which is why it is optional in the
 * context rather than "zero by default".
 */
export const velocityCounterSchema = z.object({
  windowStart: unixSecondsSchema,
  spentInWindow: u64Schema,
})

/**
 * Everything the hook has in hand at the moment of transfer.
 *
 * `mintPolicyVersion` — the version the mint is configured with
 * (`TokenConfig.policy_version`); `policyVersion` — the version of the
 * `PolicyConfig` passed in. These are two different things, and they are what
 * the first check compares: a policy slipped in instead of the current one
 * would otherwise be executed in its place.
 *
 * `now` — the block time in unix seconds (`Clock`), not the client's time. In
 * the simulation this makes the result reproducible: the same fixture gives
 * the same answer a year later, so the differential test does not depend on
 * the machine's clock.
 */
export const transferContextSchema = z.object({
  sender: partyContextSchema,
  recipient: partyContextSchema,
  amount: u64Schema,
  velocity: velocityCounterSchema.optional(),
  mintPolicyVersion: policyVersionSchema,
  policyVersion: policyVersionSchema,
  now: unixSecondsSchema,
})

export type TransferContext = z.infer<typeof transferContextSchema>

// ─── Verdict ─────────────────────────────────────────────────────────────────

/**
 * The evaluator's answer.
 *
 * Carries **only** the code — exactly what the hook returns and what the
 * holder sees (FR-011). There are deliberately no human-language explanations
 * here: text in the verdict would become a second surface the differential
 * test would have to either compare (and Rust does not have it) or silently
 * ignore. The screen copy is composed by the console (T023) from the code.
 */
export type TransferVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: RefusalCode }

export const transferVerdictSchema = z.discriminatedUnion('allowed', [
  z.object({ allowed: z.literal(true) }),
  z.object({ allowed: z.literal(false), code: refusalCodeSchema }),
])

const ALLOWED: TransferVerdict = { allowed: true }

const refuse = (code: RefusalCode): TransferVerdict => ({ allowed: false, code })

// ─── Merging the two sources ─────────────────────────────────────────────────

/** A current record, reduced to what the checks read from it. */
type StatusFact = {
  readonly source: StatusSource
  readonly denied: boolean
  readonly tier: number
  readonly jurisdiction: string
}

/**
 * A party to the transfer through the eyes of the rules.
 *
 * `fresh` — current records from all sources (a denial applies from these);
 * `accepted` — those of them the rule accepts (only these can allow);
 * `unavailable` — whether at least one source was unavailable.
 *
 * `unavailable` is counted over **both** sources, not only the accepted
 * ones: if a denial applies from any source, then the unavailability of any
 * source may be hiding a denial. Letting a transfer through without looking
 * into a source that could have said "no" is exactly the weakening of policy
 * that FR-013 forbids.
 */
type PartyView = {
  readonly fresh: readonly StatusFact[]
  readonly accepted: readonly StatusFact[]
  readonly unavailable: boolean
}

/**
 * A record is current until its own expiry arrives.
 *
 * The comparison is strict: at the second of `expiresAt` the record is
 * already expired. A boundary had to be chosen, and the one chosen is where
 * "valid until" reads as "valid until, exclusive". All that matters is that
 * the Rust half chose the same one (T015).
 */
const isCurrent = (expiresAt: number | null, now: number): boolean =>
  expiresAt === null || now < expiresAt

/**
 * A provider attestation is current until its expiry arrives **and** until
 * its age exceeds what the policy allows (FR-008a2).
 *
 * An expired attestation is treated as absent, not as a denial: the same
 * status rule then makes the decision, so the outcome is `*_STATUS_MISSING`
 * or an allow from the second source. There is no separate "expired" refusal
 * code, and that is not an omission — its appearance would make expiry a
 * refusal reason of its own, i.e. different behaviour from what the
 * requirement says.
 *
 * A consequence worth saying out loud: an expired attestation does **not**
 * deny either. It drops out of the current records entirely, together with
 * its `denied`.
 */
function isProviderCurrent(
  record: ProviderStatus,
  maxAgeSeconds: number | undefined,
  now: number,
): boolean {
  if (!isCurrent(record.expiresAt, now)) return false
  return maxAgeSeconds === undefined || now - record.issuedAt <= maxAgeSeconds
}

const toFact = ({ denied, tier, jurisdiction }: RegisterStatus): Omit<StatusFact, 'source'> => ({
  denied,
  tier,
  jurisdiction,
})

function viewParty(party: PartyContext, policy: PolicyRules, now: number): PartyView {
  const fresh: StatusFact[] = []
  let unavailable = false

  const { provider, register } = party

  if (provider.kind === 'unavailable') {
    unavailable = true
  } else if (
    provider.kind === 'record' &&
    isProviderCurrent(provider.record, policy.status.maxAttestationAgeSeconds, now)
  ) {
    fresh.push({ source: 'provider', ...toFact(provider.record) })
  }

  if (register.kind === 'unavailable') {
    unavailable = true
  } else if (register.kind === 'record' && isCurrent(register.record.expiresAt, now)) {
    fresh.push({ source: 'register', ...toFact(register.record) })
  }

  const accepts = new Set<StatusSource>(policy.status.sources)
  return { fresh, accepted: fresh.filter((fact) => accepts.has(fact.source)), unavailable }
}

/** Nothing is known about the party: both sources are available and both are silent. */
const nothingKnown = (party: PartyView): boolean => !party.unavailable && party.fresh.length === 0

/** A status exists, but the rule accepts none of the sources that gave it. */
const onlyUnaccepted = (party: PartyView): boolean =>
  party.fresh.length > 0 && party.accepted.length === 0

/**
 * The party's tier is the **lowest** among the accepted sources: on a
 * disagreement the stricter one applies (FR-008a1). The second source can
 * only narrow the circle allowed by the first.
 *
 * Zero on an empty list is unreachable — only parties with an accepted record
 * get as far as this check — but it is also safe: a party without a status
 * will not pass a `minTier` greater than zero.
 */
function mergedTier(party: PartyView): number {
  const tiers = party.accepted.map((fact) => fact.tier)
  return tiers.length === 0 ? 0 : Math.min(...tiers)
}

/**
 * The jurisdiction does not fit if **at least one** accepted source names a
 * country outside the list. The same strictness: a match from one source does
 * not override a mismatch from the other.
 */
const jurisdictionRefused = (party: PartyView, allowed: readonly string[] | undefined): boolean =>
  allowed !== undefined && party.accepted.some((fact) => !allowed.includes(fact.jurisdiction))

/**
 * What was spent in the window plus the transfer amount exceeds the period
 * limit.
 *
 * A window that has already ended yields zero spent: `VelocityCounter` resets
 * at the window boundary, and the hook does that in the same instruction.
 * Reading `spentInWindow` without comparing against `windowStart` would mean
 * counting the week before last into the current limit.
 */
function periodExceeded(policy: PolicyRules, ctx: TransferContext): boolean {
  const limit = policy.periodLimit
  if (limit === undefined || ctx.velocity === undefined) return false
  const windowOpen = ctx.now < ctx.velocity.windowStart + limit.windowSeconds
  const spent = windowOpen ? toU64(ctx.velocity.spentInWindow) : 0n
  return spent + toU64(ctx.amount) > toU64(limit.amount)
}

// ─── Checks ──────────────────────────────────────────────────────────────────

/** Everything the checks look at. Assembled once per call. */
type Subject = {
  readonly policy: PolicyRules
  readonly ctx: TransferContext
  readonly sender: PartyView
  readonly recipient: PartyView
}

type Check = (subject: Subject) => boolean

/**
 * Why a code is not among the checks. Not `null`: the reasons differ, and
 * the difference between them is the difference between "this is not our
 * layer" and "our model cannot express this".
 *
 * `token-program` — pause and freeze fire before the hook is called; they are
 * expressed by `simulateTransfer`.
 *
 * `policy-decoding` — a code the hook **returns** but this evaluator cannot:
 * it takes an already parsed `PolicyRules`, and an unknown rule kind cannot be
 * expressed by that model at all. The TS-side equivalent is `decodeRules`,
 * which throws on such bytes. A fixture with an unknown rule kind exists only
 * on the Rust side, and that is a property of the model, not a gap in the
 * comparison.
 */
type CheckedElsewhere = 'token-program' | 'policy-decoding'

/**
 * The table "refusal code → check". The order is set not by it but by
 * `REFUSAL_CODES`, which the loop below walks.
 *
 * The type `Record<RefusalCode, …>` makes the table exhaustive: a new refusal
 * code will not compile until it is stated — whether it is a check or, if
 * not, **why**.
 */
const CHECKS: Record<RefusalCode, Check | CheckedElsewhere> = {
  /** A policy slipped in instead of the one the mint is configured with. */
  POLICY_VERSION_MISMATCH: ({ ctx }) => ctx.policyVersion !== ctx.mintPolicyVersion,
  SENDER_STATUS_MISSING: ({ sender }) => nothingKnown(sender),
  RECIPIENT_STATUS_MISSING: ({ recipient }) => nothingKnown(recipient),
  STATUS_SOURCE_NOT_ACCEPTED: ({ sender, recipient }) =>
    onlyUnaccepted(sender) || onlyUnaccepted(recipient),
  STATUS_SOURCE_UNAVAILABLE: ({ sender, recipient }) => sender.unavailable || recipient.unavailable,
  SENDER_DENIED: ({ sender }) => sender.fresh.some((fact) => fact.denied),
  RECIPIENT_DENIED: ({ recipient }) => recipient.fresh.some((fact) => fact.denied),
  RECIPIENT_TIER_TOO_LOW: ({ policy, recipient }) => mergedTier(recipient) < policy.status.minTier,
  RECIPIENT_JURISDICTION_NOT_ALLOWED: ({ policy, recipient }) =>
    jurisdictionRefused(recipient, policy.jurisdictions),
  TRANSFER_LIMIT_EXCEEDED: ({ policy, ctx }) =>
    policy.transferLimit !== undefined && toU64(ctx.amount) > toU64(policy.transferLimit),
  VELOCITY_COUNTER_MISSING: ({ policy, ctx }) =>
    policy.periodLimit !== undefined && ctx.velocity === undefined,
  PERIOD_LIMIT_EXCEEDED: ({ policy, ctx }) => periodExceeded(policy, ctx),
  UNKNOWN_RULE_KIND: 'policy-decoding',
  /** `Pausable` on the mint — the transfer fails before the hook is called (FR-016). */
  TRANSFERS_PAUSED: 'token-program',
  /** `DefaultAccountState = Frozen` or `freeze_account` — likewise (FR-014). */
  ACCOUNT_FROZEN: 'token-program',
}

// ─── Evaluator ───────────────────────────────────────────────────────────────

/**
 * Policy + context → verdict.
 *
 * Exactly one domain: the hook's checks. Pause and freeze are not part of it —
 * `simulateTransfer` exists for those.
 *
 * Both inputs are run through the schema. Evaluating an unchecked policy means
 * answering about a policy that could not have existed in the account, and an
 * unchecked context — about a transfer that could not have happened on the
 * network; in both cases the wizard would show an answer the chain will not
 * give.
 */
export function evaluateTransfer(rules: PolicyRules, context: TransferContext): TransferVerdict {
  const policy = policyRulesSchema.parse(rules)
  const ctx = transferContextSchema.parse(context)
  const subject: Subject = {
    policy,
    ctx,
    sender: viewParty(ctx.sender, policy, ctx.now),
    recipient: viewParty(ctx.recipient, policy, ctx.now),
  }

  // A refusal is the **first** check that failed, not the set of all that
  // failed. Two implementations that rejected the same transfer for different
  // reasons have diverged — even if both said "no" (SC-008).
  for (const code of REFUSAL_CODES) {
    const check = CHECKS[code]
    // A reason string is skipped: a code without a check here is not a
    // forgotten check but a named boundary.
    if (typeof check === 'function' && check(subject)) return refuse(code)
  }
  return ALLOWED
}

/**
 * The codes this module really checks, in check order.
 *
 * Derived from the table rather than listed a second time: a divergence
 * between "which checks are implemented" and "which codes are declared as the
 * hook's" becomes visible through a test, not by reading two files side by
 * side.
 */
export function implementedRefusalCodes(): RefusalCode[] {
  return REFUSAL_CODES.filter((code) => typeof CHECKS[code] === 'function')
}

/** The codes this module does not check — each with a named reason. */
export function refusalCodesCheckedElsewhere(): {
  code: RefusalCode
  checkedBy: CheckedElsewhere
}[] {
  return REFUSAL_CODES.flatMap((code) => {
    const check = CHECKS[code]
    return typeof check === 'function' ? [] : [{ code, checkedBy: check }]
  })
}

// ─── Token program layer ─────────────────────────────────────────────────────

/**
 * State that never reaches the hook: a pause on the mint and the freezing of
 * the parties' accounts.
 *
 * Lives apart from `TransferContext` on purpose — so that a differential test
 * fixture cannot carry fields the Rust half does not see.
 */
export const tokenProgramStateSchema = z.object({
  paused: z.boolean(),
  senderFrozen: z.boolean(),
  recipientFrozen: z.boolean(),
})

export type TokenProgramState = z.infer<typeof tokenProgramStateSchema>

/** Nothing in the way: the token is not paused, both accounts are thawed. */
export const OPEN_TOKEN_STATE: TokenProgramState = {
  paused: false,
  senderFrozen: false,
  recipientFrozen: false,
}

/**
 * The full path of a transfer as the holder sees it: first the token
 * program, then the hook.
 *
 * The order here is the reverse of `REFUSAL_CODES`, and that is not a
 * contradiction: in the list `TRANSFERS_PAUSED` and `ACCOUNT_FROZEN` come
 * last as codes the hook does not return, while in practice they fire first —
 * the token program rejects the transfer **before** it calls the hook. That
 * is exactly why they are absent from `evaluateTransfer`.
 *
 * This is the form in which the wizard shows the "while paused" scenario of
 * FR-004.
 */
export function simulateTransfer(
  rules: PolicyRules,
  context: TransferContext,
  token: TokenProgramState = OPEN_TOKEN_STATE,
): TransferVerdict {
  const state = tokenProgramStateSchema.parse(token)
  if (state.paused) return refuse('TRANSFERS_PAUSED')
  if (state.senderFrozen || state.recipientFrozen) return refuse('ACCOUNT_FROZEN')
  return evaluateTransfer(rules, context)
}
