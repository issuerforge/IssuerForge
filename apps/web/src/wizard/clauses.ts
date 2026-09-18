// The policy in words: draft → numbered sentences of the rulebook.
//
// This is not screen decoration. A rule the person switched on with a toggle
// they sign as a sentence, and there must be no translation between the two:
// the rulebook is built from **the same** draft the request body is
// assembled from, not from a separate description beside it.
//
// A pure function — and that is exactly why it is tested without the DOM: in
// the M0 prototype the same thing lived inside a component, and could be
// checked only by eye.
import type { Draft } from './draft.ts'
import { parseJurisdictions, toInteger, toSmallestUnit } from './draft.ts'

export interface Clause {
  /** The number a sentence is referred to by: "clause 2.3". */
  readonly id: string
  /** The step that controls it. A click in the rulebook leads exactly there. */
  readonly step: number
  readonly text: string
}

const listWords = (items: readonly string[]): string => {
  const last = items.at(-1)
  if (last === undefined) return ''
  if (items.length === 1) return last
  return `${items.slice(0, -1).join(', ')} or ${last}`
}

/** An amount in token units, as written in a document. */
const shown = (raw: string, symbol: string, decimals: number): string => {
  const smallest = toSmallestUnit(raw, decimals)
  if (smallest === undefined) return `— ${symbol}`

  const padded = smallest.padStart(decimals + 1, '0')
  const whole = padded.slice(0, padded.length - decimals) || '0'
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const fraction = decimals === 0 ? '' : `.${padded.slice(padded.length - decimals)}`
  return `${grouped}${fraction} ${symbol}`
}

const hours = (raw: string): string => {
  const value = toInteger(raw)
  if (value === undefined) return '—'
  if (value % 24 === 0 && value >= 24) {
    const days = value / 24
    return days === 1 ? '24 hours' : `${days} days`
  }
  return value === 1 ? '1 hour' : `${value} hours`
}

export function buildClauses(draft: Draft): Clause[] {
  const symbol = draft.symbol.trim() || '—'
  const decimals = toInteger(draft.decimals) ?? 0
  const smallest = decimals > 0 ? `0.${'0'.repeat(decimals - 1)}1` : '1'

  const provider = draft.sources.includes('provider')
  const register = draft.sources.includes('register')

  let sources: string
  if (provider && register) {
    sources =
      'Only an account holding a current verification from an accepted source may receive this token. Accepted sources are an external verification provider and this issuer’s own register.'
  } else if (provider) {
    sources =
      'Only an account holding a current verification from an external verification provider may receive this token. This issuer’s own register is not an accepted source.'
  } else if (register) {
    sources =
      'Only an account carried in this issuer’s own register may receive this token. Attestations from an external verification provider are not accepted.'
  } else {
    // Neither a typo nor an empty state: a policy with no status source at
    // all refuses every transfer, and that must be said in the same kind of
    // sentence the rest is described with — otherwise the mistake is visible
    // only by the absence of text.
    sources = 'No source of verification is accepted, so no account may receive this token.'
  }

  const clauses: Clause[] = [
    {
      id: '1.1',
      step: 1,
      text: `This token is ${draft.name.trim() || 'unnamed'}, written as ${symbol}.`,
    },
    {
      id: '1.2',
      step: 1,
      text: `Amounts are held to ${decimals} decimal places. The smallest amount that can move is ${smallest} ${symbol}. Neither the symbol nor the number of decimals can change afterwards.`,
    },
    {
      id: '1.3',
      step: 1,
      text: `Signing this policy issues ${shown(draft.initialSupply, symbol, decimals)} and no more. Any further issuance is a separate action under these rules.`,
    },
    { id: '2.1', step: 2, text: sources },
    {
      id: '2.2',
      step: 2,
      text:
        draft.minTier === 0
          ? 'No tier of verification is required: a current status of any tier is enough.'
          : `That verification must be of tier ${draft.minTier} or above.`,
    },
  ]

  if (provider) {
    clauses.push({
      id: '2.3',
      step: 2,
      text: `A provider attestation older than ${hours(draft.attestationAgeHours)} counts as absent, not as a refusal.`,
    })
  }

  const allowed = parseJurisdictions(draft.jurisdictions)
  clauses.push({
    id: provider ? '2.4' : '2.3',
    step: 2,
    text:
      allowed.length === 0
        ? 'Jurisdiction is not checked: a holder may be resident anywhere.'
        : `A holder must be resident in ${listWords(allowed)}. Any other jurisdiction is refused.`,
  })

  clauses.push({
    id: '3.1',
    step: 3,
    text:
      draft.transferLimit.trim() === ''
        ? 'A single transfer is not capped by this policy.'
        : `A single transfer may not exceed ${shown(draft.transferLimit, symbol, decimals)}.`,
  })

  clauses.push({
    id: '3.2',
    step: 3,
    text:
      draft.periodLimit.trim() === ''
        ? 'There is no cap on how much one holder moves over a period.'
        : `One holder may not move more than ${shown(draft.periodLimit, symbol, decimals)} in any ${hours(draft.periodHours)}.`,
  })

  clauses.push({
    id: '4.1',
    step: 4,
    text: `Issuance is capped by an attested reserve of ${shown(draft.reserveAmount, draft.reserveCurrency.trim().toUpperCase() || '—', decimals)}, and the network refuses anything above it.`,
  })

  clauses.push({
    id: '4.2',
    step: 4,
    text: `An attestation older than ${hours(draft.reserveAgeHours)} stops further issuance. It does not stop transfers.`,
  })

  return clauses
}
