import { BorshInstructionCoder } from '@coral-xyz/anchor'
import { encodeRules } from '@forge/policy/layout'
import { OPEN_POLICY, type PolicyRules } from '@forge/policy/model'
import { U64_MAX } from '@forge/shared/primitives'
import { Connection, PublicKey, type TransactionInstruction } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { IDL } from '../idl/issuer-forge.ts'
import {
  actionProposalPda,
  issuerConfigPda,
  PROGRAM_ID,
  policyConfigPda,
  tokenConfigPda,
} from '../pda.ts'
import { createForgeProgram } from '../program.ts'
import { compileTransaction, MAX_TRANSACTION_BYTES, type TxPlan, transactionBytes } from './plan.ts'
import {
  buildApproveAction,
  buildCloseActionProposal,
  buildProposeAction,
  buildSetPolicy,
  decodeProposedAction,
  type ProposeActionArgs,
  type SetPolicyArgs,
} from './proposal.ts'

const program = createForgeProgram(new Connection('http://127.0.0.1:8899'))

const ISSUER_ID = new PublicKey('11111111111111111111111111111112')
const MINT = new PublicKey('So11111111111111111111111111111111111111112')
const ADMIN = new PublicKey('SysvarC1ock11111111111111111111111111111111')
const OFFICER = new PublicKey('SysvarS1otHashes111111111111111111111111111')
const PAYER = new PublicKey('SysvarRent111111111111111111111111111111111')
const BLOCKHASH = 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq2h'
const NONCE = 0x0123_4567_89ab_cdefn
const REASON = { code: 4, caseRef: 'FIU-NG/2026/004117' }

/** A policy that differs from the open one, so a body swapped for the default would show. */
const STRICT: PolicyRules = {
  ...OPEN_POLICY,
  status: { ...OPEN_POLICY.status, minTier: 2 },
}

function only(plan: TxPlan): TransactionInstruction {
  const [instruction, ...rest] = plan.instructions
  if (instruction === undefined || rest.length > 0) {
    throw new Error(`${plan.step}: expected exactly one instruction`)
  }
  return instruction
}

const bytesOf = (plan: TxPlan) => transactionBytes(compileTransaction(plan, BLOCKHASH))

const proposeArgs = (over: Partial<ProposeActionArgs> = {}): ProposeActionArgs => ({
  issuerId: ISSUER_ID,
  mint: MINT,
  nonce: NONCE,
  termSeconds: 3 * 24 * 60 * 60,
  action: { kind: 'set-policy', version: 2, policy: STRICT, reason: REASON },
  payer: ADMIN,
  proposer: ADMIN,
  ...over,
})

const setPolicyArgs = (over: Partial<SetPolicyArgs> = {}): SetPolicyArgs => ({
  issuerId: ISSUER_ID,
  mint: MINT,
  version: 2,
  policy: STRICT,
  reason: REASON,
  payer: ADMIN,
  quorum: { kind: 'immediate', signers: [ADMIN, OFFICER] },
  ...over,
})

