import {
  actionProposalPda,
  createForgeProgram,
  decodeProposedAction,
  fromBase64,
  issuerConfigPda,
} from '@forge/chain'
import { encodeRules, rulesHash, toHex } from '@forge/policy/layout'
import { OPEN_POLICY, type PolicyRules } from '@forge/policy/model'
import { ROLE } from '@forge/shared/api'
import { createLogger } from '@forge/shared/log'
import { Connection, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import type { ActionReader, ProposalView, QuorumView, TokenView } from '../actions.ts'
import type { ChainReader } from '../chain.ts'
import type { ComplianceReader } from '../compliance.ts'
import type { Directory, RosterEntry } from '../directory.ts'
import type { HolderStore } from '../holders.ts'
import type { IssuanceStore } from '../issuance.ts'
import type { JournalStore } from '../journal.ts'
import type { OperationalSigner } from '../operational.ts'
import type { PrivyClient } from '../privy.ts'
import { createServer } from '../server.ts'

/** These routes never read the officer's totals; the reader is here only because the server requires one. */
const noCompliance: ComplianceReader = {
  tokens: async () => undefined,
  mint: async () => undefined,
  freezes: async () => [],
  freeze: async () => undefined,
  tokenAccount: async () => undefined,
  seized: async () => ({ vault: '11111111111111111111111111111111', amount: 0n }),
}

const ISSUER = '11111111111111111111111111111112'
const OTHER_ISSUER = 'Stake11111111111111111111111111111111111111'
const ADMIN = 'SysvarC1ock11111111111111111111111111111111'
const OFFICER = 'SysvarS1otHashes111111111111111111111111111'
const WATCHER = 'SysvarRent111111111111111111111111111111111'
const MINT = 'So11111111111111111111111111111111111111112'
const BLOCKHASH = 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq2h'
const SYNCED_AT = '2026-09-27T10:00:00.000Z'
const NOW = new Date('2026-09-27T12:00:00.000Z')
const NOW_S = Math.floor(NOW.getTime() / 1000)
const NONCE = 0xdead_beefn
const PROPOSAL = actionProposalPda(new PublicKey(MINT), NONCE).toBase58()
const OWN_CONFIG = issuerConfigPda(new PublicKey(ISSUER)).toBase58()

const STRICT: PolicyRules = { ...OPEN_POLICY, status: { ...OPEN_POLICY.status, minTier: 2 } }

const unused = <T extends object>(name: string) =>
  new Proxy({} as T, {
    get: (_, key) => () => {
      throw new Error(`${name} is not read on this path (${String(key)})`)
    },
  })

const POLICY_REASON = { code: 12, caseRef: 'POLICY/2026/0007' }

const proposal = (over: Partial<ProposalView> = {}): ProposalView => ({
  address: PROPOSAL,
  mint: MINT,
  issuerConfig: OWN_CONFIG,
  payer: ADMIN,
  nonce: NONCE,
  action: {
    kind: 'set-policy',
    version: 2,
    rulesHash: toHex(rulesHash(STRICT)),
    reason: POLICY_REASON,
  },
  approvals: [ADMIN],
  createdAt: NOW_S - 3_600,
  expiresAt: NOW_S + 86_400,
  executedAt: null,
  ...over,
})

type Fakes = {
  wallets?: string[]
  roles?: number
  roster?: readonly (readonly [string, number])[]
  token?: TokenView | undefined
  quorum?: QuorumView
  proposal?: ProposalView | undefined
  body?: PolicyRules | undefined
}

function app(fakes: Fakes = {}) {
  const wallets = fakes.wallets ?? [ADMIN]
  const rosterEntries = fakes.roster ?? [
    [ADMIN, ROLE.ADMIN],
    [OFFICER, ROLE.COMPLIANCE],
    [WATCHER, ROLE.OBSERVER],
  ]
  const roster: RosterEntry[] = rosterEntries.map(([wallet, roles], memberIndex) => ({
    wallet,
    roles,
    memberIndex,
  }))

  const actions: ActionReader = {
    token: async () =>
      'token' in fakes ? fakes.token : { issuerConfig: OWN_CONFIG, policyVersion: 1 },
    quorum: async () =>
      fakes.quorum ?? {
        quorumN: 2,
        members: roster.map(({ wallet, roles }) => ({ wallet, roles })),
      },
    proposals: async () => (fakes.proposal === undefined ? [] : [fakes.proposal]),
    proposal: async (address) =>
      'proposal' in fakes
        ? fakes.proposal
        : address.toBase58() === PROPOSAL
          ? proposal()
          : undefined,
    body: async (view) => {
      if (view.action.kind === 'seize') {
        return { ...view.action, tokenAccount: new PublicKey(view.action.tokenAccount) }
      }
      if (view.action.kind === 'pause' || view.action.kind === 'resume') {
        return { kind: view.action.kind, reason: view.action.reason }
      }
      if (view.action.kind === 'set-delegation') return undefined
      const policy = 'body' in fakes ? fakes.body : STRICT
      return policy === undefined
        ? undefined
        : { kind: 'set-policy', version: view.action.version, policy, reason: view.action.reason }
    },
  }

  const chain: ChainReader = {
    program: createForgeProgram(new Connection('http://127.0.0.1:8899')),
    tokenCount: async () => 1,
    issuerConfig: async () => undefined,
    holderStatusWritten: async () => false,
    latestBlockhash: async () => BLOCKHASH,
  }

  const privy: PrivyClient = { authenticate: async () => ({ userId: 'did:privy:test', wallets }) }
  const directory: Directory = {
    membershipsFor: async () => [
      { issuerId: ISSUER, roles: fakes.roles ?? ROLE.ADMIN, wallets, syncedAt: SYNCED_AT },
    ],
    rosterFor: async () => roster,
  }

  return createServer({
    logger: createLogger({ level: 'silent', service: 'test' }),
    webOrigins: ['https://console.example'],
    requestId: () => 'req-fixed',
    now: () => NOW,
    nonce: () => NONCE,
    privy,
    directory,
    chain,
    actions,
    compliance: noCompliance,
    delegations: { history: async () => [] },
    issuance: unused<IssuanceStore>('issuance'),
    holders: unused<HolderStore>('the holder store'),
    journal: unused<JournalStore>('the journal'),
    operational: unused<OperationalSigner>('the operational key'),
  })
}

const headers = { authorization: 'Bearer token', 'content-type': 'application/json' }

const get = (fakes: Fakes, path: string) => app(fakes).request(path, { headers })

const post = (fakes: Fakes, path: string, json?: unknown) =>
  app(fakes).request(path, { method: 'POST', headers, body: JSON.stringify(json ?? {}) })

type Json = Record<string, never>
const jsonOf = async (response: Response) => (await response.json()) as Json

const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; message: string; details?: Json } }).error

