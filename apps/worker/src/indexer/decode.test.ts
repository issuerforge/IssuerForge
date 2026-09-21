import { BN, BorshInstructionCoder } from '@coral-xyz/anchor'
import { IDL, PROGRAM_ID } from '@forge/chain'
import { encodeRules } from '@forge/policy/layout'
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { Keypair, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import {
  type Decoded,
  decodeTransaction,
  type Lookups,
  ruleSlotOf,
  type TokenView,
} from './decode.ts'
import type { InstructionView, TransactionView } from './transaction.ts'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const coder = new BorshInstructionCoder(IDL)
const PROGRAM = PROGRAM_ID.toBase58()
const TOKEN_2022 = TOKEN_2022_PROGRAM_ID.toBase58()

const key = (): string => Keypair.generate().publicKey.toBase58()

const ISSUER_ID = key()
const ISSUER_CONFIG = key()
const MINT = key()
const TOKEN_CONFIG = key()
const POLICY_CONFIG = key()
const FOUNDER = key()
const OFFICER = key()
const ATTESTOR = key()
const OPERATIONAL = key()
const ALICE = key()
const BOB = key()
const ALICE_ATA = key()
const BOB_ATA = key()
const SIGNATURE =
  '5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia7'

const TOKEN: TokenView = { mint: MINT, issuerId: ISSUER_ID, attestationMaxAge: 86_400 }

/** The demo policy: status, jurisdictions, transfer limit, period limit — slots 0…3. */
const RULES = encodeRules({
  status: { sources: ['register'], minTier: 2 },
  jurisdictions: ['GH', 'NG'],
  transferLimit: '50000000',
  periodLimit: { amount: '200000000', windowSeconds: 86_400 },
})

/** What the network would answer, keyed by address. */
function lookups(overrides: Partial<Lookups> = {}): Lookups {
  return {
    issuerIdOfConfig: async (address) => (address === ISSUER_CONFIG ? ISSUER_ID : undefined),
    tokenOfConfig: async (address) => (address === TOKEN_CONFIG ? TOKEN : undefined),
    tokenOfMint: async (mint) => (mint === MINT ? TOKEN : undefined),
    ownerOfTokenAccount: async () => undefined,
    policyRulesAt: async (address) => (address === POLICY_CONFIG ? RULES : undefined),
    attestationIndexAt: async () => 7,
    ...overrides,
  }
}

function ascii(text: string, width: number): number[] {
  const bytes = new Array<number>(width).fill(0)
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i)
  return bytes
}

function encoded(name: string, args: object): Uint8Array {
  return Uint8Array.from(coder.encode(name, { args }))
}

function ours(data: Uint8Array, accounts: string[], outerIndex = 0): InstructionView {
  return { programId: PROGRAM, accounts, data, outerIndex }
}

/** A `TransferChecked` of `MINT` with the hook's accounts appended, as the token program sees it. */
function transferChecked(
  amount: bigint,
  parties = { source: ALICE_ATA, destination: BOB_ATA, authority: ALICE },
  hooked = true,
  outerIndex = 0,
): InstructionView {
  const data = new Uint8Array(10)
  data[0] = 12
  new DataView(data.buffer).setBigUint64(1, amount, true)
  data[9] = 2
  const extras = hooked ? [TOKEN_CONFIG, POLICY_CONFIG, key(), key(), key(), PROGRAM, key()] : []
  return {
    programId: TOKEN_2022,
    accounts: [parties.source, MINT, parties.destination, parties.authority, ...extras],
    data,
    outerIndex,
  }
}

function tx(
  instructions: InstructionView[],
  options: Partial<Pick<TransactionView, 'failure' | 'tokenOwners' | 'blockTime'>> = {},
): TransactionView {
  return {
    signature: SIGNATURE,
    slot: 412_003_881,
    blockTime: 1_772_600_000,
    instructions,
    failure: null,
    tokenOwners: new Map([
      [ALICE_ATA, ALICE],
      [BOB_ATA, BOB],
    ]),
    ...options,
  }
}

const STATUS = { tier: 2, jurisdiction: ascii('NG', 2), denied: false, expiresAt: new BN(0) }

