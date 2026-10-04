import {
  createForgeProgram,
  delegationProposalPda,
  fromBase64,
  issuerConfigPda,
} from '@forge/chain'
import { DELEGATION, ROLE } from '@forge/shared/api'
import { createLogger } from '@forge/shared/log'
import { Connection, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import type { ActionReader, ProposalView, QuorumView } from '../actions.ts'
import type { ChainReader, IssuerConfigView } from '../chain.ts'
import type { ComplianceReader } from '../compliance.ts'
import type { DelegationChangeRow } from '../delegation.ts'
import type { Directory, RosterEntry } from '../directory.ts'
import type { HolderStore } from '../holders.ts'
import type { IssuanceStore } from '../issuance.ts'
import type { JournalStore } from '../journal.ts'
import type { OperationalSigner } from '../operational.ts'
import type { PrivyClient } from '../privy.ts'
import { createServer } from '../server.ts'

const ISSUER = '11111111111111111111111111111112'
const ADMIN = 'SysvarC1ock11111111111111111111111111111111'
const OFFICER = 'SysvarS1otHashes111111111111111111111111111'
const WATCHER = 'SysvarRent111111111111111111111111111111111'
const PLATFORM = 'SysvarRecentB1ockHashes11111111111111111111'
const SUCCESSOR = 'SysvarS1otHistory11111111111111111111111111'
const MINT = 'So11111111111111111111111111111111111111112'
const BLOCKHASH = 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq2h'
const SYNCED_AT = '2026-10-04T10:00:00.000Z'
const NOW = new Date('2026-10-04T12:00:00.000Z')
const NOW_S = Math.floor(NOW.getTime() / 1000)
const NONCE = 0xfeed_f00dn
const OWN_CONFIG = issuerConfigPda(new PublicKey(ISSUER)).toBase58()
const PROPOSAL = delegationProposalPda(new PublicKey(ISSUER), NONCE).toBase58()
const BOTH = DELEGATION.THAW_HOLDER | DELEGATION.SET_HOLDER_STATUS

const program = createForgeProgram(new Connection('http://127.0.0.1:8899'))

const unused = <T extends object>(name: string) =>
  new Proxy({} as T, {
    get: (_, key) => () => {
      throw new Error(`${name} is not read on this path (${String(key)})`)
    },
  })

const grant = (over: Partial<ProposalView> = {}): ProposalView => ({
  address: PROPOSAL,
  mint: null,
  issuerConfig: OWN_CONFIG,
  payer: OFFICER,
  nonce: NONCE,
  action: {
    kind: 'set-delegation',
    previousKey: PLATFORM,
    previousMask: 0,
    operationalKey: PLATFORM,
    mask: BOTH,
  },
  approvals: [OFFICER, ADMIN],
  createdAt: NOW_S - 3_600,
  expiresAt: NOW_S + 86_400,
  executedAt: null,
  ...over,
})

const HISTORY: DelegationChangeRow = {
  signature: '5'.repeat(88),
  slot: 507_200_000,
  blockTime: NOW_S - 600,
  previousKey: PLATFORM,
  previousMask: BOTH,
  operationalKey: PLATFORM,
  mask: 0,
  path: 'immediate',
  proposal: null,
  signers: [ADMIN],
}

type Fakes = {
  wallets?: string[]
  roles?: number
  config?: IssuerConfigView | undefined
  quorum?: QuorumView
  proposals?: ProposalView[]
  proposal?: ProposalView | undefined
}

function app(fakes: Fakes = {}) {
  const wallets = fakes.wallets ?? [ADMIN]
  const roster: RosterEntry[] = (
    [
      [ADMIN, ROLE.ADMIN],
      [OFFICER, ROLE.COMPLIANCE],
      [WATCHER, ROLE.OBSERVER],
    ] as const
  ).map(([wallet, roles], memberIndex) => ({ wallet, roles, memberIndex }))

  const actions: ActionReader = {
    token: async () => ({ issuerConfig: OWN_CONFIG, policyVersion: 1 }),
    quorum: async () =>
      fakes.quorum ?? {
        quorumN: 2,
        members: roster.map(({ wallet, roles }) => ({ wallet, roles })),
      },
    proposals: async () => fakes.proposals ?? [],
    proposal: async () => ('proposal' in fakes ? fakes.proposal : grant()),
    body: async () => undefined,
  }

  const chain: ChainReader = {
    program,
    tokenCount: async () => 1,
    issuerConfig: async () =>
      'config' in fakes
        ? fakes.config
        : { tokenCount: 1, operationalKey: PLATFORM, delegationMask: BOTH },
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
    compliance: unused<ComplianceReader>('the compliance reader'),
    delegations: { history: async () => [HISTORY] },
    issuance: unused<IssuanceStore>('issuance'),
    holders: unused<HolderStore>('the holder store'),
    journal: unused<JournalStore>('the journal'),
    // Only its address is read: the routes never let it sign or pay.
    operational: { publicKey: new PublicKey(PLATFORM) } as OperationalSigner,
  })
}

