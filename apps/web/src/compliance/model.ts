// The officer's screen without React: amounts, the new-action form, and what
// a proposal asks of the person looking at it.
//
// **The form is checked by the api's own schemas.** The body is assembled here
// and parsed with `freezeBodySchema` / `proposeActionBodySchema` from
// `@forge/api/contracts` — the same objects the server validates with. A
// second, hand-written set of rules in the console would one day accept what
// the server refuses, and the officer would learn it after typing a case.
//
// **What a proposal asks is computed, not guessed from the state alone.**
// "Open" means "sign" only to an authorising wallet that has not signed yet;
// to everyone else it means "wait". The route would refuse the wrong button
// anyway — this keeps it off the screen.
import {
  type ProposalResponse,
  type ProposeActionBody,
  proposeActionBodySchema,
} from '@forge/api/contracts/actions'
import { type FreezeBody, freezeBodySchema } from '@forge/api/contracts/compliance'
import { hasRole, ROLE, ROLE_AUTHORISING } from '@forge/shared/api'
import { reasonCodeLabel } from '@forge/shared/reasons'
import type { z } from 'zod'

// ─── Amounts ─────────────────────────────────────────────────────────────────

/**
 * A u64 in the smallest unit, as a decimal string with grouping.
 *
 * By string arithmetic, never through `number`: supplies past 2^53 are a u64
 * the chain is happy with, and a rounded seizure amount is a different order.
 */