const decode = (view: TransactionView, l = lookups()): Promise<Decoded> =>
  decodeTransaction(view, l)

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('a hooked transfer', () => {
  it('becomes a transfer event with the owners from the balances', async () => {
    const { events, changes } = await decode(tx([transferChecked(12_000_000n)]))

    expect(changes).toEqual([])
    expect(events).toHaveLength(1)
    expect(events[0]?.issuerId).toBe(ISSUER_ID)
    expect(events[0]?.event).toMatchObject({
      kind: 'transfer',
      signature: SIGNATURE,
      eventIndex: 0,
      mint: MINT,
      source: ALICE_ATA,
      destination: BOB_ATA,
      sender: ALICE,
      recipient: BOB,
      amount: '12000000',
    })
  })

  it('asks the network for an owner the balances did not name', async () => {
    const asked: string[] = []
    const view = tx([transferChecked(1n)], { tokenOwners: new Map() })
    const { events } = await decode(
      view,
      lookups({
        ownerOfTokenAccount: async (account) => {
          asked.push(account)
          return account === ALICE_ATA ? ALICE : BOB
        },
      }),
    )
    expect(asked).toEqual([ALICE_ATA, BOB_ATA])
    expect(events[0]?.event).toMatchObject({ sender: ALICE, recipient: BOB })
  })

  it('numbers several transfers of one transaction from zero', async () => {
    // Splitting is an SC-002 vector: one transaction, several transfers.
    const { events } = await decode(
      tx([transferChecked(1n), transferChecked(2n, undefined, true, 1)]),
    )
    expect(events.map((record) => record.event.eventIndex)).toEqual([0, 1])
  })

  it('ignores a transfer of a mint without our hook', async () => {
    const { events } = await decode(tx([transferChecked(1n, undefined, false)]))
    expect(events).toEqual([])
  })

  it('is seen under a CPI too', async () => {
    // The attacker program's instruction is outer; the transfer is its inner.
    const attacker: InstructionView = {
      programId: key(),
      accounts: [],
      data: new Uint8Array(),
      outerIndex: 0,
    }
    const { events } = await decode(tx([attacker, transferChecked(3n, undefined, true, 0)]))
    expect(events).toHaveLength(1)
  })
})

describe('a refused transfer', () => {
  const refused = (custom: number | null, outerIndex = 0) =>
    tx([transferChecked(64_000_000n)], { failure: { outerIndex, custom } })

  it("names the hook's code and the rule slot that fired", async () => {
    const { events } = await decode(refused(6009))
    expect(events).toHaveLength(1)
    expect(events[0]?.event).toMatchObject({
      kind: 'refusal',
      code: 'TRANSFER_LIMIT_EXCEEDED',
      programError: 6009,
      ruleSlot: 2,
      amount: '64000000',
      sender: ALICE,
      recipient: BOB,
    })
  })

  it('keeps the number of a code this worker does not know', async () => {
    // A program newer than the worker: the event stays, verifiable by its number.
    const { events } = await decode(refused(6999))
    expect(events[0]?.event).toMatchObject({
      kind: 'refusal',
      code: null,
      programError: 6999,
      ruleSlot: null,
    })
  })

  it("translates the token program's freeze and pause", async () => {
    const frozen = await decode(refused(17))
    expect(frozen.events[0]?.event).toMatchObject({
      code: 'ACCOUNT_FROZEN',
      programError: 17,
      ruleSlot: null,
    })
    const paused = await decode(refused(67))
    expect(paused.events[0]?.event).toMatchObject({ code: 'TRANSFERS_PAUSED', programError: 67 })
  })

  it('is not a refusal when the sender simply had no funds', async () => {
    // `InsufficientFunds` is the sender's mistake, not the rule at work.
    const { events } = await decode(refused(1))
    expect(events).toEqual([])
  })

  it('is not a refusal when some other instruction failed', async () => {
    const { events } = await decode(refused(6009, 1))
    expect(events).toEqual([])
  })

  it('has no rule slot when the policy account could not be read', async () => {
    const { events } = await decode(
      refused(6009),
      lookups({ policyRulesAt: async () => undefined }),
    )
    expect(events[0]?.event).toMatchObject({ code: 'TRANSFER_LIMIT_EXCEEDED', ruleSlot: null })
  })
})

describe('ruleSlotOf', () => {
  it('finds the slot by the kind of rule the code names', () => {
    expect(ruleSlotOf(RULES, 'RECIPIENT_TIER_TOO_LOW')).toBe(0)
    expect(ruleSlotOf(RULES, 'RECIPIENT_JURISDICTION_NOT_ALLOWED')).toBe(1)
    expect(ruleSlotOf(RULES, 'TRANSFER_LIMIT_EXCEEDED')).toBe(2)
    expect(ruleSlotOf(RULES, 'PERIOD_LIMIT_EXCEEDED')).toBe(3)
  })

  it('has none for a refusal no rule produced', () => {
    expect(ruleSlotOf(RULES, 'POLICY_VERSION_MISMATCH')).toBeNull()
    expect(ruleSlotOf(RULES, 'ACCOUNT_FROZEN')).toBeNull()
    expect(ruleSlotOf(RULES, null)).toBeNull()
  })

  it('has none when the policy carries no such rule', () => {
    const withoutLimits = encodeRules({ status: { sources: ['register'], minTier: 1 } })
    expect(ruleSlotOf(withoutLimits, 'TRANSFER_LIMIT_EXCEEDED')).toBeNull()
  })
})

