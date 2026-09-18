// The issuance draft: what the person typed, and what it turns into.
//
// **There is no React and no network here.** The T010 rule remains in force:
// everything worth checking lives in pure functions and is tested without
// the DOM. The wizard steps are a form over this module, not the other way
// round.
//
// **This file does not rewrite the request body schema.** It comes from
// `@forge/api/contracts` — the same module that validates the request on the
// server. A second description of the same body would diverge from the first
// silently, and the divergence would cost a refusal after two signatures.
import { type CreateTokenBody, createTokenBodySchema, MAX_DECIMALS } from '@forge/api/contracts'
import {
  MAX_ATTESTATION_AGE_SECONDS,
  MAX_JURISDICTIONS,
  MAX_PERIOD_SECONDS,
  MIN_ATTESTATION_AGE_SECONDS,
  MIN_PERIOD_SECONDS,
  type PolicyRules,
  policyRulesSchema,
  type StatusSource,
} from '@forge/policy/model'

export interface Draft {
  // ─── 1. Token ──────────────────────────────────────────────────────────────
  name: string
  symbol: string
  uri: string
  /** Text, not a number: a form field can be empty, and `0` is valid decimals. */
  decimals: string
  initialSupply: string
  /** The three immutable parameters that must be confirmed explicitly (FR-005). */
  ackSymbol: boolean
  ackDecimals: boolean
  ackPolicy: boolean

  // ─── 2. Who may hold ───────────────────────────────────────────────────────
  sources: StatusSource[]
  minTier: number
  attestationAgeHours: string
  /**
   * Countries as a comma-separated list, as a person types them.
   *
   * A string, not an array: the draft is a form, and parsing lives in a pure
   * function beside it. An empty string means "no rule", i.e. countries are
   * not checked at all — which is not the same as an empty list, which the
   * model rejects (`@forge/policy`: no rule ≠ a rule that allows no one).
   */
  jurisdictions: string
  founderTier: number
  founderJurisdiction: string

  // ─── 3. Limits ─────────────────────────────────────────────────────────────
  transferLimit: string
  periodLimit: string
  periodHours: string

  // ─── 4. Reserve and fee ────────────────────────────────────────────────────
  reserveAmount: string
  reserveCurrency: string
  reserveAgeHours: string
  credential: string
  schema: string
  feeBps: string
  treasury: string
}

export const STEPS = [
  { n: 1, label: 'Token' },
  { n: 2, label: 'Who may hold' },
  { n: 3, label: 'Limits' },
  { n: 4, label: 'Reserve and fee' },
  { n: 5, label: 'Review' },
] as const

export const LAST_STEP = STEPS.length

/**
 * The empty draft.
 *
 * The immutable parameters are unconfirmed, there are no limits, both status
 * sources are on. Numbers that mean something are not invented here: the
 * name, the symbol and the amounts come from the person, and a pre-filled
 * "plausible" value in a compliance form is a value someone will sign without
 * reading.
 */
export const EMPTY_DRAFT: Draft = {
  name: '',
  symbol: '',
  uri: '',
  decimals: '2',
  initialSupply: '',
  ackSymbol: false,
  ackDecimals: false,
  ackPolicy: false,

  sources: ['provider', 'register'],
  minTier: 1,
  attestationAgeHours: '720',
  jurisdictions: '',
  founderTier: 1,
  founderJurisdiction: '',

  transferLimit: '',
  periodLimit: '',
  periodHours: '24',

  reserveAmount: '',
  reserveCurrency: '',
  reserveAgeHours: '24',
  credential: '',
  schema: '',
  feeBps: '0',
  treasury: '',
}

// ─── Numbers ─────────────────────────────────────────────────────────────────

/**
 * An amount in token units → smallest units, **with no floating point**.
 *
 * `Number.parseFloat('25000000.07') * 100` gives 2500000006.9999995, and that
 * is exactly how money loses a cent for no reason. Everything here is
 * computed on strings.
 *
 * `undefined` means "this is not an amount". Excess precision is not an
 * amount either but an error: `1.234` at two decimals is either a typo or a
 * person who thinks the token has three. Silently dropping the tail would
 * mean signing the wrong number.
 */
