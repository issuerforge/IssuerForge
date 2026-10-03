// The two readings of the chain against each other.
//
// The indexer writes the journal; the verifier reads the chain on its own to
// check it. Two implementations of one reading drift silently — this file is
// what makes the drift loud, the same way the Rust and TS rule models are
// held together. Every case is a node answer both sides flatten themselves.
//
// This is the only place the verifier's package touches the worker, and it is
// a test: `independence.test.ts` keeps it out of the shipped code.
import { BN } from '@coral-xyz/anchor'
import { decodeTransaction, type Lookups } from '@forge/worker/indexer/decode'
import { toTransactionView } from '@forge/worker/indexer/transaction'
import { PublicKey, type VersionedTransactionResponse } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { readTransaction } from './decode.ts'
import {
  ADMIN,
  ALICE,
  ALICE_ATA,
  ATTESTATION,
  ATTESTOR,
  ascii,
  BOB_ATA,
  CAROL_ATA,
  FOUNDER,
  ISSUER_CONFIG,
  key,
  MINT,
  OFFICER,
  OPERATIONAL,
  ours,
  oursBare,
  POLICY_CONFIG,
  PROGRAM,
  RULES,
  reason,
  response,
  STATUS,
  state,
  TOKEN_2022,
  TOKEN_CONFIG,
  type TxShape,
  tokenOp,
  transferChecked,
  WORLD,
} from './testing/fixtures.ts'

/** The worker's questions, answered from the same world the verifier reads. */
const lookups: Lookups = {
  issuerIdOfConfig: async (address) => WORLD.issuers.get(address),
  tokenOfConfig: async (address) => WORLD.tokens.get(address),
  tokenOfMint: async (mint) => [...WORLD.tokens.values()].find((token) => token.mint === mint),
  ownerOfTokenAccount: async (address) => WORLD.owners.get(address),
  policyRulesAt: async (address) => WORLD.rules.get(address),
  attestationIndexAt: async (address) => WORLD.attestations.get(address),
}

const SIG = 'fixture'

async function both(shape: TxShape) {
  const answer: VersionedTransactionResponse = response(shape)
  const sig = answer.transaction.signatures[0] ?? SIG
  const worker = await decodeTransaction(toTransactionView(sig, answer), lookups)
  const verifier = await readTransaction(sig, answer, PROGRAM, state)
  return { worker: worker.events.map(({ event }) => event), verifier }
}

const PROPOSAL = key()
const PAYER = key()
const SYSTEM = '11111111111111111111111111111111'
const founderAta = key()

/** Account lists in the program's order — written out, not taken from the IDL, on purpose. */
const accounts = {
  freeze: [ISSUER_CONFIG, TOKEN_CONFIG, MINT, ALICE_ATA, key(), PAYER, OFFICER, TOKEN_2022, SYSTEM],
  unfreeze: [ISSUER_CONFIG, TOKEN_CONFIG, MINT, ALICE_ATA, key(), PAYER, OFFICER, TOKEN_2022],
  seize: [
    ISSUER_CONFIG,
    TOKEN_CONFIG,
    MINT,
    ALICE_ATA,
    key(),
    PROPOSAL,
    PAYER,
    TOKEN_2022,
    key(),
    SYSTEM,
    OFFICER,
    ADMIN,
  ],
  circulation: [ISSUER_CONFIG, TOKEN_CONFIG, MINT, PROPOSAL, TOKEN_2022, OFFICER, ADMIN],
  setPolicy: (proposal: string) => [
    ISSUER_CONFIG,
    TOKEN_CONFIG,
    key(),
    PAYER,
    SYSTEM,
    proposal,
    OFFICER,
    FOUNDER,
  ],
  thaw: [
    ISSUER_CONFIG,
    TOKEN_CONFIG,
    MINT,
    ALICE_ATA,
    key(),
    key(),
    OPERATIONAL,
    OPERATIONAL,
    TOKEN_2022,
    SYSTEM,
    key(),
  ],
  createToken: [
    FOUNDER,
    ATTESTOR,
    ISSUER_CONFIG,
    MINT,
    TOKEN_CONFIG,
    POLICY_CONFIG,
    key(),
    founderAta,
    key(),
    key(),
    TOKEN_2022,
    key(),
    SYSTEM,
  ],
}

