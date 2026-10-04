// The stand's api: the officer's routes served from memory, in the shapes of
// `@forge/api/contracts` and checked against them on the way out — exactly as
// the real client checks the network.
//
// A transaction here is a token for a pending change. The fake submitter
// "signs" it by applying that change, so a freeze appears in the totals, a
// second signature turns a proposal ready, and an execution pauses the token —
// the same sequence the officer sees on devnet, without a node.
import type { ProposalResponse } from '@forge/api/contracts/actions'
import type { FreezeResponse, TokenListing } from '@forge/api/contracts/compliance'
import type { DelegationChange } from '@forge/api/contracts/delegation'
import { DELEGATION, type PowerName, powerNames, ROLE, type Session } from '@forge/shared/api'
import type { z } from 'zod'
import { type ApiClient, ApiRequestError } from '@/api/client'
import type { Submitter } from '@/compliance/submit'

export const ISSUER = '11111111111111111111111111111112'
export const OFFICER = 'SysvarS1otHashes111111111111111111111111111'
export const ADMIN = 'SysvarC1ock11111111111111111111111111111111'
const MINT = 'So11111111111111111111111111111111111111112'
const VAULT = 'SysvarStakeHistory1111111111111111111111111'
const SUSPECT = 'SysvarRecentB1ockHashes11111111111111111111'
const SUSPECT_ACCOUNT = 'SysvarS1otHistory11111111111111111111111111'
const OTHER = 'SysvarEpochSchedu1e111111111111111111111111'
const OTHER_ACCOUNT = 'SysvarRent111111111111111111111111111111111'
const PROPOSAL = 'SysvarFees111111111111111111111111111111111'
const PLATFORM = 'Sysvar1nstructions1111111111111111111111111'
const GRANT = 'SysvarLastRestartS1ot1111111111111111111111'
const NOW = 1_790_000_000 // 2026-09-21 — the stand's clock stands still

export const SESSIONS: Record<'officer' | 'admin', Session> = {
  officer: session(OFFICER, ROLE.COMPLIANCE),
  admin: session(ADMIN, ROLE.ADMIN),
}

function session(wallet: string, roles: number): Session {
  return {
    userId: `did:privy:stand-${wallet.slice(6, 10)}`,
    issuerId: ISSUER,
    roles,
    wallets: [wallet],
    memberships: [
      { issuerId: ISSUER, roles, wallets: [wallet], syncedAt: '2026-09-21T09:00:00.000Z' },
    ],
  }
}

interface State {
  paused: boolean
  supply: bigint
  seized: bigint
  freezes: FreezeResponse[]
  proposals: ProposalResponse[]
  delegation: { key: string; mask: number }
  history: DelegationChange[]
}

const reason = (code: number, caseRef: string) => ({ code, caseRef })

function initial(): State {
  return {
    delegation: { key: PLATFORM, mask: 3 },
    history: [],
    paused: false,
    supply: 2_500_000_000_000n,
    seized: 0n,
    freezes: [
      {
        tokenAccount: SUSPECT_ACCOUNT,
        wallet: SUSPECT,
        officer: OFFICER,
        payer: OFFICER,
        reason: reason(1, 'REG-2026-0412'),
        frozenAt: NOW - 86_400,
        wasThawed: true,
        amount: '180000000000',
      },
    ],
    proposals: [
      {
        address: PROPOSAL,
        mint: MINT,
        nonce: '3735928559',
        payer: OFFICER,
        action: {
          kind: 'seize',
          tokenAccount: SUSPECT_ACCOUNT,
          amount: '180000000000',
          reason: reason(1, 'REG-2026-0412'),
        },
        approvals: [OFFICER],
        state: 'open',
        required: 2,
        counted: 1,
        lapsed: [],
        createdAt: NOW - 3_600,
        expiresAt: NOW + 2 * 86_400,
        executedAt: null,
      },
    ],
  }
}

const AUTHORISING = [
  { wallet: ADMIN, roles: ROLE.ADMIN },
  { wallet: OFFICER, roles: ROLE.COMPLIANCE },
]

