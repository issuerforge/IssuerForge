import { BorshInstructionCoder } from '@coral-xyz/anchor'
import { DELEGATION, DELEGATION_ALL } from '@forge/shared/api'
import { Connection, PublicKey, type TransactionInstruction } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { IDL } from '../idl/issuer-forge.ts'
import { actionProposalPda, issuerConfigPda, PROGRAM_ID } from '../pda.ts'
import { createForgeProgram } from '../program.ts'
import {
  buildProposeDelegation,
  buildSetDelegation,
  delegationProposalPda,
  type ProposeDelegationArgs,
  type SetDelegationArgs,
} from './delegation.ts'
import { compileTransaction, MAX_TRANSACTION_BYTES, type TxPlan, transactionBytes } from './plan.ts'
import { decodeProposedAction } from './proposal.ts'

const program = createForgeProgram(new Connection('http://127.0.0.1:8899'))

const ISSUER_ID = new PublicKey('11111111111111111111111111111112')
const OPERATOR = new PublicKey('So11111111111111111111111111111111111111112')
const ADMIN = new PublicKey('SysvarC1ock11111111111111111111111111111111')
const OFFICER = new PublicKey('SysvarS1otHashes111111111111111111111111111')
const PAYER = new PublicKey('SysvarRent111111111111111111111111111111111')
const BLOCKHASH = 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq2h'
const NONCE = 0x0123_4567_89ab_cdefn

function only(plan: TxPlan): TransactionInstruction {
  const [instruction, ...rest] = plan.instructions
  if (instruction === undefined || rest.length > 0) {
    throw new Error(`${plan.step}: expected exactly one instruction`)
  }
  return instruction
}

const proposeArgs = (over: Partial<ProposeDelegationArgs> = {}): ProposeDelegationArgs => ({
  issuerId: ISSUER_ID,
  nonce: NONCE,
  termSeconds: 3 * 24 * 60 * 60,
  operationalKey: OPERATOR,
  mask: DELEGATION_ALL,
  payer: ADMIN,
  proposer: ADMIN,
  ...over,
})

const setArgs = (over: Partial<SetDelegationArgs> = {}): SetDelegationArgs => ({
  issuerId: ISSUER_ID,
  operationalKey: OPERATOR,
  mask: 0,
  payer: ADMIN,
  quorum: { kind: 'immediate', signers: [ADMIN] },
  ...over,
})

describe('raising a delegation change', () => {
  it('is raised under the issuer’s scope, with the token slot empty', async () => {
    const keys = only(await buildProposeDelegation(program, proposeArgs())).keys

    expect(keys.map((key) => key.pubkey.toBase58())).toEqual([
      issuerConfigPda(ISSUER_ID).toBase58(),
      // Anchor's `None` for `token_config`: the program id.
      PROGRAM_ID.toBase58(),
      actionProposalPda(issuerConfigPda(ISSUER_ID), NONCE).toBase58(),
      ADMIN.toBase58(),
      ADMIN.toBase58(),
      PublicKey.default.toBase58(),
    ])
    expect(keys[2]?.isWritable).toBe(true)
    expect(
      delegationProposalPda(ISSUER_ID, NONCE).equals(keys[2]?.pubkey ?? PublicKey.default),
    ).toBe(true)
  })

  it('carries the key and the mask through the program coder', async () => {
    const data = only(await buildProposeDelegation(program, proposeArgs())).data
    const decoded = new BorshInstructionCoder(IDL).decode(data)
    if (decoded === null) throw new Error('the propose data did not decode')
    const action = (
      decoded.data as {
        args: { action: { setDelegation?: { operationalKey: PublicKey; mask: number } } }
      }
    ).args.action

    expect(action.setDelegation?.operationalKey.toBase58()).toBe(OPERATOR.toBase58())
    expect(action.setDelegation?.mask).toBe(DELEGATION_ALL)
    // Not a token's action: the reader of a token's proposals passes it by.
    expect(decodeProposedAction(data)).toBeUndefined()
  })

  it('a power outside the closed list is refused at assembly', async () => {
    for (const mask of [8, 0x80, -1, 1.5]) {
      await expect(buildProposeDelegation(program, proposeArgs({ mask }))).rejects.toThrow(
        RangeError,
      )
    }
  })
})