const headers = { authorization: 'Bearer token', 'content-type': 'application/json' }
const get = (fakes: Fakes, path: string) => app(fakes).request(path, { headers })
const post = (fakes: Fakes, path: string, json?: unknown) =>
  app(fakes).request(path, { method: 'POST', headers, body: JSON.stringify(json ?? {}) })

type Json = Record<string, never>
const jsonOf = async (response: Response) => (await response.json()) as Json
const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; message: string } }).error

type TxJson = { base64: string; signers: string[]; step: string }

/** The one instruction: its decoded args and its accounts with their signer flags. */
function instructionOf(transaction: TxJson) {
  const message = fromBase64(transaction.base64).message
  const keys = message.getAccountKeys()
  const [instruction, ...rest] = message.compiledInstructions
  if (instruction === undefined || rest.length > 0) throw new Error('expected one instruction')
  // The program's coder is Borsh underneath; its interface type only names `encode`.
  const coder = program.coder.instruction as unknown as {
    decode(data: Buffer): { name: string; data: unknown } | null
  }
  const decoded = coder.decode(Buffer.from(instruction.data))
  if (decoded === null) throw new Error('not an instruction of our program')
  return {
    name: decoded.name,
    args: (decoded.data as { args: { operationalKey: PublicKey; mask: number } }).args,
    accounts: instruction.accountKeyIndexes.map((index) => ({
      key: keys.get(index)?.toBase58(),
      signer: message.isAccountSigner(index),
    })),
  }
}

describe('reading the delegation', () => {
  it('reads the key and its powers from the chain, the history from the indexer', async () => {
    const response = await get(
      { proposals: [grant()], roles: ROLE.OBSERVER, wallets: [WATCHER] },
      '/api/issuer/delegation',
    )
    expect(response.status).toBe(200)
    const body = await jsonOf(response)
    expect(body.operationalKey).toBe(PLATFORM)
    expect(body.mask).toBe(BOTH)
    expect(body.powers).toEqual(['THAW_HOLDER', 'SET_HOLDER_STATUS'])
    expect(body.platformKey).toBe(PLATFORM)
    expect(body.history).toEqual([HISTORY])
    const [proposal] = body.proposals as unknown as { mint: unknown; state: string }[]
    expect(proposal).toMatchObject({ mint: null, state: 'ready' })
  })

  it('an issuer not yet on chain is a 404', async () => {
    expect((await get({ config: undefined }, '/api/issuer/delegation')).status).toBe(404)
  })
})

describe('revoking (FR-035b): one admin, now', () => {
  it('takes one power away from the same key, signed by the admin alone', async () => {
    const response = await post({}, '/api/issuer/delegation/revoke', { powers: ['THAW_HOLDER'] })
    expect(response.status).toBe(200)
    const body = await jsonOf(response)
    expect(body.mask).toBe(DELEGATION.SET_HOLDER_STATUS)
    expect(body.signer).toBe(ADMIN)

    const transaction = body.transaction as unknown as TxJson
    expect(transaction.step).toBe('set-delegation')
    expect(transaction.signers).toEqual([ADMIN])
    const instruction = instructionOf(transaction)
    expect(instruction.name).toBe('setDelegation')
    expect(instruction.args.mask).toBe(DELEGATION.SET_HOLDER_STATUS)
    // The key is kept from the chain: a revocation never rotates.
    expect(instruction.args.operationalKey.toBase58()).toBe(PLATFORM)
    // Immediate path: no proposal, the admin named as a signing member.
    expect(instruction.accounts.at(-1)).toEqual({ key: ADMIN, signer: true })
    expect(instruction.accounts.some((account) => account.key === PLATFORM)).toBe(false)
  })

  it('revoking every held power leaves the key with nothing', async () => {
    const response = await post({}, '/api/issuer/delegation/revoke', {
      powers: ['THAW_HOLDER', 'SET_HOLDER_STATUS'],
    })
    expect((await jsonOf(response)).mask).toBe(0)
  })

  it('refuses an officer: narrowing is an admin’s, the program’s rule', async () => {
    const response = await post(
      { roles: ROLE.COMPLIANCE, wallets: [OFFICER] },
      '/api/issuer/delegation/revoke',
      { powers: ['THAW_HOLDER'] },
    )
    expect(response.status).toBe(401)
  })

  it('refuses an admin the chain no longer lists', async () => {
    const response = await post(
      { quorum: { quorumN: 2, members: [{ wallet: OFFICER, roles: ROLE.COMPLIANCE }] } },
      '/api/issuer/delegation/revoke',
      { powers: ['THAW_HOLDER'] },
    )
    expect(response.status).toBe(400)
  })

  it('a power the key does not hold is a stale screen, not a partial revocation', async () => {
    const response = await post(
      {
        config: { tokenCount: 1, operationalKey: PLATFORM, delegationMask: DELEGATION.THAW_HOLDER },
      },
      '/api/issuer/delegation/revoke',
      { powers: ['THAW_HOLDER', 'SET_HOLDER_STATUS'] },
    )
    expect(response.status).toBe(400)
    expect((await errorOf(response)).message).toMatch(/does not hold/)
  })

  it('names only powers that exist, and none twice', async () => {
    for (const powers of [[], ['MINT'], ['THAW_HOLDER', 'THAW_HOLDER']]) {
      expect((await post({}, '/api/issuer/delegation/revoke', { powers })).status).toBe(400)
    }
  })
})

