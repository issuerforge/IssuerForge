import type { ProposalResponse } from '@forge/api/contracts/actions'
import { ROLE } from '@forge/shared/api'
import { describe, expect, it } from 'vitest'
import {
  type ActionDraft,
  actionTitle,
  EMPTY_DRAFT,
  formatUnits,
  nextStep,
  parseUnits,
  type QuorumMember,
  seats,
  standingLine,
  toRequest,
} from './model.ts'

const ADMIN = 'SysvarC1ock11111111111111111111111111111111'
const OFFICER = 'SysvarS1otHashes111111111111111111111111111'
const SECOND_OFFICER = 'SysvarRent111111111111111111111111111111111'
const HOLDER = 'SysvarRecentB1ockHashes11111111111111111111'
const MINT = 'So11111111111111111111111111111111111111112'
const PROPOSAL = 'SysvarS1otHistory11111111111111111111111111'

const AUTHORISING: QuorumMember[] = [
  { wallet: ADMIN, roles: ROLE.ADMIN },
  { wallet: OFFICER, roles: ROLE.COMPLIANCE },
]

const proposal = (over: Partial<ProposalResponse> = {}): ProposalResponse => ({
  address: PROPOSAL,
  mint: MINT,
  nonce: '7',
  payer: OFFICER,
  action: { kind: 'pause', reason: { code: 8, caseRef: 'INC-2026-11' } },
  approvals: [OFFICER],
  state: 'open',
  required: 2,
  counted: 1,
  lapsed: [],
  createdAt: 1_790_000_000,
  expiresAt: 1_790_259_200,
  executedAt: null,
  ...over,
})

const draft = (over: Partial<ActionDraft>): ActionDraft => ({
  ...EMPTY_DRAFT,
  reasonCode: '4',
  caseRef: 'FIU-NG/2026/004117',
  ...over,
})

describe('amounts', () => {
  it('formats the smallest unit with grouping, past 2^53 without rounding', () => {
    expect(formatUnits('180000000000', 6)).toBe('180,000.000000')
    expect(formatUnits('5', 6)).toBe('0.000005')
    expect(formatUnits('0', 2)).toBe('0.00')
    expect(formatUnits('1152921504606846983', 0)).toBe('1,152,921,504,606,846,983')
  })

  it('parses a person’s decimal back into the smallest unit', () => {
    expect(parseUnits('180,000.5', 6)).toEqual({ ok: true, value: '180000500000' })
    expect(parseUnits('0.000001', 6)).toEqual({ ok: true, value: '1' })
  })

  it('refuses what is not an exact amount of this token', () => {
    expect(parseUnits('1.0000001', 6).ok).toBe(false)
    expect(parseUnits('0', 6).ok).toBe(false)
    expect(parseUnits('1e6', 6).ok).toBe(false)
    expect(parseUnits('', 6).ok).toBe(false)
    expect(parseUnits('18446744073709551616', 0).ok).toBe(false)
  })
})

describe('the new-action form', () => {
  it('a freeze by wallet becomes the freeze body the api takes', () => {
    expect(toRequest(draft({ target: HOLDER }), 6, false)).toEqual({
      ok: true,
      request: {
        kind: 'freeze',
        body: { wallet: HOLDER, reason: { code: 4, caseRef: 'FIU-NG/2026/004117' } },
      },
    })
  })

  it('a freeze by token account names the account, not a wallet', () => {
    const result = toRequest(draft({ target: HOLDER, targetIs: 'tokenAccount' }), 6, false)
    expect(result.ok && result.request.body).toEqual({
      tokenAccount: HOLDER,
      reason: { code: 4, caseRef: 'FIU-NG/2026/004117' },
    })
  })

  it('without a reason code nothing is sent, and the form says which field (FR-017)', () => {
    const result = toRequest(draft({ target: HOLDER, reasonCode: '' }), 6, false)
    expect(result).toEqual({ ok: false, errors: { reason: 'a reason code must be stated' } })
  })

  it('blames the case reference, not the address, for a non-ASCII case', () => {
    const result = toRequest(draft({ target: HOLDER, caseRef: 'café' }), 6, false)
    expect(result.ok === false && Object.keys(result.errors)).toEqual(['caseRef'])
  })

  it('takes a code outside the catalog as the number typed', () => {
    const result = toRequest(
      draft({ target: HOLDER, reasonCode: 'other', otherCode: '4242' }),
      6,
      false,
    )
    expect(result.ok && result.request.kind === 'freeze' && result.request.body.reason.code).toBe(
      4242,
    )
  })

  it('a seizure is a proposal with the exact amount in the smallest unit', () => {
    const result = toRequest(
      draft({ kind: 'seize', target: HOLDER, amount: '180,000', termDays: '3' }),
      6,
      false,
    )
    expect(result).toEqual({
      ok: true,
      request: {
        kind: 'propose',
        body: {
          action: {
            kind: 'seize',
            tokenAccount: HOLDER,
            amount: '180000000000',
            reason: { code: 4, caseRef: 'FIU-NG/2026/004117' },
          },
          termSeconds: 3 * 86_400,
        },
      },
    })
  })

  it('a seizure with a bad amount and a bad term names both', () => {
    const result = toRequest(
      draft({ kind: 'seize', target: HOLDER, amount: '1.0000001', termDays: '45' }),
      6,
      false,
    )
    expect(result.ok === false && Object.keys(result.errors).sort()).toEqual(['amount', 'termDays'])
  })

  it('circulation means a pause on a running token and its lifting on a paused one', () => {
    const running = toRequest(draft({ kind: 'circulation' }), 6, false)
    const paused = toRequest(draft({ kind: 'circulation' }), 6, true)
    expect(
      running.ok && running.request.kind === 'propose' && running.request.body.action.kind,
    ).toBe('pause')
    expect(paused.ok && paused.request.kind === 'propose' && paused.request.body.action.kind).toBe(
      'resume',
    )
  })
})