const CASES: Record<string, TxShape> = {
  'a hooked transfer': { instructions: [transferChecked(12_000_000n)] },
  'two transfers and one of a mint without the hook': {
    instructions: [
      transferChecked(1n),
      transferChecked(5n, { source: key(), destination: key(), authority: key() }, false),
      transferChecked(2n, { source: BOB_ATA, destination: ALICE_ATA, authority: key() }),
    ],
  },
  'a transfer whose owner only the state knows': {
    instructions: [
      transferChecked(3n, { source: ALICE_ATA, destination: CAROL_ATA, authority: ALICE }),
    ],
  },
  'a refusal by the hook': {
    instructions: [transferChecked(60_000_000n)],
    err: { InstructionError: [0, { Custom: 6009 }] },
  },
  'a refusal by a status rule': {
    instructions: [transferChecked(1n)],
    err: { InstructionError: [0, { Custom: 6005 }] },
  },
  'a refusal with a number the table does not know': {
    instructions: [transferChecked(1n)],
    err: { InstructionError: [0, { Custom: 6099 }] },
  },
  'a refusal by the token program (frozen)': {
    instructions: [transferChecked(1n)],
    err: { InstructionError: [0, { Custom: 17 }] },
  },
  'a failure that is not a refusal (insufficient funds)': {
    instructions: [transferChecked(1n)],
    err: { InstructionError: [0, { Custom: 1 }] },
  },
  'a failure before any instruction': {
    instructions: [transferChecked(1n)],
    err: 'BlockhashNotFound',
  },
  'a failed freeze': {
    instructions: [ours('freezeHolder', { reason: reason(4, 'X') }, accounts.freeze)],
    err: { InstructionError: [0, { Custom: 6030 }] },
  },
  create_token: {
    instructions: [
      ours(
        'createToken',
        {
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
        },
        accounts.createToken,
      ),
    ],
  },
  'thaw_holder with a status': {
    instructions: [
      ours('thawHolder', { wallet: new PublicKey(ALICE), status: STATUS }, accounts.thaw),
    ],
  },
  'thaw_holder without one': {
    instructions: [
      ours('thawHolder', { wallet: new PublicKey(ALICE), status: null }, accounts.thaw),
    ],
  },
  set_holder_status: {
    instructions: [
      ours(
        'setHolderStatus',
        {
          wallet: new PublicKey(ALICE),
          status: { ...STATUS, denied: true, expiresAt: new BN(1_772_674_400) },
        },
        [ISSUER_CONFIG, TOKEN_CONFIG, key(), OFFICER],
      ),
    ],
  },
  'set_policy, immediate': {
    instructions: [
      ours(
        'setPolicy',
        { version: 2, rules: Buffer.from(RULES), reason: reason(12, 'POLICY/2026/0007') },
        accounts.setPolicy(PROGRAM),
      ),
    ],
  },
  'set_policy, by proposal': {
    instructions: [
      ours(
        'setPolicy',
        { version: 3, rules: Buffer.from(RULES), reason: reason(3, 'POLICY/2026/0008') },
        accounts.setPolicy(PROPOSAL),
      ),
    ],
  },
  freeze_holder: {
    instructions: [
      ours('freezeHolder', { reason: reason(4, 'FIU-NG/2026/004117') }, accounts.freeze),
    ],
  },
  unfreeze_holder: {
    instructions: [
      ours('unfreezeHolder', { reason: reason(9, 'FIU-NG/2026/004117/closed') }, accounts.unfreeze),
    ],
  },
  'seize, with the burn and mint under it': {
    instructions: [
      ours(
        'seize',
        { amount: new BN('7500000'), reason: reason(4, 'FIU-NG/2026/004117') },
        accounts.seize,
        [tokenOp(8), tokenOp(7)],
      ),
    ],
  },
  'seize through an address lookup table': {
    lookedUp: 3,
    instructions: [
      ours('seize', { amount: new BN('1'), reason: reason(4, 'ALT') }, accounts.seize, [
        tokenOp(8),
        tokenOp(7),
      ]),
    ],
  },
  pause: {
    instructions: [
      ours('pauseCirculation', { reason: reason(9, 'INC-2026-0412') }, accounts.circulation),
    ],
  },
  resume: {
    instructions: [
      ours('resumeCirculation', { reason: reason(9, 'INC-2026-0412') }, accounts.circulation),
    ],
  },
  attest_reserve: {
    instructions: [
      ours(
        'attestReserve',
        {
          amount: new BN('2600000000'),
          currency: ascii('NGN', 8),
          attestedAt: new BN(1_772_600_000),
        },
        [TOKEN_CONFIG, ATTESTATION, ATTESTOR, ATTESTOR, SYSTEM],
      ),
    ],
  },
  'a freeze invoked by another program': {
    instructions: [
      {
        programId: key(),
        accounts: [],
        data: Uint8Array.from([1]),
        inner: [ours('freezeHolder', { reason: reason(5, 'CPI') }, accounts.freeze)],
      },
    ],
  },
  'a freeze and a transfer in one transaction': {
    instructions: [
      ours('freezeHolder', { reason: reason(4, 'MIX') }, accounts.freeze),
      transferChecked(9n, { source: BOB_ATA, destination: CAROL_ATA, authority: key() }),
    ],
  },
  'set_delegation and the proposal lifecycle': {
    instructions: [
      ours('setDelegation', { operationalKey: new PublicKey(OPERATIONAL), mask: 1 }, [
        ISSUER_CONFIG,
        PROGRAM,
        ADMIN,
      ]),
      oursBare('approveAction', [ISSUER_CONFIG, PROPOSAL, ADMIN]),
    ],
  },
}

describe('the verifier reads the chain as the indexer does', () => {
  for (const [name, shape] of Object.entries(CASES)) {
    it(name, async () => {
      const { worker, verifier } = await both(shape)
      expect(verifier.events).toEqual(worker)
    })
  }

  it('reads something in most cases — the comparison is not of two empty lists', async () => {
    let nonEmpty = 0
    for (const shape of Object.values(CASES)) {
      if ((await both(shape)).worker.length > 0) nonEmpty += 1
    }
    expect(nonEmpty).toBeGreaterThanOrEqual(Object.keys(CASES).length - 5)
  })

  it('covers every event kind and every compliance action the indexer writes', async () => {
    const kinds = new Set<string>()
    for (const shape of Object.values(CASES)) {
      for (const event of (await both(shape)).worker) {
        kinds.add(event.kind === 'compliance' ? `compliance:${event.action}` : event.kind)
      }
    }
    expect([...kinds].sort()).toEqual([
      'attestation',
      'compliance:freeze',
      'compliance:pause',
      'compliance:seize',
      'compliance:set_policy',
      'compliance:unfreeze',
      'compliance:unpause',
      'holder_status',
      'refusal',
      'thaw',
      'transfer',
    ])
  })

  it('names what the format does not carry instead of skipping it', async () => {
    const { verifier } = await both(CASES['set_delegation and the proposal lifecycle'] as TxShape)
    expect(verifier.unjournalled.map((i) => i.instruction)).toEqual([
      'setDelegation',
      'approveAction',
    ])
  })
})