export function formatUnits(raw: string, decimals: number): string {
  const digits = raw.replace(/^0+(?=\d)/, '')
  const padded = digits.padStart(decimals + 1, '0')
  const whole = padded.slice(0, padded.length - decimals)
  const fraction = padded.slice(padded.length - decimals)
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return decimals === 0 ? grouped : `${grouped}.${fraction}`
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

/** A person's decimal amount into the smallest unit. Commas are grouping, not a separator. */
export function parseUnits(text: string, decimals: number): Parsed<string> {
  const cleaned = text.replace(/[,\s]/g, '')
  if (cleaned === '') return { ok: false, error: 'state the amount' }
  const match = /^(\d+)(?:\.(\d*))?$/.exec(cleaned)
  if (match === null) return { ok: false, error: 'an amount is digits with at most one point' }
  const whole = match[1] ?? ''
  const fraction = match[2] ?? ''
  if (fraction.length > decimals) {
    return { ok: false, error: `this token has ${decimals} decimal places` }
  }
  const raw = `${whole}${fraction.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '')
  if (/^0+$/.test(raw)) return { ok: false, error: 'a seizure must take a non-zero amount' }
  if (BigInt(raw) > 2n ** 64n - 1n) return { ok: false, error: 'more than a token can hold' }
  return { ok: true, value: raw }
}

// ─── The new-action form ─────────────────────────────────────────────────────

/** What can be started from the screen. A pause and its lifting are one entry: the token decides which. */
export type ActionKind = 'freeze' | 'seize' | 'circulation'

export interface ActionDraft {
  kind: ActionKind
  /** A wallet or a token account for a freeze; a token account for a seizure. */
  target: string
  targetIs: 'wallet' | 'tokenAccount'
  amount: string
  /** A catalog code as a string, or `'other'` with the number in `otherCode`. */
  reasonCode: string
  otherCode: string
  caseRef: string
  termDays: string
}

export const EMPTY_DRAFT: ActionDraft = {
  kind: 'freeze',
  target: '',
  targetIs: 'wallet',
  amount: '',
  reasonCode: '',
  otherCode: '',
  caseRef: '',
  termDays: '3',
}

export type DraftField = 'target' | 'amount' | 'reason' | 'caseRef' | 'termDays'

export type ActionRequest =
  | { kind: 'freeze'; body: FreezeBody }
  | { kind: 'propose'; body: ProposeActionBody }

export type DraftResult =
  | { ok: true; request: ActionRequest }
  | { ok: false; errors: Partial<Record<DraftField, string>> }

const DAY = 24 * 60 * 60

function reasonCodeOf(draft: ActionDraft): number {
  const text = draft.reasonCode === 'other' ? draft.otherCode : draft.reasonCode
  return /^\d+$/.test(text.trim()) ? Number(text.trim()) : 0
}

/** Which field of the form a schema issue belongs to — by the keys on its path. */
function fieldOf(path: readonly PropertyKey[]): DraftField {
  if (path.includes('termSeconds')) return 'termDays'
  if (path.includes('caseRef')) return 'caseRef'
  if (path.includes('amount')) return 'amount'
  if (path.includes('reason')) return 'reason'
  return 'target'
}

/**
 * The draft as the request the api takes, or the reasons it is not one yet.
 *
 * `paused` decides what "circulation" means: a paused token can only have its
 * pause lifted, and the other way round. The program refuses a pause of a
 * paused mint, so offering both would be offering a refusal.
 */
export function toRequest(draft: ActionDraft, decimals: number, paused: boolean): DraftResult {
  const errors: Partial<Record<DraftField, string>> = {}
  const reason = { code: reasonCodeOf(draft), caseRef: draft.caseRef.trim() }

  let candidate: unknown
  let schema: z.ZodType

  if (draft.kind === 'freeze') {
    // The member, not the union: a union's refusal is one issue at the root,
    // and the form would blame the address for a missing reason.
    const [byWallet, byAccount] = freezeBodySchema.options
    schema = draft.targetIs === 'wallet' ? byWallet : byAccount
    candidate =
      draft.targetIs === 'wallet'
        ? { wallet: draft.target.trim(), reason }
        : { tokenAccount: draft.target.trim(), reason }
  } else {
    schema = proposeActionBodySchema
    const days = Number(draft.termDays)
    let amount = ''
    if (draft.kind === 'seize') {
      const parsed = parseUnits(draft.amount, decimals)
      if (parsed.ok) amount = parsed.value
      else errors.amount = parsed.error
    }
    candidate = {
      action:
        draft.kind === 'seize'
          ? { kind: 'seize', tokenAccount: draft.target.trim(), amount: amount || '0', reason }
          : { kind: paused ? 'resume' : 'pause', reason },
      termSeconds: Number.isFinite(days) ? Math.round(days * DAY) : Number.NaN,
    }
  }

  const parsed = schema.safeParse(candidate)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = fieldOf(issue.path)
      // The amount's own message is better than the schema's "non-zero".
      if (errors[field] === undefined) errors[field] = messageFor(field, issue.message)
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }

  return draft.kind === 'freeze'
    ? { ok: true, request: { kind: 'freeze', body: parsed.data as FreezeBody } }
    : { ok: true, request: { kind: 'propose', body: parsed.data as ProposeActionBody } }
}

function messageFor(field: DraftField, fallback: string): string {
  switch (field) {
    case 'target':
      return 'a base58 address'
    case 'reason':
      return 'a reason code must be stated'
    case 'caseRef':
      return 'a case reference is 1…32 printable ASCII characters'
    case 'termDays':
      return 'a proposal lives between one hour and 30 days'
    case 'amount':
      return fallback
  }
}

// ─── Proposals ───────────────────────────────────────────────────────────────

/** A proposal's action as a heading. */
export function actionTitle(
  action: ProposalResponse['action'],
  decimals: number,
  symbol: string | null,
): string {
  switch (action.kind) {
    case 'seize':
      return `Seizure of ${formatUnits(action.amount, decimals)}${symbol ? ` ${symbol}` : ''}`
    case 'pause':
      return 'Pause of circulation'
    case 'resume':
      return 'Lifting of the pause'
    case 'set-policy':
      return `Policy version ${action.version}`
  }
}

export const reasonLine = (reason: { code: number; caseRef: string }) =>
  `${reasonCodeLabel(reason.code)} · ${reason.caseRef}`

export interface QuorumMember {
  readonly wallet: string
  readonly roles: number
}

/** One seat on the quorum strip: who, in what role, and where they stand. */
export interface Seat {
  readonly wallet: string
  readonly role: 'admin' | 'compliance' | 'former member'
  /** 1-based place in the approval order; `null` — not signed. */
  readonly order: number | null
  /** Signed, but no longer holds an authorising role: the approval blocks the proposal. */
  readonly lapsed: boolean
}

/**
 * Every authorising member, plus anyone who signed and has since left.
 *
 * The signers come first, in signing order, because that order is what the
 * program and the journal keep (FR-019c); the rest follow in roster order.
 */
export function seats(proposal: ProposalResponse, authorising: readonly QuorumMember[]): Seat[] {
  const roleOf = (wallet: string): Seat['role'] => {
    const member = authorising.find((m) => m.wallet === wallet)
    if (member === undefined) return 'former member'
    return hasRole(member.roles, ROLE.ADMIN) ? 'admin' : 'compliance'
  }
  const signed: Seat[] = proposal.approvals.map((wallet, index) => ({
    wallet,
    role: roleOf(wallet),
    order: index + 1,
    lapsed: proposal.lapsed.includes(wallet),
  }))
  const waiting: Seat[] = authorising
    .filter((m) => !proposal.approvals.includes(m.wallet))
    .map((m) => ({ wallet: m.wallet, role: roleOf(m.wallet), order: null, lapsed: false }))
  return [...signed, ...waiting]
}

/** What the person looking at a proposal can do about it, and with which wallet. */
export type NextStep =
  | { kind: 'approve'; signer: string }
  | { kind: 'execute'; signer: string }
  | { kind: 'close'; signer: string }
  | { kind: 'wait'; why: string }

/**
 * The one step this session can take.
 *
 * `wallets` are the session's proven addresses; only those the on-chain roster
 * lists as authorising can sign anything here. The route checks the same, and
 * picks the same wallet when the session has one.
 */
export function nextStep(
  proposal: ProposalResponse,
  authorising: readonly QuorumMember[],
  wallets: readonly string[],
): NextStep {
  const mine = authorising
    .filter((m) => hasRole(m.roles, ROLE_AUTHORISING) && wallets.includes(m.wallet))
    .map((m) => m.wallet)
  const first = mine[0]

  if (proposal.state === 'executed' || proposal.state === 'expired') {
    return first === undefined
      ? { kind: 'wait', why: 'Only an authorising member can close it and return the rent.' }
      : { kind: 'close', signer: first }
  }
  if (proposal.state === 'blocked') {
    return {
      kind: 'wait',
      why: 'A signer has lost their role since approving. The approval cannot be withdrawn, so this proposal can only lapse — raise a new one.',
    }
  }
  if (first === undefined) {
    return { kind: 'wait', why: 'No wallet of this session is an authorising member on chain.' }
  }
  if (proposal.state === 'ready') return { kind: 'execute', signer: first }

  const unsigned = mine.find((wallet) => !proposal.approvals.includes(wallet))
  return unsigned === undefined
    ? { kind: 'wait', why: 'You have signed. It needs another member’s signature.' }
    : { kind: 'approve', signer: unsigned }
}

/** One sentence about where a proposal stands. Nothing has moved until it is executed. */
export function standingLine(proposal: ProposalResponse): string {
  const tally = `${proposal.counted} of ${proposal.required} signatures`
  switch (proposal.state) {
    case 'open':
      return `${tally}. Until the quorum is reached this is a proposal, and nothing has moved.`
    case 'ready':
      return `${tally}. The quorum is reached; the action takes effect when it is executed.`
    case 'blocked':
      return `${tally} that still count. It cannot reach its quorum.`
    case 'executed':
      return 'Executed. The rent of this proposal can now be returned to whoever paid it.'
    case 'expired':
      return 'Expired without being executed. Nothing moved.'
  }
}

/** Unix seconds as `YYYY-MM-DD HH:MM` UTC — the journal's clock, not the viewer's. */
export function utc(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')
}
