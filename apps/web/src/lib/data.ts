export const FINGERPRINT = '8f2a41c79d05b6e3c1748ab2f0396dd5'

export const ISSUANCE = 25000000
export const TO_ISSUER = 24970000
export const PLATFORM_FEE = 30000
export const RESERVE = 25400000
export const HEADROOM = 400000

export type Scenario = {
  scenario: string
  verdict: 'permitted' | 'refused'
  clause?: string
  reason?: string
}

export const SCENARIOS: Scenario[] = [
  { scenario: 'Transfer 120,000.00 to a verified holder, tier 2, NG', verdict: 'permitted' },
  {
    scenario: 'Transfer 120,000.00 to an address with no verification',
    verdict: 'refused',
    clause: '2.1',
    reason: 'no current verification',
  },
  {
    scenario: 'Transfer 50,000.00 to a holder verified at tier 1',
    verdict: 'refused',
    clause: '2.2',
    reason: 'tier below the minimum',
  },
  {
    scenario: 'Transfer 90,000.00 to a verified holder in ZA',
    verdict: 'refused',
    clause: '2.3',
    reason: 'jurisdiction not allowed',
  },
  {
    scenario: 'Transfer 640,000.00 to a verified holder',
    verdict: 'refused',
    clause: '3.1',
    reason: 'over the single-transfer limit',
  },
  {
    scenario: 'Third transfer of 700,000.00 within 24 hours',
    verdict: 'refused',
    clause: '3.2',
    reason: '2,100,000.00 exceeds the daily limit',
  },
  {
    scenario: 'Transfer 10,000.00 to a blocked address',
    verdict: 'refused',
    clause: '3.3',
    reason: 'address is on the blocked register',
  },
  {
    scenario: 'Any transfer while transfers are paused',
    verdict: 'refused',
    clause: '4.3',
    reason: 'transfers are paused',
  },
]

export const CARRIED_RECORDS = [
  'the policy',
  'the sender’s status',
  'the recipient’s status',
  'the sender’s 24-hour counter',
  'the recipient’s verification',
]

export const REFUSALS_BY_CLAUSE = [
  { clause: '2.1', name: 'no current verification', count: 41 },
  { clause: '3.1', name: 'over the single-transfer limit', count: 12 },
  { clause: '3.3', name: 'blocked address', count: 6 },
  { clause: '2.3', name: 'jurisdiction not allowed', count: 4 },
]

export type FeedEvent = {
  id: string
  time: string
  event: string
  amount?: string
  counterparty?: string
  clause?: string
  refused?: boolean
  caseLink?: boolean
}

export const FEED: FeedEvent[] = [
  {
    id: 'feed-01',
    time: '11:42',
    event: 'seizure proposed · case REG-2026-0412',
    counterparty: 'Vant4raDemo7hQ2nR9wKp5xTbZmYs6LgC8jEuA3fDhR1',
    caseLink: true,
  },
  {
    id: 'feed-02',
    time: '11:31',
    event: 'transfer refused',
    amount: '640,000.00 vNGN',
    counterparty: 'Vant4raDemo9bXc4nHq7wRt2sLmY6pKd5gJvE8uZaF3',
    clause: '3.1',
    refused: true,
  },
  {
    id: 'feed-03',
    time: '11:18',
    event: 'transfer',
    amount: '120,000.00 vNGN',
    counterparty: 'Vant4raDemo3nQw8kTz5vBmXr2yHpLc9dGsA6jFuN7e',
  },
  {
    id: 'feed-04',
    time: '10:56',
    event: 'account unblocked',
    counterparty: 'Vant4raDemo6yTb3xKw9nQz2vRmSp5hLcD8jGuA4fEr',
  },
  {
    id: 'feed-05',
    time: '10:44',
    event: 'transfer refused',
    amount: '75,000.00 vNGN',
    counterparty: 'Vant4raDemo8kMz2vQw6nTb5xRpYs3hLcG9dJuE7aF',
    clause: '2.1',
    refused: true,
  },
  {
    id: 'feed-06',
    time: '10:12',
    event: 'transfer',
    amount: '48,500.00 vNGN',
    counterparty: 'Vant4raDemo4pLw7sQn2kXb9vTmYr6hGcD3jZuA5eF',
  },
  {
    id: 'feed-07',
    time: '09:37',
    event: 'reserve attestation published',
    amount: '25,400,000.00 NGN',
    counterparty: 'Attestor · external',
  },
  {
    id: 'feed-08',
    time: '09:15',
    event: 'transfer refused',
    amount: '90,000.00 vNGN',
    counterparty: 'Vant4raDemo1zRq5nWk8vTp3xBmYc7hLsG2dJuA9eN',
    clause: '2.3',
    refused: true,
  },
]

export const AWAITING_UNBLOCK = [
  {
    address: 'Vant4raDemo6yTb3xKw9nQz2vRmSp5hLcD8jGuA4fE',
    tier: 'tier 2',
    jurisdiction: 'NG',
    waiting: '4 h 06 min',
  },
  {
    address: 'Vant4raDemo3nQw8kTz5vBmXr2yHpLc9dGsA6jFuN7',
    tier: 'tier 3',
    jurisdiction: 'GH',
    waiting: '9 h 41 min',
  },
  {
    address: 'Vant4raDemo8sKp2vNw6qTb4xRmYc7hLzG5dJuA3eF',
    tier: 'tier 2',
    jurisdiction: 'KE',
    waiting: '1 d 02 h',
  },
  {
    address: 'Vant4raDemo5wQz9nKt3vBpXr7yHmLc2dGsA8jFuE4',
    tier: 'tier 2',
    jurisdiction: 'NG',
    waiting: '1 d 07 h',
  },
]

export const CASE_ACTIONS = [
  {
    id: 'case-01',
    date: '2026-08-21',
    action: 'seizure proposed',
    target: 'Vant4raDemo7hQ2nR9wKp5xTbZmYs6LgC8jEuA3fDhR1',
    amount: '180,000.00 vNGN',
    reason: 'SANCTIONS-MATCH',
    signers: 'F.B.',
  },
  {
    id: 'case-02',
    date: '2026-08-20',
    action: 'freeze',
    target: 'Vant4raDemo7hQ2nR9wKp5xTbZmYs6LgC8jEuA3fDhR1',
    amount: '—',
    reason: 'SANCTIONS-MATCH',
    signers: 'F.B. · A.O.',
  },
  {
    id: 'case-03',
    date: '2026-08-19',
    action: 'unpause',
    target: '—',
    amount: '—',
    reason: 'INCIDENT-CLOSED',
    signers: 'A.O. · R.A.',
  },
  {
    id: 'case-04',
    date: '2026-08-19',
    action: 'pause',
    target: '—',
    amount: '—',
    reason: 'INCIDENT-OPEN',
    signers: 'A.O. · T.M.',
  },
  {
    id: 'case-05',
    date: '2026-08-15',
    action: 'seizure executed',
    target: 'Vant4raDemo2kLp8sW3vNbXqZrTy4mHgD6cJuE5nFaS9',
    amount: '64,200.00 vNGN',
    reason: 'FRAUD-CONFIRMED',
    signers: 'T.M. · R.A.',
  },
  {
    id: 'case-06',
    date: '2026-08-10',
    action: 'freeze',
    target: 'Vant4raDemo5tRw9xQm2nBzKp7vLcYs3hGdA8jFuN4eT',
    amount: '—',
    reason: 'COURT-ORDER',
    signers: 'F.B. · R.A.',
  },
]