type TxJson = { base64: string; signers: string[]; step: string }

/** The one instruction of an assembled transaction, with its account keys resolved. */
function instructionOf(transaction: TxJson) {
  const message = fromBase64(transaction.base64).message
  const keys = message.getAccountKeys()
  const [instruction, ...rest] = message.compiledInstructions
  if (instruction === undefined || rest.length > 0) throw new Error('expected one instruction')
  return {
    data: instruction.data,
    accounts: instruction.accountKeyIndexes.map((index) => keys.get(index)?.toBase58()),
  }
}

const proposeBody = {
  action: { kind: 'set-policy', policy: STRICT, reason: POLICY_REASON },
  termSeconds: 3 * 86_400,
}

/** The account the order names; any address the tests do not otherwise use. */
const SUSPECT_ACCOUNT = 'SysvarRecentB1ockHashes11111111111111111111'
const REASON = { code: 4, caseRef: 'FIU-NG/2026/004117' }
/** Past 2^53: a `number` anywhere between the body and the chain would round it. */
const SEIZED = 2n ** 60n + 7n

const seizeBody = (over: Record<string, unknown> = {}) => ({
  action: {
    kind: 'seize',
    tokenAccount: SUSPECT_ACCOUNT,
    amount: SEIZED.toString(),
    reason: REASON,
    ...over,
  },
  termSeconds: 3 * 86_400,
})