export function toSmallestUnit(input: string, decimals: number): string | undefined {
  const cleaned = input.replace(/[\s,_]/g, '')
  if (!/^\d+(\.\d*)?$/.test(cleaned)) return undefined
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) return undefined

  const [whole = '', fraction = ''] = cleaned.split('.')
  if (fraction.length > decimals) return undefined

  const digits = `${whole}${fraction.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '')
  return digits === '' ? '0' : digits
}

/** An integer from a form field. `undefined` is "not a number", not zero. */
export function toInteger(input: string): number | undefined {
  const cleaned = input.replace(/[\s,_]/g, '')
  if (!/^\d+$/.test(cleaned)) return undefined
  const value = Number(cleaned)
  return Number.isSafeInteger(value) ? value : undefined
}

/**
 * "ng, GH , ke" → `['NG', 'GH', 'KE']`.
 *
 * The order is not normalised here: the rule model itself normalises it,
 * because `rules_hash` depends on it (T012). Duplicates stay too — the schema
 * rejects them, and doing so silently would mean taking a mistake for intent.
 */
export function parseJurisdictions(raw: string): string[] {
  return raw
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter((code) => code !== '')
}

const hoursToSeconds = (input: string): number | undefined => {
  const hours = toInteger(input)
  return hours === undefined ? undefined : hours * 3600
}

// ─── Draft → policy ──────────────────────────────────────────────────────────

/**
 * The rules in the shape the model accepts.
 *
 * An empty field is an **absent rule**, not a zero one: the `@forge/policy`
 * convention is one for all fields, which is exactly why zero is not a valid
 * limit amount and an empty list of countries is not a way to say "all".
 */
export function draftPolicy(draft: Draft): unknown {
  const decimals = toInteger(draft.decimals) ?? 0

  const transferLimit = toSmallestUnit(draft.transferLimit, decimals)
  const periodAmount = toSmallestUnit(draft.periodLimit, decimals)
  const windowSeconds = hoursToSeconds(draft.periodHours)

  return {
    status: {
      sources: draft.sources,
      minTier: draft.minTier,
      // The attestation validity period makes sense only when attestations are
      // accepted at all; otherwise the field is not "zero" but absent.
      ...(draft.sources.includes('provider')
        ? { maxAttestationAgeSeconds: hoursToSeconds(draft.attestationAgeHours) }
        : {}),
    },
    ...(parseJurisdictions(draft.jurisdictions).length > 0
      ? { jurisdictions: parseJurisdictions(draft.jurisdictions) }
      : {}),
    ...(draft.transferLimit.trim() === '' ? {} : { transferLimit }),
    ...(draft.periodLimit.trim() === ''
      ? {}
      : { periodLimit: { amount: periodAmount, windowSeconds } }),
  }
}

/** The parsed rules, or `undefined` while the draft is not yet a policy. */
export function parsedPolicy(draft: Draft): PolicyRules | undefined {
  const parsed = policyRulesSchema.safeParse(draftPolicy(draft))
  return parsed.success ? parsed.data : undefined
}

// ─── Draft → request body ────────────────────────────────────────────────────

export interface DraftBody {
  ok: boolean
  body?: CreateTokenBody
  /** The problems in the shape the form shows them: "field: what is wrong". */
  problems: readonly string[]
}

/**
 * Draft → the body of `POST /api/tokens`, checked with **the same schema** as
 * on the server.
 *
 * `now` comes as an argument: the reserve attestation time is computed from
 * it, and a hidden `Date.now()` would make this function untestable.
 */
export function toCreateTokenBody(draft: Draft, now: number): DraftBody {
  const decimals = toInteger(draft.decimals)
  const reserveAgeSeconds = hoursToSeconds(draft.reserveAgeHours)

  const candidate = {
    name: draft.name.trim(),
    symbol: draft.symbol.trim(),
    uri: draft.uri.trim(),
    decimals,
    policy: draftPolicy(draft),
    initialSupply: toSmallestUnit(draft.initialSupply, decimals ?? 0),
    reserve: {
      amount: toSmallestUnit(draft.reserveAmount, decimals ?? 0),
      currency: draft.reserveCurrency.trim().toUpperCase(),
      attestedAt: now,
    },
    attestation: {
      credential: draft.credential.trim(),
      schema: draft.schema.trim(),
      maxAgeSeconds: reserveAgeSeconds,
    },
    fee: { treasury: draft.treasury.trim(), bps: toInteger(draft.feeBps) },
    founderStatus: {
      tier: draft.founderTier,
      jurisdiction: draft.founderJurisdiction.trim().toUpperCase(),
      expiresAt: 0,
    },
  }

  const parsed = createTokenBodySchema.safeParse(candidate)
  if (parsed.success) return { ok: true, body: parsed.data, problems: [] }

  return {
    ok: false,
    problems: parsed.error.issues.map((issue) => {
      const field = issue.path.join('.')
      return field === '' ? issue.message : `${field}: ${issue.message}`
    }),
  }
}

// ─── Step readiness ──────────────────────────────────────────────────────────

const missing = (value: string, label: string): string[] =>
  value.trim() === '' ? [`${label} is required`] : []

/**
 * What prevents moving on from this step.
 *
 * An empty array is "the step is complete". A list, not a boolean: the
 * person must be told what is missing, not shown a button painted grey.
 *
 * A step proves **its own** fields, and only them. Cross-cutting checks
 * (issuance against reserve, the founder's status against the policy) sit on
 * the step where both numbers are visible — otherwise step 1 would refuse
 * over a field that is not on it yet.
 */
export function problemsAt(step: number, draft: Draft): readonly string[] {
  const decimals = toInteger(draft.decimals)

  if (step === 1) {
    const problems = [
      ...missing(draft.name, 'token name'),
      ...missing(draft.symbol, 'symbol'),
      ...missing(draft.uri, 'metadata URI'),
    ]
    if (decimals === undefined || decimals > MAX_DECIMALS) {
      problems.push(`decimals must be a whole number from 0 to ${MAX_DECIMALS}`)
    }
    if (toSmallestUnit(draft.initialSupply, decimals ?? 0) === undefined) {
      problems.push(`initial issuance must be an amount with at most ${decimals ?? 0} decimals`)
    }
    if (!(draft.ackSymbol && draft.ackDecimals && draft.ackPolicy)) {
      problems.push('all three fixed parameters must be acknowledged')
    }
    return problems
  }

  if (step === 2) {
    const problems: string[] = []
    if (draft.sources.length === 0) {
      problems.push('a policy with no status source refuses every transfer')
    }
    if (draft.sources.includes('provider')) {
      const seconds = hoursToSeconds(draft.attestationAgeHours)
      if (
        seconds === undefined ||
        seconds < MIN_ATTESTATION_AGE_SECONDS ||
        seconds > MAX_ATTESTATION_AGE_SECONDS
      ) {
        problems.push('provider attestations need a validity between 1 hour and 365 days')
      }
    }
    const codes = parseJurisdictions(draft.jurisdictions)
    if (codes.length > MAX_JURISDICTIONS) {
      problems.push(`a rule holds at most ${MAX_JURISDICTIONS} jurisdictions`)
    }
    if (codes.some((code) => !/^[A-Z]{2}$/.test(code))) {
      problems.push('each jurisdiction is a two-letter ISO 3166-1 code, like NG or GH')
    }
    if (new Set(codes).size !== codes.length) {
      problems.push('a jurisdiction is named twice')
    }
    if (!/^[A-Z]{2}$/.test(draft.founderJurisdiction.trim().toUpperCase())) {
      problems.push('the founder needs a jurisdiction: it goes into their status at issuance')
    }
    return problems
  }

  if (step === 3) {
    const problems: string[] = []
    if (draft.transferLimit.trim() !== '') {
      const amount = toSmallestUnit(draft.transferLimit, decimals ?? 0)
      if (amount === undefined || amount === '0') {
        problems.push('a transfer limit of zero stops every transfer: leave it empty instead')
      }
    }
    if (draft.periodLimit.trim() !== '') {
      const amount = toSmallestUnit(draft.periodLimit, decimals ?? 0)
      if (amount === undefined || amount === '0') {
        problems.push('a period limit of zero stops every transfer: leave it empty instead')
      }
      const seconds = hoursToSeconds(draft.periodHours)
      if (seconds === undefined || seconds < MIN_PERIOD_SECONDS || seconds > MAX_PERIOD_SECONDS) {
        problems.push('the period must be between 1 hour and 31 days')
      }
    }
    return problems
  }

  // Steps 4 and 5 are proven by the same thing the server proves with: the
  // body schema. Here all the fields are visible together for the first time,
  // so the cross-cutting rules (issuance ≤ reserve) are checked exactly on
  // them.
  return toCreateTokenBody(draft, 0).problems
}

/**
 * Warnings are not the same as problems: they block nothing.
 *
 * Both below are about the founder, and the program checks neither. Nor
 * should it: the policy is about transfers, not about who received the
 * initial issuance. The consequence is entirely real, though — a token that
 * goes nowhere — and it must be seen before signing, not after.
 */
export function warningsFor(draft: Draft): readonly string[] {
  const warnings: string[] = []
  const jurisdiction = draft.founderJurisdiction.trim().toUpperCase()
  const allowed = parseJurisdictions(draft.jurisdictions)

  if (allowed.length > 0 && !allowed.includes(jurisdiction)) {
    warnings.push(
      `the founder’s jurisdiction ${jurisdiction || '—'} is not among the ones this policy allows: the whole issuance would sit in an account that cannot send`,
    )
  }
  if (draft.founderTier < draft.minTier) {
    warnings.push(
      `the founder’s tier ${draft.founderTier} is below the minimum ${draft.minTier} this policy requires: the whole issuance would sit in an account that cannot send`,
    )
  }
  return warnings
}