describe('changing the delegation', () => {
  it('on the immediate path the members sign in remaining accounts and the proposal slot is empty', async () => {
    const plan = await buildSetDelegation(
      program,
      setArgs({ payer: PAYER, quorum: { kind: 'immediate', signers: [ADMIN, OFFICER] } }),
    )
    const keys = only(plan).keys

    expect(keys[0]?.pubkey.equals(issuerConfigPda(ISSUER_ID))).toBe(true)
    expect(keys[0]?.isWritable).toBe(true)
    expect(keys[1]?.pubkey.equals(PROGRAM_ID)).toBe(true)
    expect(keys.slice(2).map((key) => [key.pubkey.toBase58(), key.isSigner])).toEqual([
      [ADMIN.toBase58(), true],
      [OFFICER.toBase58(), true],
    ])
    expect(plan.step).toBe('set-delegation')
    expect(plan.signers.map(String)).toEqual([
      PAYER.toBase58(),
      ADMIN.toBase58(),
      OFFICER.toBase58(),
    ])
  })

  it('a revocation by one admin who pays is one signature', async () => {
    const plan = await buildSetDelegation(program, setArgs())
    expect(plan.signers.map(String)).toEqual([ADMIN.toBase58()])
    expect(transactionBytes(compileTransaction(plan, BLOCKHASH))).toBeLessThanOrEqual(
      MAX_TRANSACTION_BYTES,
    )
  })

  it('on the deferred path only the payer signs, and the approvers ride unsigned', async () => {
    const proposal = delegationProposalPda(ISSUER_ID, NONCE)
    const plan = await buildSetDelegation(
      program,
      setArgs({
        payer: PAYER,
        mask: DELEGATION.THAW_HOLDER,
        quorum: { kind: 'proposal', proposal, approvers: [ADMIN, OFFICER] },
      }),
    )
    const keys = only(plan).keys

    expect(keys[1]?.pubkey.equals(proposal)).toBe(true)
    expect(keys[1]?.isWritable).toBe(true)
    expect(keys.slice(2).map((key) => [key.pubkey.toBase58(), key.isSigner])).toEqual([
      [ADMIN.toBase58(), false],
      [OFFICER.toBase58(), false],
    ])
    expect(plan.signers.map(String)).toEqual([PAYER.toBase58()])
  })

  it('carries the key and the mask through the program coder', async () => {
    const data = only(
      await buildSetDelegation(program, setArgs({ mask: DELEGATION.SET_HOLDER_STATUS })),
    ).data
    const decoded = new BorshInstructionCoder(IDL).decode(data)
    if (decoded === null) throw new Error('the set-delegation data did not decode')
    const args = (decoded.data as { args: { operationalKey: PublicKey; mask: number } }).args

    expect(decoded.name).toBe('setDelegation')
    expect(args.operationalKey.toBase58()).toBe(OPERATOR.toBase58())
    expect(args.mask).toBe(DELEGATION.SET_HOLDER_STATUS)
  })

  it('an empty quorum on either path, or a mask outside the list, is refused at assembly', async () => {
    const proposal = delegationProposalPda(ISSUER_ID, NONCE)
    for (const args of [
      setArgs({ quorum: { kind: 'immediate', signers: [] } }),
      setArgs({ quorum: { kind: 'proposal', proposal, approvers: [] } }),
      setArgs({ mask: DELEGATION_ALL + 1 }),
    ]) {
      await expect(buildSetDelegation(program, args)).rejects.toThrow(RangeError)
    }
  })
})