const seizure = (over: Partial<ProposalView> = {}) =>
  proposal({
    action: { kind: 'seize', tokenAccount: SUSPECT_ACCOUNT, amount: SEIZED, reason: REASON },
    ...over,
  })

const circulation = (kind: 'pause' | 'resume', over: Partial<ProposalView> = {}) =>
  proposal({ action: { kind, reason: REASON }, ...over })

describe('raising a proposal', () => {
  it('proposes the next version at the nonce the server chose, signed by the proposer alone', async () => {
    const response = await post({}, `/api/tokens/${MINT}/actions`, proposeBody)
    expect(response.status).toBe(200)

    const body = await jsonOf(response)
    expect(body.proposal).toBe(PROPOSAL)
    expect(body.nonce).toBe(NONCE.toString())
    expect(body.version).toBe(2)
    expect(body.signer).toBe(ADMIN)

    const transaction = body.transaction as unknown as TxJson
    expect(transaction.step).toBe('propose-action')
    expect(transaction.signers).toEqual([ADMIN])

    const decoded = decodeProposedAction(instructionOf(transaction).data)
    expect(decoded?.nonce).toBe(NONCE)
    if (decoded?.action.kind !== 'set-policy') throw new Error('expected a policy body')
    expect(decoded.action.version).toBe(2)
    expect(toHex(rulesHash(decoded.action.policy))).toBe(toHex(rulesHash(STRICT)))
    expect(decoded.action.reason).toEqual(POLICY_REASON)
  })

  it('a policy change without a reason is refused before anything is assembled', async () => {
    // FR-017 at the api boundary: the program would refuse it too, but only
    // after the proposer had signed and paid rent.
    const response = await post({}, `/api/tokens/${MINT}/actions`, {
      action: { kind: 'set-policy', policy: STRICT },
      termSeconds: 3 * 86_400,
    })
    expect(response.status).toBe(400)
  })

  it('an observer cannot raise one', async () => {
    const response = await post(
      { wallets: [WATCHER], roles: ROLE.OBSERVER },
      `/api/tokens/${MINT}/actions`,
      proposeBody,
    )
    expect(response.status).toBe(401)
  })

  it('a wallet the mirror still lists but the chain has dropped is refused before signing', async () => {
    const response = await post(
      { quorum: { quorumN: 2, members: [{ wallet: OFFICER, roles: ROLE.COMPLIANCE }] } },
      `/api/tokens/${MINT}/actions`,
      proposeBody,
    )
    expect(response.status).toBe(400)
    expect((await errorOf(response)).message).toMatch(/not an authorising member on chain/)
  })

  it('a term outside the program’s bounds is a 400', async () => {
    for (const termSeconds of [3_599, 30 * 86_400 + 1]) {
      const response = await post({}, `/api/tokens/${MINT}/actions`, {
        ...proposeBody,
        termSeconds,
      })
      expect(response.status).toBe(400)
    }
  })

  it('another issuer’s token does not exist for this session', async () => {
    const response = await post(
      {
        token: {
          issuerConfig: issuerConfigPda(new PublicKey(OTHER_ISSUER)).toBase58(),
          policyVersion: 1,
        },
      },
      `/api/tokens/${MINT}/actions`,
      proposeBody,
    )
    expect(response.status).toBe(404)
  })
})