/** The api and the submitter share one memory: what is "signed" here is read back there. */
export function createStand(wallet: () => string): { api: ApiClient; submitter: Submitter } {
  const state = initial()
  const pending = new Map<string, () => void>()
  let counter = 0

  const frozenTotal = () => state.freezes.reduce((sum, f) => sum + BigInt(f.amount), 0n)

  const token = (): TokenListing => ({
    mint: MINT,
    index: 0,
    decimals: 6,
    supply: state.supply.toString(),
    paused: state.paused,
    pausedAt: state.paused ? NOW : null,
    name: 'Naira Demo',
    symbol: 'vNGN',
    policyVersion: 1,
  })

  const restate = (proposal: ProposalResponse): ProposalResponse => ({
    ...proposal,
    counted: proposal.approvals.length,
    state:
      proposal.executedAt !== null
        ? 'executed'
        : proposal.approvals.length >= proposal.required
          ? 'ready'
          : 'open',
  })

  /** A pending change as an unsigned transaction the submitter can find again. */
  const tx = (signer: string, step: string, apply: () => void) => {
    counter += 1
    const base64 = btoa(`stand:${counter}`)
    pending.set(base64, apply)
    return { step, base64, signers: [signer], dependsOnPrevious: false, bytes: 400 }
  }

  /** A delegation change applied, and its history row — what the indexer writes. */
  const record = (
    key: string,
    mask: number,
    path: 'immediate' | 'proposal',
    proposal: string | null,
    signers: readonly string[],
  ) => {
    state.history = [
      {
        signature: `${String(counter).padStart(4, '1')}${'2'.repeat(84)}`,
        slot: 507_200_000 + counter,
        blockTime: NOW,
        previousKey: state.delegation.key,
        previousMask: state.delegation.mask,
        operationalKey: key,
        mask,
        path,
        proposal,
        signers: [...signers],
      },
      ...state.history,
    ]
    state.delegation = { key, mask }
  }

  const refuse = (message: string): never => {
    throw new ApiRequestError('INVALID_INPUT', message, `stand-${counter}`)
  }

  const routes = (method: string, path: string, body: unknown): unknown => {
    const url = new URL(path, 'http://stand')
    // As the real route does: a named signer narrows, otherwise the session's wallet.
    const signer = url.searchParams.get('signer') ?? wallet()
    const parts = url.pathname.split('/').filter(Boolean) // ['api', ...]

    if (method === 'GET' && url.pathname === '/api/tokens') return { tokens: [token()] }
    if (method === 'GET' && parts[3] === 'compliance') {
      return {
        mint: MINT,
        decimals: 6,
        supply: state.supply.toString(),
        paused: state.paused,
        frozen: { amount: frozenTotal().toString(), accounts: state.freezes },
        seized: { vault: VAULT, amount: state.seized.toString() },
        free: (state.supply - frozenTotal() - state.seized).toString(),
      }
    }
    if (method === 'GET' && parts[1] === 'tokens' && parts[3] === 'actions') {
      return { proposals: state.proposals.filter((p) => p.mint !== null) }
    }
    if (method === 'GET' && url.pathname === '/api/issuer/delegation') {
      return {
        operationalKey: state.delegation.key,
        mask: state.delegation.mask,
        powers: powerNames(state.delegation.mask),
        platformKey: PLATFORM,
        proposals: state.proposals.filter((p) => p.mint === null),
        history: state.history,
      }
    }
    if (method === 'POST' && url.pathname === '/api/issuer/delegation/revoke') {
      const { powers } = body as { powers: PowerName[] }
      const removed = powers.reduce((bits, power) => bits | DELEGATION[power], 0)
      if ((state.delegation.mask & removed) !== removed) {
        refuse('the operational key does not hold these powers')
      }
      const mask = state.delegation.mask & ~removed
      return {
        signer,
        mask,
        blockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq2h',
        transaction: tx(signer, 'set-delegation', () => {
          record(state.delegation.key, mask, 'immediate', null, [signer])
        }),
      }
    }
    if (method === 'POST' && url.pathname === '/api/issuer/delegation/proposals') {
      const input = body as { operationalKey: string; mask: number; termSeconds: number }
      if (state.proposals.some((p) => p.address === GRANT)) {
        refuse('the stand holds one delegation proposal at most — reload to start over')
      }
      const from = { ...state.delegation }
      return {
        proposal: GRANT,
        signer,
        nonce: String(counter + 1),
        blockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq2h',
        transaction: tx(signer, 'propose-action', () => {
          state.proposals = [
            restate({
              address: GRANT,
              mint: null,
              nonce: String(counter),
              payer: signer,
              action: {
                kind: 'set-delegation',
                previousKey: from.key,
                previousMask: from.mask,
                operationalKey: input.operationalKey,
                mask: input.mask,
              },
              approvals: [signer],
              state: 'open',
              required: 2,
              counted: 1,
              lapsed: [],
              createdAt: NOW,
              expiresAt: NOW + input.termSeconds,
              executedAt: null,
            }),
            ...state.proposals,
          ]
        }),
      }
    }
    if (method === 'GET' && parts[1] === 'actions') {
      const found = state.proposals.find((p) => p.address === parts[2])
      if (found === undefined) throw new ApiRequestError('NOT_FOUND', 'no such proposal', 'stand')
      const shown =
        found.action.kind === 'set-delegation'
          ? {
              kind: found.action.kind,
              operationalKey: found.action.operationalKey,
              mask: found.action.mask,
            }
          : found.action
      return { proposal: found, body: shown, authorising: AUTHORISING }
    }

    if (method === 'POST' && parts[3] === 'freezes' && parts[5] === undefined) {
      const input = body as {
        wallet?: string
        tokenAccount?: string
        reason: { code: number; caseRef: string }
      }
      const account = input.tokenAccount ?? OTHER_ACCOUNT
      if (state.freezes.some((f) => f.tokenAccount === account)) {
        refuse('an officer has already frozen this account')
      }
      return {
        tokenAccount: account,
        signer,
        blockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq2h',
        transaction: tx(signer, 'freeze-holder', () => {
          state.freezes = [
            {
              tokenAccount: account,
              wallet: input.wallet ?? OTHER,
              officer: signer,
              payer: signer,
              reason: input.reason,
              frozenAt: NOW,
              wasThawed: true,
              amount: '42500000000',
            },
            ...state.freezes,
          ]
        }),
      }
    }
    if (method === 'POST' && parts[5] === 'unfreeze') {
      const account = parts[4]
      return {
        tokenAccount: account,
        signer,
        blockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq2h',
        transaction: tx(signer, 'unfreeze-holder', () => {
          state.freezes = state.freezes.filter((f) => f.tokenAccount !== account)
        }),
      }
    }

    if (method === 'POST' && parts[1] === 'tokens' && parts[3] === 'actions') {
      const input = body as { action: ProposalResponse['action']; termSeconds: number }
      const address = [PROPOSAL, 'SysvarRewards111111111111111111111111111111'][
        state.proposals.length % 2
      ] as string
      if (state.proposals.some((p) => p.address === address)) {
        refuse('the stand holds two proposals at most — reload to start over')
      }
      return {
        proposal: address,
        signer,
        nonce: String(counter + 1),
        blockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq2h',
        transaction: tx(signer, 'propose-action', () => {
          state.proposals = [
            restate({
              address,
              mint: MINT,
              nonce: String(counter),
              payer: signer,
              action: input.action,
              approvals: [signer],
              state: 'open',
              required: 2,
              counted: 1,
              lapsed: [],
              createdAt: NOW,
              expiresAt: NOW + input.termSeconds,
              executedAt: null,
            }),
            ...state.proposals,
          ]
        }),
      }
    }

    if (method === 'POST' && parts[1] === 'actions') {
      const id = parts[2]
      const verb = parts[3]
      const found = state.proposals.find((p) => p.address === id)
      if (found === undefined) throw new ApiRequestError('NOT_FOUND', 'no such proposal', 'stand')
      const update = (change: (p: ProposalResponse) => ProposalResponse | undefined) => {
        state.proposals = state.proposals.flatMap((p) => {
          if (p.address !== id) return [p]
          const next = change(p)
          return next === undefined ? [] : [restate(next)]
        })
      }
      const apply =
        verb === 'approve'
          ? () => update((p) => ({ ...p, approvals: [...p.approvals, signer] }))
          : verb === 'execute'
            ? () => {
                const action = found.action
                if (action.kind === 'set-delegation') {
                  if (
                    state.delegation.key !== action.previousKey ||
                    state.delegation.mask !== action.previousMask
                  ) {
                    throw new Error('the delegation has changed since this proposal was raised')
                  }
                  record(
                    action.operationalKey,
                    action.mask,
                    'proposal',
                    found.address,
                    found.approvals,
                  )
                }
                if (action.kind === 'pause') state.paused = true
                if (action.kind === 'resume') state.paused = false
                if (action.kind === 'seize') {
                  state.seized += BigInt(action.amount)
                  state.freezes = state.freezes.map((f) =>
                    f.tokenAccount === action.tokenAccount
                      ? { ...f, amount: (BigInt(f.amount) - BigInt(action.amount)).toString() }
                      : f,
                  )
                }
                update((p) => ({ ...p, executedAt: NOW }))
              }
            : () => update(() => undefined)
      return {
        proposal: id,
        signer,
        blockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq2h',
        transaction: tx(signer, stepOf(verb, found.action.kind), apply),
      }
    }

    throw new ApiRequestError('NOT_FOUND', `the stand does not serve ${method} ${path}`, 'stand')
  }

  const respond = async <T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown) => {
    await delay(250)
    const parsed = schema.safeParse(routes(method, path, body))
    if (!parsed.success) {
      throw new ApiRequestError('INTERNAL', 'the stand answered outside the contract', 'stand', {
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      })
    }
    return parsed.data
  }

  const api: ApiClient = {
    get: (path, schema) => respond('GET', path, schema),
    post: (path, body, schema) => respond('POST', path, schema, body),
  }

  const submitter: Submitter = {
    async submit(transaction, onPhase) {
      const apply = pending.get(transaction.base64)
      if (apply === undefined) throw new Error('the stand has no such transaction')
      onPhase('signing')
      await delay(400)
      onPhase('sending')
      await delay(300)
      onPhase('confirming')
      await delay(500)
      pending.delete(transaction.base64)
      apply()
      return `stand${'1'.repeat(80)}${counter}`
    },
  }

  return { api, submitter }
}

/** The builder step each verb assembles — the contract allows nothing else. */
function stepOf(verb: string | undefined, kind: ProposalResponse['action']['kind']): string {
  if (verb === 'approve') return 'approve-action'
  if (verb === 'close') return 'close-action-proposal'
  if (kind === 'set-delegation') return 'set-delegation'
  return kind === 'seize'
    ? 'seize'
    : kind === 'pause'
      ? 'pause-circulation'
      : kind === 'resume'
        ? 'resume-circulation'
        : 'set-policy'
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