describe('granting or rotating: a proposal', () => {
  const term = 2 * 86_400

  it('raises a rotation at the issuer’s own scope, the proposer paying', async () => {
    const response = await post(
      { roles: ROLE.COMPLIANCE, wallets: [OFFICER] },
      '/api/issuer/delegation/proposals',
      { operationalKey: SUCCESSOR, mask: BOTH, termSeconds: term },
    )
    expect(response.status).toBe(200)
    const body = await jsonOf(response)
    expect(body.proposal).toBe(PROPOSAL)
    expect(body.signer).toBe(OFFICER)
    const transaction = body.transaction as unknown as TxJson
    expect(transaction.step).toBe('propose-action')
    expect(transaction.signers).toEqual([OFFICER])
  })

  it('refuses the delegation as it already stands', async () => {
    const response = await post({}, '/api/issuer/delegation/proposals', {
      operationalKey: PLATFORM,
      mask: BOTH,
      termSeconds: term,
    })
    expect(response.status).toBe(400)
  })

  it('refuses a power outside the closed list', async () => {
    const response = await post({}, '/api/issuer/delegation/proposals', {
      operationalKey: PLATFORM,
      mask: 8,
      termSeconds: term,
    })
    expect(response.status).toBe(400)
  })

  it('an observer raises nothing', async () => {
    const response = await post(
      { roles: ROLE.OBSERVER, wallets: [WATCHER] },
      '/api/issuer/delegation/proposals',
      { operationalKey: SUCCESSOR, mask: BOTH, termSeconds: term },
    )
    expect(response.status).toBe(401)
  })
})

describe('a delegation proposal on the proposal page', () => {
  const lapsedMask = { tokenCount: 1, operationalKey: PLATFORM, delegationMask: 0 }

  it('is read with no mint and its whole body from the account', async () => {
    const response = await get({}, `/api/actions/${PROPOSAL}`)
    expect(response.status).toBe(200)
    const body = await jsonOf(response)
    expect((body.proposal as unknown as { mint: unknown }).mint).toBeNull()
    expect(body.body).toEqual({ kind: 'set-delegation', operationalKey: PLATFORM, mask: BOTH })
  })

  it('executes on the deferred path with the approvers named, unsigned', async () => {
    const response = await post({ config: lapsedMask }, `/api/actions/${PROPOSAL}/execute`)
    expect(response.status).toBe(200)
    const transaction = (await jsonOf(response)).transaction as unknown as TxJson
    expect(transaction.step).toBe('set-delegation')
    expect(transaction.signers).toEqual([ADMIN])
    const instruction = instructionOf(transaction)
    expect(instruction.args.mask).toBe(BOTH)
    expect(instruction.accounts.map((account) => account.key)).toContain(PROPOSAL)
    expect(instruction.accounts.slice(-2)).toEqual([
      { key: OFFICER, signer: false },
      { key: ADMIN, signer: true },
    ])
  })

  it('refuses once the delegation has moved off where it was raised', async () => {
    // Raised against "nothing delegated"; an admin has since changed it. The
    // program refuses with `DelegationChangedSinceProposal`; here, earlier.
    const response = await post(
      {
        config: { tokenCount: 1, operationalKey: PLATFORM, delegationMask: DELEGATION.THAW_HOLDER },
      },
      `/api/actions/${PROPOSAL}/execute`,
    )
    expect(response.status).toBe(400)
    expect((await errorOf(response)).message).toMatch(/changed since/)
  })

  it('stays out of a token’s list', async () => {
    const response = await get({ proposals: [] }, `/api/tokens/${MINT}/actions`)
    expect((await jsonOf(response)).proposals).toEqual([])
  })
})