describe('raising a seizure', () => {
  it('proposes the account, the exact amount and the reason, with no policy version', async () => {
    const response = await post({}, `/api/tokens/${MINT}/actions`, seizeBody())
    expect(response.status).toBe(200)

    const body = await jsonOf(response)
    expect(body.proposal).toBe(PROPOSAL)
    expect(body).not.toHaveProperty('version')

    const decoded = decodeProposedAction(instructionOf(body.transaction as unknown as TxJson).data)
    if (decoded?.action.kind !== 'seize') throw new Error('expected a seizure body')
    expect(decoded.action.tokenAccount.toBase58()).toBe(SUSPECT_ACCOUNT)
    expect(decoded.action.amount).toBe(SEIZED)
    expect(decoded.action.reason).toEqual(REASON)
  })

  it('refuses a seizure of nothing, without a reason code, or with a case the program would refuse', async () => {
    for (const over of [
      { amount: '0' },
      { amount: '1.5' },
      { reason: { ...REASON, code: 0 } },
      { reason: { ...REASON, caseRef: '' } },
      { reason: { ...REASON, caseRef: 'кейс-1' } },
      { reason: { ...REASON, caseRef: 'A'.repeat(33) } },
    ]) {
      const response = await post({}, `/api/tokens/${MINT}/actions`, seizeBody(over))
      expect(response.status, JSON.stringify(over)).toBe(400)
    }
  })
})

describe('raising a pause or its lifting', () => {
  it('proposes the direction and the reason, nothing else', async () => {
    for (const kind of ['pause', 'resume'] as const) {
      const response = await post({}, `/api/tokens/${MINT}/actions`, {
        action: { kind, reason: REASON },
        termSeconds: 86_400,
      })
      expect(response.status).toBe(200)
      const body = await jsonOf(response)
      expect(body).not.toHaveProperty('version')
      const decoded = decodeProposedAction(
        instructionOf(body.transaction as unknown as TxJson).data,
      )
      expect(decoded?.action).toEqual({ kind, reason: REASON })
    }
  })

  it('refuses one without a reason, or with a stray field', async () => {
    for (const action of [
      { kind: 'pause' },
      { kind: 'pause', reason: { ...REASON, code: 0 } },
      { kind: 'resume', reason: { ...REASON, caseRef: '' } },
      { kind: 'pause', reason: REASON, tokenAccount: SUSPECT_ACCOUNT },
    ]) {
      const response = await post({}, `/api/tokens/${MINT}/actions`, {
        action,
        termSeconds: 86_400,
      })
      expect(response.status, JSON.stringify(action)).toBe(400)
    }
  })

  it('is listed and read with its reason', async () => {
    const listed = await jsonOf(
      await get({ proposal: circulation('pause') }, `/api/tokens/${MINT}/actions`),
    )
    const [first] = listed.proposals as unknown as { action: unknown }[]
    expect(first?.action).toEqual({ kind: 'pause', reason: REASON })

    const one = await jsonOf(
      await get({ proposal: circulation('resume') }, `/api/actions/${PROPOSAL}`),
    )
    expect(one.body).toEqual({ kind: 'resume', reason: REASON })
  })
})