describe('raising a proposal', () => {
  it('addresses the accounts the program declares, the proposal at its nonce', async () => {
    const keys = only(await buildProposeAction(program, proposeArgs())).keys

    expect(keys.map((key) => key.pubkey.toBase58())).toEqual([
      issuerConfigPda(ISSUER_ID).toBase58(),
      tokenConfigPda(MINT).toBase58(),
      actionProposalPda(MINT, NONCE).toBase58(),
      ADMIN.toBase58(),
      ADMIN.toBase58(),
      PublicKey.default.toBase58(),
    ])
    expect(keys[2]?.isWritable).toBe(true)
  })

  it('a proposer who pays is one signature; a separate payer is two', async () => {
    const same = await buildProposeAction(program, proposeArgs())
    const split = await buildProposeAction(program, proposeArgs({ payer: PAYER }))

    expect(same.signers.map(String)).toEqual([ADMIN.toBase58()])
    expect(split.signers.map(String)).toEqual([PAYER.toBase58(), ADMIN.toBase58()])
  })

  it('every argument survives a round trip through the program coder', async () => {
    // The Anchor coder writes a missing field as zero without a word, so a
    // misspelt `termSeconds` would build a proposal that expires at birth.
    // Only decoding the bytes back tells the two apart.
    const data = only(await buildProposeAction(program, proposeArgs())).data
    const decoded = new BorshInstructionCoder(IDL).decode(data)
    if (decoded === null) throw new Error('the propose data did not decode')
    const args = (decoded.data as { args: { termSeconds: { toString(): string } } }).args

    expect(decoded.name).toBe('proposeAction')
    expect(args.termSeconds.toString()).toBe(String(3 * 24 * 60 * 60))

    const body = decodeProposedAction(data)
    expect(body?.nonce).toBe(NONCE)
    if (body?.action.kind !== 'set-policy') throw new Error('expected a policy body')
    expect(body.action.version).toBe(2)
    expect(Buffer.from(encodeRules(body.action.policy))).toEqual(Buffer.from(encodeRules(STRICT)))
    expect(body.action.reason).toEqual(REASON)
  })

  it('a seizure survives the round trip whole — account, amount and reason', async () => {
    // The amount is past 2^53 on purpose: a `number` anywhere on the way
    // would round it.
    const amount = 2n ** 60n + 7n
    const data = only(
      await buildProposeAction(
        program,
        proposeArgs({
          action: { kind: 'seize', tokenAccount: ADMIN, amount, reason: REASON },
        }),
      ),
    ).data

    const body = decodeProposedAction(data)
    expect(body?.nonce).toBe(NONCE)
    if (body?.action.kind !== 'seize') throw new Error('expected a seizure body')
    expect(body.action.tokenAccount.toBase58()).toBe(ADMIN.toBase58())
    expect(body.action.amount).toBe(amount)
    expect(body.action.reason).toEqual(REASON)
  })

  it('a pause and its lifting survive the round trip, each as itself', async () => {
    for (const kind of ['pause', 'resume'] as const) {
      const data = only(
        await buildProposeAction(program, proposeArgs({ action: { kind, reason: REASON } })),
      ).data
      const body = decodeProposedAction(data)
      expect(body?.nonce).toBe(NONCE)
      expect(body?.action).toEqual({ kind, reason: REASON })
    }
  })

  it('a seizure of nothing, or past u64, or without a reason is refused at assembly', async () => {
    for (const action of [
      { kind: 'seize' as const, tokenAccount: ADMIN, amount: 0n, reason: REASON },
      { kind: 'seize' as const, tokenAccount: ADMIN, amount: U64_MAX + 1n, reason: REASON },
      { kind: 'seize' as const, tokenAccount: ADMIN, amount: 1n, reason: { ...REASON, code: 0 } },
    ]) {
      await expect(buildProposeAction(program, proposeArgs({ action }))).rejects.toThrow(RangeError)
    }
  })

  it('the widest nonce fits, one past it is refused at assembly', async () => {
    await expect(
      buildProposeAction(program, proposeArgs({ nonce: U64_MAX })),
    ).resolves.toBeDefined()
    await expect(buildProposeAction(program, proposeArgs({ nonce: U64_MAX + 1n }))).rejects.toThrow(
      RangeError,
    )
  })

  it('fits in a transaction with a separate payer', async () => {
    expect(
      bytesOf(await buildProposeAction(program, proposeArgs({ payer: PAYER }))),
    ).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES)
  })

  it('bytes of another instruction are not read as a proposal', async () => {
    const data = only(await buildSetPolicy(program, setPolicyArgs())).data
    expect(decodeProposedAction(data)).toBeUndefined()
  })
})

describe('approving and closing', () => {
  const proposal = actionProposalPda(MINT, NONCE)

  it('an approval is one signature, the approver’s, on a writable proposal', async () => {
    const plan = await buildApproveAction(program, {
      issuerId: ISSUER_ID,
      proposal,
      approver: OFFICER,
    })
    const keys = only(plan).keys

    expect(plan.signers.map(String)).toEqual([OFFICER.toBase58()])
    expect(keys[1]?.pubkey.equals(proposal)).toBe(true)
    expect(keys[1]?.isWritable).toBe(true)
  })

  it('closing returns the rent to the payer named, not to the member who closes', async () => {
    const plan = await buildCloseActionProposal(program, {
      issuerId: ISSUER_ID,
      proposal,
      rentRecipient: PAYER,
      member: OFFICER,
    })
    const keys = only(plan).keys

    expect(plan.signers.map(String)).toEqual([OFFICER.toBase58()])
    expect(keys[2]?.pubkey.equals(PAYER)).toBe(true)
    expect(keys[2]?.isWritable).toBe(true)
    expect(keys[2]?.isSigner).toBe(false)
  })
})