describe('what a proposal asks of this session', () => {
  it('asks an authorising wallet that has not signed for its signature', () => {
    expect(nextStep(proposal(), AUTHORISING, [ADMIN])).toEqual({ kind: 'approve', signer: ADMIN })
  })

  it('asks the proposer to wait, not to sign twice', () => {
    expect(nextStep(proposal(), AUTHORISING, [OFFICER]).kind).toBe('wait')
  })

  it('picks the wallet that has not signed when the session holds two', () => {
    const both = [...AUTHORISING, { wallet: SECOND_OFFICER, roles: ROLE.COMPLIANCE }]
    expect(nextStep(proposal(), both, [OFFICER, SECOND_OFFICER])).toEqual({
      kind: 'approve',
      signer: SECOND_OFFICER,
    })
  })

  it('offers execution once ready, and closing once over', () => {
    expect(nextStep(proposal({ state: 'ready' }), AUTHORISING, [OFFICER]).kind).toBe('execute')
    expect(nextStep(proposal({ state: 'executed' }), AUTHORISING, [OFFICER]).kind).toBe('close')
    expect(nextStep(proposal({ state: 'expired' }), AUTHORISING, [ADMIN]).kind).toBe('close')
  })

  it('offers nothing on a blocked proposal: another signature cannot help', () => {
    const step = nextStep(proposal({ state: 'blocked', lapsed: [OFFICER] }), AUTHORISING, [ADMIN])
    expect(step.kind).toBe('wait')
  })

  it('offers nothing to an observer, whatever the state', () => {
    for (const state of ['open', 'ready', 'executed'] as const) {
      expect(nextStep(proposal({ state }), AUTHORISING, [HOLDER]).kind).toBe('wait')
    }
  })
})

describe('the quorum strip', () => {
  it('lists signers in signing order, then the members still to sign', () => {
    expect(seats(proposal(), AUTHORISING)).toEqual([
      { wallet: OFFICER, role: 'compliance', order: 1, lapsed: false },
      { wallet: ADMIN, role: 'admin', order: null, lapsed: false },
    ])
  })

  it('keeps a signer who has left the roster, marked as the reason it is blocked', () => {
    const blocked = proposal({
      state: 'blocked',
      approvals: [SECOND_OFFICER],
      lapsed: [SECOND_OFFICER],
    })
    expect(seats(blocked, AUTHORISING)[0]).toEqual({
      wallet: SECOND_OFFICER,
      role: 'former member',
      order: 1,
      lapsed: true,
    })
  })
})

describe('headings and standing', () => {
  it('names the action with its amount', () => {
    const seize = {
      kind: 'seize' as const,
      tokenAccount: HOLDER,
      amount: '180000000000',
      reason: { code: 4, caseRef: 'X' },
    }
    expect(actionTitle(seize, 6, 'vNGN')).toBe('Seizure of 180,000.000000 vNGN')
    expect(actionTitle(proposal().action, 6, null)).toBe('Pause of circulation')
  })

  it('says nothing has moved until execution', () => {
    expect(standingLine(proposal())).toMatch(/^1 of 2 signatures\..*nothing has moved/)
  })
})