describe('reading proposals', () => {
  it('lists them with the approvers named and the standing computed', async () => {
    const response = await get({ proposal: proposal() }, `/api/tokens/${MINT}/actions`)
    const [listed] = (await jsonOf(response)).proposals as unknown as Json[]

    expect(listed).toMatchObject({
      address: PROPOSAL,
      approvals: [ADMIN],
      state: 'open',
      required: 2,
      counted: 1,
      nonce: NONCE.toString(),
      executedAt: null,
    })
  })

  it('one proposal comes with the body its approvers sign for', async () => {
    const body = await jsonOf(await get({}, `/api/actions/${PROPOSAL}`))
    const policy = (body.body as unknown as { policy: PolicyRules }).policy

    expect(Buffer.from(encodeRules(policy))).toEqual(Buffer.from(encodeRules(STRICT)))
  })

  it('names the members who could still approve, from the on-chain roster, observers left out', async () => {
    const body = await jsonOf(await get({}, `/api/actions/${PROPOSAL}`))
    expect(body.authorising).toEqual([
      { wallet: ADMIN, roles: ROLE.ADMIN },
      { wallet: OFFICER, roles: ROLE.COMPLIANCE },
    ])
  })

  it('a seizure is listed and read with its amount as a u64 string', async () => {
    const listed = await jsonOf(await get({ proposal: seizure() }, `/api/tokens/${MINT}/actions`))
    const [first] = listed.proposals as unknown as { action: unknown }[]
    const action = {
      kind: 'seize',
      tokenAccount: SUSPECT_ACCOUNT,
      amount: SEIZED.toString(),
      reason: REASON,
    }
    expect(first?.action).toEqual(action)

    const one = await jsonOf(await get({ proposal: seizure() }, `/api/actions/${PROPOSAL}`))
    expect(one.body).toEqual(action)
  })

  it('a body the node no longer has is an internal failure, not an empty policy', async () => {
    const response = await get({ body: undefined }, `/api/actions/${PROPOSAL}`)
    expect(response.status).toBe(500)
  })

  it('another issuer’s proposal does not exist for this session', async () => {
    const foreign = proposal({
      issuerConfig: issuerConfigPda(new PublicKey(OTHER_ISSUER)).toBase58(),
    })
    expect((await get({ proposal: foreign }, `/api/actions/${PROPOSAL}`)).status).toBe(404)
  })
})

describe('approving', () => {
  it('a second member approves with one signature, their own', async () => {
    const response = await post(
      { wallets: [OFFICER], roles: ROLE.COMPLIANCE },
      `/api/actions/${PROPOSAL}/approve`,
    )
    expect(response.status).toBe(200)

    const transaction = (await jsonOf(response)).transaction as unknown as TxJson
    expect(transaction.step).toBe('approve-action')
    expect(transaction.signers).toEqual([OFFICER])
    expect(instructionOf(transaction).accounts[1]).toBe(PROPOSAL)
  })

  it('the same wallet twice is refused before it is signed', async () => {
    const response = await post({}, `/api/actions/${PROPOSAL}/approve`)
    expect(response.status).toBe(400)
    expect((await errorOf(response)).message).toMatch(/already approved/)
  })

  it('a proposal past its term takes no more signatures', async () => {
    const response = await post(
      { wallets: [OFFICER], roles: ROLE.COMPLIANCE, proposal: proposal({ expiresAt: NOW_S - 1 }) },
      `/api/actions/${PROPOSAL}/approve`,
    )
    expect(response.status).toBe(400)
    expect((await errorOf(response)).details).toEqual({ state: 'expired' })
  })

  it('a blocked proposal is not offered a signature that cannot help', async () => {
    const response = await post(
      {
        wallets: [OFFICER],
        roles: ROLE.COMPLIANCE,
        proposal: proposal({ approvals: [WATCHER] }),
      },
      `/api/actions/${PROPOSAL}/approve`,
    )
    expect(response.status).toBe(400)
    expect((await errorOf(response)).details).toEqual({ lapsed: [WATCHER] })
  })
})

