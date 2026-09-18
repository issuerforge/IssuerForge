import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react'
import { amount, parseAmount } from '@/lib/format'

export type BlockedEntry = { address: string; reason: string }

export type PolicyState = {
  tokenName: string
  symbol: string
  decimals: string
  jurisdiction: string
  issuance: string

  ackSymbol: boolean
  ackDecimals: boolean
  ackPolicy: boolean

  sourceProvider: boolean
  sourceRegister: boolean
  minTier: number
  jurisdictions: string[]

  maxSingle: string
  maxDaily: string
  blockedVisible: BlockedEntry[]
  blockedHidden: number

  freeze: boolean
  seize: boolean
  pause: boolean
  quorumN: number

  delegatedUnblock: boolean
  delegatedRegister: boolean
  delegatedRedemptions: boolean
}

export const ALL_JURISDICTIONS = ['NG', 'GH', 'KE', 'ZA', 'EG', 'MA', 'CI']

export const QUORUM_PARTIES = [
  { role: 'Admin', initials: 'A.O.' },
  { role: 'Admin', initials: 'R.A.' },
  { role: 'Compliance', initials: 'F.B.' },
  { role: 'Compliance', initials: 'T.M.' },
]

export const INITIAL_POLICY: PolicyState = {
  tokenName: 'Vantara Naira',
  symbol: 'vNGN',
  decimals: '2',
  jurisdiction: 'Nigeria',
  issuance: '25,000,000.00',

  ackSymbol: false,
  ackDecimals: false,
  ackPolicy: false,

  sourceProvider: true,
  sourceRegister: true,
  minTier: 2,
  jurisdictions: ['NG', 'GH', 'KE'],

  maxSingle: '500,000.00',
  maxDaily: '2,000,000.00',
  blockedVisible: [
    { address: 'Vant4raDemo7hQ2nR9wKp5xTbZmYs6LgC8jEuA3fDhR1', reason: 'SANCTIONS-MATCH' },
    { address: 'Vant4raDemo2kLp8sW3vNbXqZrTy4mHgD6cJuE5nFaS9', reason: 'FRAUD-CONFIRMED' },
    { address: 'Vant4raDemo5tRw9xQm2nBzKp7vLcYs3hGdA8jFuN4eT', reason: 'COURT-ORDER' },
  ],
  blockedHidden: 3,

  freeze: true,
  seize: true,
  pause: true,
  quorumN: 2,

  delegatedUnblock: true,
  delegatedRegister: true,
  delegatedRedemptions: true,
}

export type Clause = { id: string; step: number; text: string }

const listWords = (items: string[]): string => {
  const last = items.at(-1)
  if (last === undefined) return ''
  if (items.length === 1) return last
  return `${items.slice(0, -1).join(', ')} or ${last}`
}