describe('a failed transaction', () => {
  it('contributes nothing but the refusal', async () => {
    // An `initialize_issuer` that failed created no issuer.
    const data = encoded('initializeIssuer', {
      issuerId: new PublicKey(ISSUER_ID),
      members: [{ wallet: new PublicKey(FOUNDER), roles: 1 }],
      quorumN: 2,
      operationalKey: new PublicKey(OPERATIONAL),
      delegationMask: 3,
    })
    const view = tx([ours(data, [ISSUER_CONFIG, FOUNDER, FOUNDER, key()])], {
      failure: { outerIndex: 0, custom: 6013 },
    })
    expect(await decode(view)).toEqual({ events: [], changes: [] })
  })
})

describe('initialize_issuer', () => {
  it('mirrors the membership by its slots', async () => {
    const data = encoded('initializeIssuer', {
      issuerId: new PublicKey(ISSUER_ID),
      members: [
        { wallet: new PublicKey(FOUNDER), roles: 1 },
        { wallet: new PublicKey(OFFICER), roles: 2 },
        { wallet: new PublicKey(ATTESTOR), roles: 4 },
      ],
      quorumN: 2,
      operationalKey: new PublicKey(OPERATIONAL),
      delegationMask: 3,
    })
    const { events, changes } = await decode(
      tx([ours(data, [ISSUER_CONFIG, FOUNDER, FOUNDER, key()])]),
    )

    expect(events).toEqual([])
    expect(changes).toEqual([
      {
        kind: 'issuer_initialized',
        issuerId: ISSUER_ID,
        founderWallet: FOUNDER,
        quorumN: 2,
        operationalKey: OPERATIONAL,
        delegationMask: 3,
        members: [
          { memberIndex: 0, wallet: FOUNDER, roles: 1 },
          { memberIndex: 1, wallet: OFFICER, roles: 2 },
          { memberIndex: 2, wallet: ATTESTOR, roles: 4 },
        ],
      },
    ])
  })
})

describe('create_token', () => {
  const data = encoded('createToken', {
    decimals: 2,
    attestationCredential: new PublicKey(key()),
    attestationSchema: new PublicKey(key()),
    treasury: new PublicKey(key()),
    feeBps: 25,
    attestationMaxAge: new BN(86_400),
    reserveCurrency: ascii('NGN', 8),
    rules: Buffer.from(RULES),
    initialSupply: new BN('2500000000'),
    reserveAmount: new BN('2540000000'),
    reserveAttestedAt: new BN(1_772_588_000),
    founderStatus: STATUS,
  })
  const FOUNDER_ATA = key()
  const accounts = [
    FOUNDER,
    ATTESTOR,
    ISSUER_CONFIG,
    MINT,
    TOKEN_CONFIG,
    POLICY_CONFIG,
    key(),
    FOUNDER_ATA,
    key(),
    key(),
    TOKEN_2022,
    key(),
    key(),
  ]

  it('brings the token live, lets the founder in and records attestation #0', async () => {
    const { events, changes } = await decode(tx([ours(data, accounts)]))

    expect(changes).toEqual([
      { kind: 'token_created', mint: MINT, issuerId: ISSUER_ID, decimals: 2, policyVersion: 1 },
      {
        kind: 'holder_thawed',
        mint: MINT,
        issuerId: ISSUER_ID,
        wallet: FOUNDER,
        status: { tier: 2, jurisdiction: 'NG', denied: false, expiresAt: null },
      },
    ])
    expect(events.map((record) => record.event)).toEqual([
      expect.objectContaining({
        kind: 'attestation',
        eventIndex: 0,
        mint: MINT,
        index: 0,
        amount: '2540000000',
        currency: 'NGN',
        attestor: ATTESTOR,
        attestedAt: 1_772_588_000,
        expiresAt: 1_772_588_000 + 86_400,
      }),
      expect.objectContaining({
        kind: 'thaw',
        eventIndex: 1,
        wallet: FOUNDER,
        tokenAccount: FOUNDER_ATA,
        authority: FOUNDER,
        status: { tier: 2, jurisdiction: 'NG', denied: false, expiresAt: null },
      }),
    ])
  })

  it('refuses to guess the issuer when its config cannot be read', async () => {
    await expect(
      decode(tx([ours(data, accounts)]), lookups({ issuerIdOfConfig: async () => undefined })),
    ).rejects.toThrow(/issuer config/)
  })
})

