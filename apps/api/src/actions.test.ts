import {
  actionProposalPda,
  buildApproveAction,
  buildProposeAction,
  compileTransaction,
  createForgeProgram,
  issuerConfigPda,
  type TxPlan,
} from '@forge/chain'
import { rulesHash, toHex } from '@forge/policy/layout'
import { OPEN_POLICY, type PolicyRules } from '@forge/policy/model'
import { ROLE } from '@forge/shared/api'
import { U64_MAX } from '@forge/shared/primitives'
import { Connection, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import {
  bodyMatches,
  createActionReader,
  type ProposalView,
  type QuorumView,
  randomNonce,
  standing,
} from './actions.ts'

const ISSUER_ID = new PublicKey('11111111111111111111111111111112')
const MINT = new PublicKey('So11111111111111111111111111111111111111112')
const ADMIN = 'SysvarC1ock11111111111111111111111111111111'
const OFFICER = 'SysvarS1otHashes111111111111111111111111111'
const WATCHER = 'SysvarRent111111111111111111111111111111111'
const NONCE = 42n
const BLOCKHASH = 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq2h'

const STRICT: PolicyRules = { ...OPEN_POLICY, status: { ...OPEN_POLICY.status, minTier: 2 } }

const quorum = (quorumN = 2): QuorumView => ({
  quorumN,
  members: [
    { wallet: ADMIN, roles: ROLE.ADMIN },
    { wallet: OFFICER, roles: ROLE.COMPLIANCE },
    { wallet: WATCHER, roles: ROLE.OBSERVER },
  ],
})

const SEIZURE = {
  kind: 'seize',
  tokenAccount: WATCHER,
  amount: 2n ** 60n + 7n,
  reason: { code: 4, caseRef: 'FIU-NG/2026/004117' },
} as const

const view = (over: Partial<ProposalView> = {}): ProposalView => ({
  address: actionProposalPda(MINT, NONCE).toBase58(),
  mint: MINT.toBase58(),
  issuerConfig: issuerConfigPda(ISSUER_ID).toBase58(),
  payer: ADMIN,
  nonce: NONCE,
  action: { kind: 'set-policy', version: 2, rulesHash: toHex(rulesHash(STRICT)) },
  approvals: [ADMIN],
  createdAt: 1_000,
  expiresAt: 10_000,
  executedAt: null,
  ...over,
})

describe('where a proposal stands', () => {
  it('one approval of two is open, two is ready', () => {
    expect(standing(view(), quorum(), 5_000)).toEqual({
      state: 'open',
      required: 2,
      counted: 1,
      lapsed: [],
    })
    expect(standing(view({ approvals: [ADMIN, OFFICER] }), quorum(), 5_000).state).toBe('ready')
  })

  it('is live at the last second of its term and expired one second later', () => {
    // The program's `now <= expires_at`. Both sides of the boundary, so that
    // the refusal is known to be about the clock and nothing else.
    const ready = view({ approvals: [ADMIN, OFFICER] })
    expect(standing(ready, quorum(), 10_000).state).toBe('ready')
    expect(standing(ready, quorum(), 10_001).state).toBe('expired')
  })

  it('executed wins over expired: the term does not rewrite what already happened', () => {
    expect(standing(view({ executedAt: 9_000 }), quorum(), 20_000).state).toBe('executed')
  })

  it('an approval by a wallet that lost its role blocks the proposal, even with enough others', () => {
    // `quorum::check` refuses the whole list on one non-authorising address,
    // and an approval cannot be withdrawn. "Ready" here would send a person
    // to pay for a refusal.
    const current = standing(view({ approvals: [ADMIN, OFFICER, WATCHER] }), quorum(), 5_000)
    expect(current).toEqual({ state: 'blocked', required: 2, counted: 2, lapsed: [WATCHER] })
  })

  it('the threshold is read now, so a raised quorum reopens a ready proposal', () => {
    expect(standing(view({ approvals: [ADMIN, OFFICER] }), quorum(3), 5_000).state).toBe('open')
  })
})

describe('the body a proposal committed to', () => {
  it('matches only its own version and rules', () => {
    expect(bodyMatches(view(), { kind: 'set-policy', version: 2, policy: STRICT })).toBe(true)
    expect(bodyMatches(view(), { kind: 'set-policy', version: 3, policy: STRICT })).toBe(false)
    expect(bodyMatches(view(), { kind: 'set-policy', version: 2, policy: OPEN_POLICY })).toBe(false)
  })

  it('a seizure matches only its own account, amount and case — and never a policy', () => {
    const seizure = view({ action: SEIZURE })
    const body = {
      kind: 'seize' as const,
      tokenAccount: new PublicKey(SEIZURE.tokenAccount),
      amount: SEIZURE.amount,
      reason: SEIZURE.reason,
    }
    expect(bodyMatches(seizure, body)).toBe(true)
    expect(bodyMatches(seizure, { ...body, amount: SEIZURE.amount + 1n })).toBe(false)
    expect(bodyMatches(seizure, { ...body, tokenAccount: new PublicKey(ADMIN) })).toBe(false)
    expect(bodyMatches(seizure, { ...body, reason: { code: 4, caseRef: 'OTHER' } })).toBe(false)
    expect(bodyMatches(seizure, { kind: 'set-policy', version: 2, policy: STRICT })).toBe(false)
    expect(bodyMatches(view(), body)).toBe(false)
  })

  it('a pause matches only a pause with its case, never its lifting', () => {
    const reason = { code: 9, caseRef: 'INC-2026-0412' }
    const pause = view({ action: { kind: 'pause', reason } })
    expect(bodyMatches(pause, { kind: 'pause', reason })).toBe(true)
    expect(bodyMatches(pause, { kind: 'resume', reason })).toBe(false)
    expect(bodyMatches(pause, { kind: 'pause', reason: { ...reason, code: 10 } })).toBe(false)
    expect(bodyMatches(pause, { kind: 'pause', reason: { ...reason, caseRef: 'OTHER' } })).toBe(
      false,
    )
    expect(bodyMatches(view(), { kind: 'pause', reason })).toBe(false)
  })
})

describe('reading the body back from the node', () => {
  const program = createForgeProgram(new Connection('http://127.0.0.1:8899'))

  const propose = (policy: PolicyRules, nonce = NONCE) =>
    buildProposeAction(program, {
      issuerId: ISSUER_ID,
      mint: MINT,
      nonce,
      termSeconds: 86_400,
      action: { kind: 'set-policy', version: 2, policy },
      payer: new PublicKey(ADMIN),
      proposer: new PublicKey(ADMIN),
    })

  type Entry = { signature: string; err: unknown; plan: TxPlan }

  /** A node that knows exactly these transactions at the proposal's address, newest first. */
  function node(entries: readonly Entry[]): Connection {
    const bySignature = new Map(entries.map((entry) => [entry.signature, entry]))
    return {
      getSignaturesForAddress: async () =>
        entries.map(({ signature, err }) => ({ signature, err })),
      getTransaction: async (signature: string) => {
        const entry = bySignature.get(signature)
        if (entry === undefined) return null
        return {
          transaction: compileTransaction(entry.plan, BLOCKHASH),
          meta: { loadedAddresses: { writable: [], readonly: [] } },
        }
      },
    } as unknown as Connection
  }

  it('returns the body of the proposing transaction when it matches the digest', async () => {
    const reader = createActionReader(
      node([{ signature: 'a', err: null, plan: await propose(STRICT) }]),
      program,
    )
    const body = await reader.body(view())

    if (body?.kind !== 'set-policy') throw new Error('expected a policy body')
    expect(body.version).toBe(2)
    expect(toHex(rulesHash(body.policy))).toBe(toHex(rulesHash(STRICT)))
  })

  it('reads a seizure from the account and asks the node for nothing', async () => {
    const silent = new Proxy({} as Connection, {
      get: () => () => {
        throw new Error('a seizure body must not be read from the node')
      },
    })
    const body = await createActionReader(silent, program).body(view({ action: SEIZURE }))

    expect(body).toEqual({
      kind: 'seize',
      tokenAccount: new PublicKey(SEIZURE.tokenAccount),
      amount: SEIZURE.amount,
      reason: SEIZURE.reason,
    })
  })

  it('reads a pause from the account too', async () => {
    const silent = new Proxy({} as Connection, {
      get: () => () => {
        throw new Error('a pause body must not be read from the node')
      },
    })
    const reason = { code: 9, caseRef: 'INC-2026-0412' }
    const body = await createActionReader(silent, program).body(
      view({ action: { kind: 'resume', reason } }),
    )
    expect(body).toEqual({ kind: 'resume', reason })
  })

  it('skips approvals, failed transactions and bodies the account did not commit to', async () => {
    const approve = await buildApproveAction(program, {
      issuerId: ISSUER_ID,
      proposal: actionProposalPda(MINT, NONCE),
      approver: new PublicKey(OFFICER),
    })
    const reader = createActionReader(
      node([
        { signature: 'approve', err: null, plan: approve },
        // A failed propose with the right bytes executed nothing.
        { signature: 'failed', err: { InstructionError: [0, 'x'] }, plan: await propose(STRICT) },
        // Another nonce, the same rules — not this proposal.
        { signature: 'other-nonce', err: null, plan: await propose(STRICT, 7n) },
        // This nonce, rules the digest does not match — a propose that lived
        // here before a close, say.
        { signature: 'stale', err: null, plan: await propose(OPEN_POLICY) },
      ]),
      program,
    )

    expect(await reader.body(view())).toBeUndefined()
  })
})

describe('the proposal nonce', () => {
  it('is a u64 and does not repeat', () => {
    const first = randomNonce()
    const second = randomNonce()
    expect(first).toBeGreaterThanOrEqual(0n)
    expect(first).toBeLessThanOrEqual(U64_MAX)
    expect(first).not.toBe(second)
  })
})