export function buildClauses(p: PolicyState): Clause[] {
  const unit = p.symbol || 'vNGN'
  const decimals = Number.parseInt(p.decimals || '0', 10) || 0
  const smallest = decimals > 0 ? `0.${'0'.repeat(decimals - 1)}1` : '1'

  let sources: string
  if (p.sourceProvider && p.sourceRegister) {
    sources =
      'Only an account holding a current verification from an accepted source may receive this token. Accepted sources are an external verification provider and this issuer’s own register.'
  } else if (p.sourceProvider) {
    sources =
      'Only an account holding a current verification from an external verification provider may receive this token. This issuer’s own register is not an accepted source.'
  } else if (p.sourceRegister) {
    sources =
      'Only an account carried in this issuer’s own register may receive this token. Attestations from an external verification provider are not accepted.'
  } else {
    sources = 'No source of verification is accepted, so no account may receive this token.'
  }

  const jurisdictionClause =
    p.jurisdictions.length === 0
      ? 'No jurisdiction is allowed to hold this token, so every transfer is refused.'
      : `A holder must be resident in ${listWords(p.jurisdictions)}. Any other jurisdiction is refused.`

  const blockedCount = p.blockedVisible.length + p.blockedHidden

  const delegated = [
    p.delegatedUnblock ? 'unblock accounts' : null,
    p.delegatedRegister ? 'update this issuer’s own register' : null,
    p.delegatedRedemptions ? 'settle redemptions' : null,
  ].filter(Boolean) as string[]

  return [
    {
      id: '1.1',
      step: 1,
      text: `This token is ${p.tokenName || 'unnamed'}, written as ${unit}, issued under the law of ${p.jurisdiction || 'no stated jurisdiction'}.`,
    },
    {
      id: '1.2',
      step: 1,
      text: `Amounts are held to ${decimals} decimal places. The smallest amount that can move is ${smallest} ${unit}.`,
    },
    {
      id: '1.3',
      step: 1,
      text: `Signing this policy issues ${amount(parseAmount(p.issuance), unit)} and no more. Any further issuance is a new proposal under these rules.`,
    },
    { id: '2.1', step: 2, text: sources },
    {
      id: '2.2',
      step: 2,
      text: `That verification must be of tier ${p.minTier} or above.`,
    },
    { id: '2.3', step: 2, text: jurisdictionClause },
    {
      id: '3.1',
      step: 3,
      text: `A single transfer may not exceed ${amount(parseAmount(p.maxSingle), unit)}.`,
    },
    {
      id: '3.2',
      step: 3,
      text: `One holder may not move more than ${amount(parseAmount(p.maxDaily), unit)} in any 24 hours.`,
    },
    {
      id: '3.3',
      step: 3,
      text:
        blockedCount === 0
          ? 'The blocked register is empty. No address is refused on that ground.'
          : `An address on this issuer’s blocked register may neither send nor receive. The register holds ${blockedCount} ${blockedCount === 1 ? 'address' : 'addresses'}.`,
    },
    {
      id: '4.1',
      step: 4,
      text: p.freeze
        ? 'A compliance officer may freeze one account, stopping it from sending and from receiving.'
        : 'No account can be frozen. A holder’s ability to send and receive cannot be suspended.',
    },
    {
      id: '4.2',
      step: 4,
      text: p.seize
        ? 'Funds may be taken from a named account without that holder’s signature.'
        : 'Funds can never be taken from a holder without that holder’s signature.',
    },
    {
      id: '4.3',
      step: 4,
      text: p.pause
        ? 'Every transfer of this token may be paused at once, and resumed the same way.'
        : 'Transfers cannot be paused. The token keeps moving whatever else happens.',
    },
    {
      id: '4.4',
      step: 4,
      text:
        p.quorumN <= 1
          ? 'Issuance, seizure, pause and any change to these rules need one signature from the four authorised parties and take effect at once.'
          : `Issuance, seizure, pause and any change to these rules need ${p.quorumN} of 4 signatures. One signature is a proposal and has no effect.`,
    },
    {
      id: '4.5',
      step: 4,
      text:
        delegated.length === 0
          ? 'The platform’s operational key holds no permission on this token. It can never issue tokens, move a holder’s funds, pause transfers or change these rules.'
          : `The platform’s operational key may ${listWords(delegated)}, and nothing else. It can never issue tokens, move a holder’s funds, pause transfers or change these rules.`,
    },
  ]
}

type PolicyContextValue = {
  policy: PolicyState
  set: <K extends keyof PolicyState>(key: K, value: PolicyState[K]) => void
  clauses: Clause[]
  maxStep: number
  visit: (step: number) => void
}

const PolicyContext = createContext<PolicyContextValue | null>(null)

export function PolicyProvider({ children }: { children: ReactNode }) {
  const [policy, setPolicy] = useState<PolicyState>(INITIAL_POLICY)
  const [maxStep, setMaxStep] = useState(1)

  // Stable across renders: a step calls `visit` from a useEffect, and if the
  // function changed along with the policy, the effect would fire on every
  // field edit.
  const set = useCallback(<K extends keyof PolicyState>(key: K, value: PolicyState[K]) => {
    setPolicy((prev) => ({ ...prev, [key]: value }))
  }, [])

  const visit = useCallback((step: number) => {
    setMaxStep((prev) => (step > prev ? step : prev))
  }, [])

  const value = useMemo<PolicyContextValue>(
    () => ({ policy, set, clauses: buildClauses(policy), maxStep, visit }),
    [policy, maxStep, set, visit],
  )

  return <PolicyContext.Provider value={value}>{children}</PolicyContext.Provider>
}

export function usePolicy(): PolicyContextValue {
  const ctx = useContext(PolicyContext)
  if (!ctx) throw new Error('usePolicy must be used inside PolicyProvider')
  return ctx
}