describe('executing', () => {
  const ready = proposal({ approvals: [ADMIN, OFFICER] })

  it('assembles set_policy on the deferred path: the proposal in its slot, only the payer signs', async () => {
    const response = await post({ proposal: ready }, `/api/actions/${PROPOSAL}/execute`)
    expect(response.status).toBe(200)

    const transaction = (await jsonOf(response)).transaction as unknown as TxJson
    const { data, accounts } = instructionOf(transaction)

    expect(transaction.step).toBe('set-policy')
    expect(transaction.signers).toEqual([ADMIN])
    expect(accounts[5]).toBe(PROPOSAL)
    // FR-019c: the approvers follow, in the proposal's order — the journal
    // names them from here once the proposal is closed.
    expect(accounts.slice(6)).toEqual([ADMIN, OFFICER])
    // The bytes the digest was computed over, and no other encoding of them.
    expect(Buffer.from(data).includes(Buffer.from(encodeRules(STRICT)))).toBe(true)
  })

  it('one approval of two is not executed, and the answer says how far it got', async () => {
    const response = await post({}, `/api/actions/${PROPOSAL}/execute`)
    expect(response.status).toBe(400)
    expect((await errorOf(response)).details).toMatchObject({
      state: 'open',
      required: 2,
      counted: 1,
    })
  })

  it('assembles seize with the approvers named after the accounts, only the payer signing', async () => {
    const response = await post(
      { proposal: seizure({ approvals: [OFFICER, ADMIN] }) },
      `/api/actions/${PROPOSAL}/execute`,
    )
    expect(response.status).toBe(200)

    const transaction = (await jsonOf(response)).transaction as unknown as TxJson
    const { accounts } = instructionOf(transaction)

    expect(transaction.step).toBe('seize')
    expect(transaction.signers).toEqual([ADMIN])
    expect(accounts[3]).toBe(SUSPECT_ACCOUNT)
    expect(accounts[5]).toBe(PROPOSAL)
    // FR-019c: the order is the proposal's, so the journal names them as the
    // program counted them. The payer is also the second approver here, and
    // still sits in its place.
    expect(accounts.slice(10)).toEqual([OFFICER, ADMIN])
  })

  it('assembles the pause or its lifting with the approvers named, only the payer signing', async () => {
    for (const [kind, step] of [
      ['pause', 'pause-circulation'],
      ['resume', 'resume-circulation'],
    ] as const) {
      const response = await post(
        { proposal: circulation(kind, { approvals: [OFFICER, ADMIN] }) },
        `/api/actions/${PROPOSAL}/execute`,
      )
      expect(response.status).toBe(200)

      const transaction = (await jsonOf(response)).transaction as unknown as TxJson
      const { accounts } = instructionOf(transaction)
      expect(transaction.step).toBe(step)
      expect(transaction.signers).toEqual([ADMIN])
      expect(accounts[2]).toBe(MINT)
      expect(accounts[3]).toBe(PROPOSAL)
      expect(accounts.slice(5)).toEqual([OFFICER, ADMIN])
    }
  })

  it('a pause one approval short is not executed', async () => {
    const response = await post(
      { proposal: circulation('pause') },
      `/api/actions/${PROPOSAL}/execute`,
    )
    expect(response.status).toBe(400)
    expect((await errorOf(response)).details).toMatchObject({ state: 'open' })
  })

  it('a seizure one approval short is not executed', async () => {
    const response = await post({ proposal: seizure() }, `/api/actions/${PROPOSAL}/execute`)
    expect(response.status).toBe(400)
    expect((await errorOf(response)).details).toMatchObject({ state: 'open' })
  })

  it('a proposal for a version that is no longer next can only lapse', async () => {
    const response = await post(
      { proposal: ready, token: { issuerConfig: OWN_CONFIG, policyVersion: 2 } },
      `/api/actions/${PROPOSAL}/execute`,
    )
    expect(response.status).toBe(400)
    expect((await errorOf(response)).details).toEqual({ proposed: 2, current: 2 })
  })
})

describe('closing', () => {
  it('a live proposal cannot be closed: revocation belongs to the clock', async () => {
    const response = await post({}, `/api/actions/${PROPOSAL}/close`)
    expect(response.status).toBe(400)
  })

  it('an expired one returns the rent to its payer, whoever closes it', async () => {
    const response = await post(
      { wallets: [OFFICER], roles: ROLE.COMPLIANCE, proposal: proposal({ expiresAt: NOW_S - 1 }) },
      `/api/actions/${PROPOSAL}/close`,
    )
    expect(response.status).toBe(200)

    const transaction = (await jsonOf(response)).transaction as unknown as TxJson
    expect(transaction.signers).toEqual([OFFICER])
    expect(instructionOf(transaction).accounts[2]).toBe(ADMIN)
  })
})