describe('set_token_metadata and set_policy', () => {
  it('fills the name and the symbol', async () => {
    const data = encoded('setTokenMetadata', { name: 'Naira Digital', symbol: 'NGND', uri: '' })
    const { changes } = await decode(
      tx([ours(data, [ISSUER_CONFIG, TOKEN_CONFIG, MINT, key(), FOUNDER, TOKEN_2022, key()])]),
    )
    expect(changes).toEqual([
      { kind: 'token_metadata', mint: MINT, name: 'Naira Digital', symbol: 'NGND' },
    ])
  })

  it('moves the token onto the new policy version, with no event yet', async () => {
    // T029 brings the reason code and the case reference; the compliance
    // event arrives with them.
    const data = encoded('setPolicy', { version: 2, rules: Buffer.from(RULES) })
    const { events, changes } = await decode(
      tx([
        ours(data, [ISSUER_CONFIG, TOKEN_CONFIG, POLICY_CONFIG, FOUNDER, key(), FOUNDER, OFFICER]),
      ]),
    )
    expect(events).toEqual([])
    expect(changes).toEqual([{ kind: 'token_policy', mint: MINT, policyVersion: 2 }])
  })
})

describe('thaw_holder and set_holder_status', () => {
  const thawAccounts = [
    ISSUER_CONFIG,
    TOKEN_CONFIG,
    MINT,
    ALICE_ATA,
    key(),
    key(),
    OPERATIONAL,
    OPERATIONAL,
    TOKEN_2022,
    key(),
  ]

  it('lets an account in with its status', async () => {
    const data = encoded('thawHolder', { wallet: new PublicKey(ALICE), status: STATUS })
    const { events, changes } = await decode(tx([ours(data, thawAccounts)]))

    const status = { tier: 2, jurisdiction: 'NG', denied: false, expiresAt: null }
    expect(changes).toEqual([
      { kind: 'holder_thawed', mint: MINT, issuerId: ISSUER_ID, wallet: ALICE, status },
    ])
    expect(events[0]?.event).toMatchObject({
      kind: 'thaw',
      wallet: ALICE,
      tokenAccount: ALICE_ATA,
      authority: OPERATIONAL,
      status,
    })
  })

  it('a repeat thaw carries no status', async () => {
    const data = encoded('thawHolder', { wallet: new PublicKey(ALICE), status: null })
    const { events, changes } = await decode(tx([ours(data, thawAccounts)]))
    expect(changes[0]).toMatchObject({ kind: 'holder_thawed', status: null })
    expect(events[0]?.event).toMatchObject({ kind: 'thaw', status: null })
  })

  it("records a registry change with the chain's zero expiry as null", async () => {
    const data = encoded('setHolderStatus', {
      wallet: new PublicKey(ALICE),
      status: { ...STATUS, denied: true, expiresAt: new BN(1_772_674_400) },
    })
    const { events, changes } = await decode(
      tx([ours(data, [ISSUER_CONFIG, TOKEN_CONFIG, key(), OFFICER])]),
    )
    const status = { tier: 2, jurisdiction: 'NG', denied: true, expiresAt: 1_772_674_400 }
    expect(changes).toEqual([
      { kind: 'holder_status', mint: MINT, issuerId: ISSUER_ID, wallet: ALICE, status },
    ])
    expect(events[0]?.event).toMatchObject({ kind: 'holder_status', authority: OFFICER, status })
  })
})

describe('attest_reserve', () => {
  it('records the attestation with its index and expiry', async () => {
    const data = encoded('attestReserve', {
      amount: new BN('2600000000'),
      currency: ascii('NGN', 8),
      attestedAt: new BN(1_772_600_000),
    })
    const { events } = await decode(
      tx([ours(data, [TOKEN_CONFIG, key(), ATTESTOR, ATTESTOR, key()])]),
    )
    expect(events[0]?.event).toEqual(
      expect.objectContaining({
        kind: 'attestation',
        index: 7,
        amount: '2600000000',
        currency: 'NGN',
        attestor: ATTESTOR,
        attestedAt: 1_772_600_000,
        expiresAt: 1_772_600_000 + 86_400,
      }),
    )
  })
})

describe('instructions with nothing to index', () => {
  it('skips the account list initialisation and the hook itself', async () => {
    const list = ours(Uint8Array.from(coder.encode('initializeExtraAccountMetaList', {})), [
      key(),
      key(),
      TOKEN_CONFIG,
      MINT,
      key(),
    ])
    const execute = ours(Uint8Array.from(coder.encode('execute', { amount: new BN(1) })), [])
    const foreign: InstructionView = {
      programId: key(),
      accounts: [],
      data: new Uint8Array([1, 2]),
      outerIndex: 0,
    }
    expect(await decode(tx([list, execute, foreign]))).toEqual({ events: [], changes: [] })
  })
})
