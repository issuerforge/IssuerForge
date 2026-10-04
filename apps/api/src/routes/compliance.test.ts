import { createForgeProgram, freezeRecordPda, fromBase64, issuerConfigPda } from '@forge/chain'
import { ROLE } from '@forge/shared/api'
import { createLogger } from '@forge/shared/log'
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { Connection, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import type { ActionReader, QuorumView } from '../actions.ts'
import type { ChainReader } from '../chain.ts'
import type {
  ComplianceReader,
  FreezeView,
  MintView,
  TokenAccountView,
  TokenListing,
} from '../compliance.ts'
import type { Directory, RosterEntry } from '../directory.ts'
import type { HolderStore } from '../holders.ts'
import type { IssuanceStore } from '../issuance.ts'
import type { JournalStore } from '../journal.ts'
import type { OperationalSigner } from '../operational.ts'
import type { PrivyClient } from '../privy.ts'
import { createServer } from '../server.ts'

const ISSUER = '11111111111111111111111111111112'
const OTHER_ISSUER = 'Stake11111111111111111111111111111111111111'
const ADMIN = 'SysvarC1ock11111111111111111111111111111111'
const OFFICER = 'SysvarS1otHashes111111111111111111111111111'
const WATCHER = 'SysvarRent111111111111111111111111111111111'
const MINT = 'So11111111111111111111111111111111111111112'
const OTHER_MINT = 'Vote111111111111111111111111111111111111111'
const HOLDER = 'SysvarRecentB1ockHashes11111111111111111111'
const DIRECT_ACCOUNT = 'SysvarS1otHistory11111111111111111111111111'
const VAULT = 'SysvarStakeHistory1111111111111111111111111'
const BLOCKHASH = 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq2h'
const SYNCED_AT = '2026-10-04T10:00:00.000Z'
const OWN_CONFIG = issuerConfigPda(new PublicKey(ISSUER)).toBase58()
const HOLDER_ACCOUNT = getAssociatedTokenAddressSync(
  new PublicKey(MINT),
  new PublicKey(HOLDER),
  true,
  TOKEN_2022_PROGRAM_ID,
).toBase58()

const REASON = { code: 4, caseRef: 'FIU-NG/2026/004117' }
/** Past 2^53: a `number` anywhere between the chain and the response would round it. */
const SUPPLY = 2n ** 60n

const unused = <T extends object>(name: string) =>
  new Proxy({} as T, {
    get: (_, key) => () => {
      throw new Error(`${name} is not read on this path (${String(key)})`)
    },
  })

const mintView = (over: Partial<MintView> = {}): MintView => ({
  mint: MINT,
  decimals: 6,
  supply: SUPPLY,
  paused: false,
  name: 'Naira Demo',
  symbol: 'vNGN',
  ...over,
})

const freeze = (over: Partial<FreezeView> = {}): FreezeView => ({
  mint: MINT,
  tokenAccount: HOLDER_ACCOUNT,
  wallet: HOLDER,
  officer: OFFICER,
  payer: OFFICER,
  reason: REASON,
  frozenAt: 1_790_000_000,
  wasThawed: true,
  amount: 100n,
  ...over,
})

const account = (over: Partial<TokenAccountView> = {}): TokenAccountView => ({
  address: HOLDER_ACCOUNT,
  mint: MINT,
  owner: HOLDER,
  amount: 100n,
  frozen: false,
  ...over,
})

type Fakes = {
  wallets?: string[]
  roles?: number
  quorum?: QuorumView
  tokenOwner?: string | undefined
  tokens?: TokenListing[] | undefined
  freezes?: FreezeView[]
  /** By token account; absent — no record. */
  records?: Record<string, FreezeView>
  accounts?: Record<string, TokenAccountView>
  seized?: bigint
}

function app(fakes: Fakes = {}) {
  const wallets = fakes.wallets ?? [OFFICER]
  const roster: RosterEntry[] = (
    [
      [ADMIN, ROLE.ADMIN],
      [OFFICER, ROLE.COMPLIANCE],
      [WATCHER, ROLE.OBSERVER],
    ] as const
  ).map(([wallet, roles], memberIndex) => ({ wallet, roles, memberIndex }))

  const actions: ActionReader = {
    token: async () => {
      const owner = 'tokenOwner' in fakes ? fakes.tokenOwner : OWN_CONFIG
      return owner === undefined ? undefined : { issuerConfig: owner, policyVersion: 1 }
    },
    quorum: async () =>
      fakes.quorum ?? {
        quorumN: 2,
        members: roster.map(({ wallet, roles }) => ({ wallet, roles })),
      },
    proposals: async () => [],
    proposal: async () => undefined,
    body: async () => undefined,
  }

  const compliance: ComplianceReader = {
    tokens: async () =>
      'tokens' in fakes
        ? fakes.tokens
        : [{ ...mintView(), index: 0, policyVersion: 1, pausedAt: null }],
    mint: async () => mintView(),
    freezes: async () => fakes.freezes ?? [],
    freeze: async (tokenAccount) => fakes.records?.[tokenAccount.toBase58()],
    tokenAccount: async (address) =>
      (fakes.accounts ?? { [HOLDER_ACCOUNT]: account() })[address.toBase58()],
    seized: async () => ({ vault: VAULT, amount: fakes.seized ?? 0n }),
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
      { issuerId: ISSUER, roles: fakes.roles ?? ROLE.COMPLIANCE, wallets, syncedAt: SYNCED_AT },
    ],
    rosterFor: async () => roster,
  }

  return createServer({
    logger: createLogger({ level: 'silent', service: 'test' }),
    webOrigins: ['https://console.example'],
    requestId: () => 'req-fixed',
    privy,
    directory,
    chain,
    actions,
    compliance,
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
  ((await response.json()) as { error: { code: string; message: string } }).error

type TxJson = { base64: string; signers: string[]; step: string }

/** The accounts of the one instruction in an assembled transaction. */
function accountsOf(transaction: TxJson): (string | undefined)[] {
  const message = fromBase64(transaction.base64).message
  const keys = message.getAccountKeys()
  const [instruction, ...rest] = message.compiledInstructions
  if (instruction === undefined || rest.length > 0) throw new Error('expected one instruction')
  return instruction.accountKeyIndexes.map((index) => keys.get(index)?.toBase58())
}

describe('the issuer’s tokens', () => {
  it('lists them from the chain, the supply as a u64 string', async () => {
    const response = await get({ roles: ROLE.OBSERVER, wallets: [WATCHER] }, '/api/tokens')
    expect(response.status).toBe(200)
    expect((await jsonOf(response)).tokens).toEqual([
      {
        mint: MINT,
        index: 0,
        decimals: 6,
        supply: SUPPLY.toString(),
        paused: false,
        pausedAt: null,
        name: 'Naira Demo',
        symbol: 'vNGN',
        policyVersion: 1,
      },
    ])
  })

  it('an issuer not yet on chain is a 404, not an empty list', async () => {
    // "No tokens" and "no issuer" are different answers: the first invites
    // the wizard, the second says the issuer's own creation has not landed.
    const response = await get({ tokens: undefined }, '/api/tokens')
    expect(response.status).toBe(404)
  })
})

describe('a token’s compliance totals (FR-020)', () => {
  it('keeps frozen and seized apart from what is free', async () => {
    const second = freeze({ tokenAccount: DIRECT_ACCOUNT, amount: 50n, wasThawed: false })
    const response = await get(
      { roles: ROLE.OBSERVER, wallets: [WATCHER], freezes: [freeze(), second], seized: 200n },
      `/api/tokens/${MINT}/compliance`,
    )
    expect(response.status).toBe(200)

    const body = await jsonOf(response)
    expect(body.supply).toBe(SUPPLY.toString())
    expect(body.frozen).toMatchObject({ amount: '150' })
    expect((body.frozen as unknown as { accounts: unknown[] }).accounts).toHaveLength(2)
    expect(body.seized).toEqual({ vault: VAULT, amount: '200' })
    expect(body.free).toBe((SUPPLY - 350n).toString())
  })

  it('another issuer’s token does not exist for this session', async () => {
    const response = await get(
      { tokenOwner: issuerConfigPda(new PublicKey(OTHER_ISSUER)).toBase58() },
      `/api/tokens/${MINT}/compliance`,
    )
    expect(response.status).toBe(404)
  })

  it('a read that adds up to more than the supply is an error, not a huge number', async () => {
    const response = await get({ seized: SUPPLY + 1n }, `/api/tokens/${MINT}/compliance`)
    expect(response.status).toBe(500)
  })
})

describe('freezing an account (FR-014)', () => {
  it('names the wallet’s associated account and returns a transaction for the officer alone', async () => {
    const response = await post({}, `/api/tokens/${MINT}/freezes`, {
      wallet: HOLDER,
      reason: REASON,
    })
    expect(response.status).toBe(200)

    const body = await jsonOf(response)
    expect(body.tokenAccount).toBe(HOLDER_ACCOUNT)
    expect(body.signer).toBe(OFFICER)

    const transaction = body.transaction as unknown as TxJson
    expect(transaction.step).toBe('freeze-holder')
    expect(transaction.signers).toEqual([OFFICER])
    const accounts = accountsOf(transaction)
    expect(accounts).toContain(HOLDER_ACCOUNT)
    expect(accounts).toContain(freezeRecordPda(new PublicKey(HOLDER_ACCOUNT)).toBase58())
  })

  it('takes a token account named directly', async () => {
    const response = await post(
      { accounts: { [DIRECT_ACCOUNT]: account({ address: DIRECT_ACCOUNT }) } },
      `/api/tokens/${MINT}/freezes`,
      { tokenAccount: DIRECT_ACCOUNT, reason: REASON },
    )
    expect(response.status).toBe(200)
    expect((await jsonOf(response)).tokenAccount).toBe(DIRECT_ACCOUNT)
  })

  it('refuses an admin: a freeze is the officer’s, the program’s rule', async () => {
    const response = await post(
      { roles: ROLE.ADMIN, wallets: [ADMIN] },
      `/api/tokens/${MINT}/freezes`,
      {
        wallet: HOLDER,
        reason: REASON,
      },
    )
    expect(response.status).toBe(401)
  })

  it('refuses an officer the chain no longer lists, before anyone signs', async () => {
    const response = await post(
      { quorum: { quorumN: 2, members: [{ wallet: ADMIN, roles: ROLE.ADMIN }] } },
      `/api/tokens/${MINT}/freezes`,
      { wallet: HOLDER, reason: REASON },
    )
    expect(response.status).toBe(400)
    expect((await errorOf(response)).message).toMatch(/not a compliance officer on chain/)
  })

  it('without a reason nothing is assembled (FR-017)', async () => {
    for (const reason of [undefined, { code: 0, caseRef: 'X' }, { code: 4, caseRef: '' }]) {
      const response = await post({}, `/api/tokens/${MINT}/freezes`, { wallet: HOLDER, reason })
      expect(response.status).toBe(400)
    }
  })

  it('a wallet and an account together is not a request', async () => {
    const response = await post({}, `/api/tokens/${MINT}/freezes`, {
      wallet: HOLDER,
      tokenAccount: DIRECT_ACCOUNT,
      reason: REASON,
    })
    expect(response.status).toBe(400)
  })

  it('refuses an account of another mint, and a wallet with no account', async () => {
    const foreign = await post(
      { accounts: { [DIRECT_ACCOUNT]: account({ address: DIRECT_ACCOUNT, mint: OTHER_MINT }) } },
      `/api/tokens/${MINT}/freezes`,
      { tokenAccount: DIRECT_ACCOUNT, reason: REASON },
    )
    expect(foreign.status).toBe(400)

    const missing = await post({ accounts: {} }, `/api/tokens/${MINT}/freezes`, {
      wallet: HOLDER,
      reason: REASON,
    })
    expect(missing.status).toBe(400)
    expect((await errorOf(missing)).message).toMatch(/no account for this token/)
  })

  it('refuses a second freeze of the same account', async () => {
    const response = await post(
      { records: { [HOLDER_ACCOUNT]: freeze() } },
      `/api/tokens/${MINT}/freezes`,
      { wallet: HOLDER, reason: REASON },
    )
    expect(response.status).toBe(400)
    expect((await errorOf(response)).message).toMatch(/already frozen/)
  })
})

describe('lifting a freeze', () => {
  const lifted = { code: 9, caseRef: 'FIU-NG/2026/004117/closed' }

  it('returns the rent to whoever paid it, signed by any officer', async () => {
    const response = await post(
      { records: { [HOLDER_ACCOUNT]: freeze({ payer: ADMIN }) } },
      `/api/tokens/${MINT}/freezes/${HOLDER_ACCOUNT}/unfreeze`,
      { reason: lifted },
    )
    expect(response.status).toBe(200)

    const transaction = (await jsonOf(response)).transaction as unknown as TxJson
    expect(transaction.step).toBe('unfreeze-holder')
    expect(transaction.signers).toEqual([OFFICER])
    expect(accountsOf(transaction)).toContain(ADMIN)
  })

  it('no freeze, or a freeze of another mint, is a 404', async () => {
    const none = await post({}, `/api/tokens/${MINT}/freezes/${HOLDER_ACCOUNT}/unfreeze`, {
      reason: lifted,
    })
    expect(none.status).toBe(404)

    const foreign = await post(
      { records: { [HOLDER_ACCOUNT]: freeze({ mint: OTHER_MINT }) } },
      `/api/tokens/${MINT}/freezes/${HOLDER_ACCOUNT}/unfreeze`,
      { reason: lifted },
    )
    expect(foreign.status).toBe(404)
  })

  it('a lifting without its own reason is refused', async () => {
    const response = await post(
      { records: { [HOLDER_ACCOUNT]: freeze() } },
      `/api/tokens/${MINT}/freezes/${HOLDER_ACCOUNT}/unfreeze`,
      {},
    )
    expect(response.status).toBe(400)
  })
})
