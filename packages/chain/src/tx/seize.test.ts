import { BorshInstructionCoder } from '@coral-xyz/anchor'
import { U64_MAX } from '@forge/shared/primitives'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token'
import { Connection, PublicKey, type TransactionInstruction } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { IDL } from '../idl/issuer-forge.ts'
import {
  actionProposalPda,
  issuerConfigPda,
  PROGRAM_ID,
  seizureVaultAddress,
  tokenConfigPda,
} from '../pda.ts'
import { createForgeProgram } from '../program.ts'
import { compileTransaction, MAX_TRANSACTION_BYTES, type TxPlan, transactionBytes } from './plan.ts'
import { caseRefBytes } from './reason.ts'
import { buildSeize, type SeizeArgs } from './seize.ts'

const program = createForgeProgram(new Connection('http://127.0.0.1:8899'))

const ISSUER_ID = new PublicKey('11111111111111111111111111111112')
const MINT = new PublicKey('So11111111111111111111111111111111111111112')
const TOKEN_ACCOUNT = new PublicKey('SysvarRecentB1ockHashes11111111111111111111')
const OFFICER = new PublicKey('SysvarS1otHashes111111111111111111111111111')
const ADMIN = new PublicKey('SysvarC1ock11111111111111111111111111111111')
const PAYER = new PublicKey('SysvarRent111111111111111111111111111111111')
const BLOCKHASH = 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq2h'
const PROPOSAL = actionProposalPda(MINT, 42n)
const REASON = { code: 4, caseRef: 'FIU-NG/2026/004117' }

function only(plan: TxPlan): TransactionInstruction {
  const [instruction, ...rest] = plan.instructions
  if (instruction === undefined || rest.length > 0) {
    throw new Error(`${plan.step}: expected exactly one instruction`)
  }
  return instruction
}

const seizeArgs = (over: Partial<SeizeArgs> = {}): SeizeArgs => ({
  issuerId: ISSUER_ID,
  mint: MINT,
  proposal: PROPOSAL,
  tokenAccount: TOKEN_ACCOUNT,
  amount: 500_000_000n,
  reason: REASON,
  approvers: [OFFICER, ADMIN],
  payer: PAYER,
  ...over,
})

const base58 = (keys: readonly PublicKey[]) => keys.map((key) => key.toBase58())

describe('a seizure', () => {
  it('addresses the accounts the program declares, the approvers after them in order', async () => {
    const plan = await buildSeize(program, seizeArgs())
    const instruction = only(plan)

    expect(plan.step).toBe('seize')
    expect(instruction.programId.equals(PROGRAM_ID)).toBe(true)
    expect(base58(instruction.keys.map((key) => key.pubkey))).toEqual(
      base58([
        issuerConfigPda(ISSUER_ID),
        tokenConfigPda(MINT),
        MINT,
        TOKEN_ACCOUNT,
        seizureVaultAddress(MINT),
        PROPOSAL,
        PAYER,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
        new PublicKey('11111111111111111111111111111111'),
        OFFICER,
        ADMIN,
      ]),
    )
    // The approvers are named, not asked to sign again: the only signer is
    // the payer.
    expect(base58(plan.signers)).toEqual(base58([PAYER]))
    for (const approver of instruction.keys.slice(-2)) {
      expect(approver.isSigner).toBe(false)
      expect(approver.isWritable).toBe(false)
    }
  })

  it('sends the funds to the token config’s own associated account under Token-2022', () => {
    expect(seizureVaultAddress(MINT).toBase58()).toBe(
      getAssociatedTokenAddressSync(
        MINT,
        tokenConfigPda(MINT),
        true,
        TOKEN_2022_PROGRAM_ID,
      ).toBase58(),
    )
  })

  it('every argument survives a round trip through the program coder', async () => {
    // Past 2^53 on purpose: a `number` on the way would round it, and the
    // program would refuse the seizure as a different action.
    const amount = 2n ** 60n + 7n
    const data = only(await buildSeize(program, seizeArgs({ amount }))).data
    const decoded = new BorshInstructionCoder(IDL).decode(Buffer.from(data))
    if (decoded === null) throw new Error('the seize data did not decode')
    const args = (
      decoded.data as {
        args: { amount: { toString(): string }; reason: { code: number; caseRef: number[] } }
      }
    ).args

    expect(decoded.name).toBe('seize')
    expect(args.amount.toString()).toBe(amount.toString())
    expect(args.reason.code).toBe(REASON.code)
    expect(args.reason.caseRef).toEqual(caseRefBytes(REASON.caseRef))
  })

  it('an amount of nothing or past u64, or no approvers, is refused at assembly', async () => {
    for (const over of [{ amount: 0n }, { amount: U64_MAX + 1n }, { approvers: [] }]) {
      await expect(buildSeize(program, seizeArgs(over))).rejects.toThrow(RangeError)
    }
  })

  it('a quorum of eight still fits in one transaction', async () => {
    const eight = Array.from(
      { length: 8 },
      (_, index) => PublicKey.findProgramAddressSync([Buffer.from([index])], PROGRAM_ID)[0],
    )
    const plan = await buildSeize(program, seizeArgs({ approvers: eight }))
    expect(transactionBytes(compileTransaction(plan, BLOCKHASH))).toBeLessThanOrEqual(
      MAX_TRANSACTION_BYTES,
    )
  })
})