describe('a policy change', () => {
  it('on the immediate path the quorum signs in remaining accounts and the proposal slot is empty', async () => {
    const plan = await buildSetPolicy(program, setPolicyArgs({ payer: PAYER }))
    const keys = only(plan).keys

    expect(keys[2]?.pubkey.equals(policyConfigPda(MINT, 2))).toBe(true)
    // Anchor's `None`: the program id, neither signing nor writable.
    expect(keys[5]?.pubkey.equals(PROGRAM_ID)).toBe(true)
    expect(keys[5]?.isWritable).toBe(false)
    expect(keys.slice(6).map((key) => [key.pubkey.toBase58(), key.isSigner])).toEqual([
      [ADMIN.toBase58(), true],
      [OFFICER.toBase58(), true],
    ])
    expect(plan.signers.map(String)).toEqual([
      PAYER.toBase58(),
      ADMIN.toBase58(),
      OFFICER.toBase58(),
    ])
  })

  it('on the deferred path only the payer signs, and the approvers ride unsigned', async () => {
    // FR-019c: the journal names who authorised the change from these
    // accounts, and the program refuses any list but the proposal's own.
    const proposal = actionProposalPda(MINT, NONCE)
    const plan = await buildSetPolicy(
      program,
      setPolicyArgs({
        payer: PAYER,
        quorum: { kind: 'proposal', proposal, approvers: [OFFICER, ADMIN] },
      }),
    )
    const keys = only(plan).keys

    expect(keys[5]?.pubkey.equals(proposal)).toBe(true)
    expect(keys[5]?.isWritable).toBe(true)
    expect(keys.slice(6).map((key) => [key.pubkey.toBase58(), key.isSigner])).toEqual([
      [OFFICER.toBase58(), false],
      [ADMIN.toBase58(), false],
    ])
    expect(plan.signers.map(String)).toEqual([PAYER.toBase58()])
  })

  it('a deferred path that lists nobody is refused at assembly', async () => {
    const proposal = actionProposalPda(MINT, NONCE)
    await expect(
      buildSetPolicy(
        program,
        setPolicyArgs({ quorum: { kind: 'proposal', proposal, approvers: [] } }),
      ),
    ).rejects.toThrow(RangeError)
  })

  it('carries its reason through the program coder', async () => {
    // A misspelt field would be written as zeros, which the program refuses
    // only after a signature; decoding the bytes back is what catches it.
    const data = only(await buildSetPolicy(program, setPolicyArgs())).data
    const decoded = new BorshInstructionCoder(IDL).decode(data)
    if (decoded === null) throw new Error('the set_policy data did not decode')
    const reason = (decoded.data as { args: { reason: { code: number; caseRef: number[] } } }).args
      .reason

    expect(decoded.name).toBe('setPolicy')
    expect(reason.code).toBe(REASON.code)
    expect(Buffer.from(reason.caseRef).toString('latin1').replaceAll('\0', '')).toBe(REASON.caseRef)
  })

  it('carries the same rule bytes the proposal was raised with', async () => {
    // The program recomputes the digest from these bytes; any other encoding
    // of the same policy is `ProposalBodyMismatch`.
    const proposed = only(await buildProposeAction(program, proposeArgs())).data
    const executed = only(await buildSetPolicy(program, setPolicyArgs())).data
    const rules = Buffer.from(encodeRules(STRICT))

    expect(proposed.includes(rules)).toBe(true)
    expect(executed.includes(rules)).toBe(true)
  })

  it('a quorum of three signers plus a separate payer still fits', async () => {
    const third = new PublicKey('SysvarRecentB1ockHashes11111111111111111111')
    const plan = await buildSetPolicy(
      program,
      setPolicyArgs({
        payer: PAYER,
        quorum: { kind: 'immediate', signers: [ADMIN, OFFICER, third] },
      }),
    )
    expect(bytesOf(plan)).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES)
  })

  it('an immediate path with no signers is refused at assembly', async () => {
    await expect(
      buildSetPolicy(program, setPolicyArgs({ quorum: { kind: 'immediate', signers: [] } })),
    ).rejects.toThrow(RangeError)
  })
})
