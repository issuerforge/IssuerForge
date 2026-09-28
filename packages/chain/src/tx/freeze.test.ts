import { BorshInstructionCoder } from '@coral-xyz/anchor'
import { Connection, PublicKey, type TransactionInstruction } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { IDL } from '../idl/issuer-forge.ts'
import { freezeRecordPda, PROGRAM_ID } from '../pda.ts'
import { createForgeProgram } from '../program.ts'
import {
  buildFreezeHolder,
  buildUnfreezeHolder,
  CASE_REF_BYTES,
  caseRefBytes,
  type FreezeHolderArgs,
  type UnfreezeHolderArgs,
} from './freeze.ts'
import { compileTransaction, MAX_TRANSACTION_BYTES, type TxPlan, transactionBytes } from './plan.ts'

const program = createForgeProgram(new Connection('http://127.0.0.1:8899'))

const ISSUER_ID = new PublicKey('11111111111111111111111111111112')
const MINT = new PublicKey('So11111111111111111111111111111111111111112')
const TOKEN_ACCOUNT = new PublicKey('SysvarRecentB1ockHashes11111111111111111111')
const OFFICER = new PublicKey('SysvarS1otHashes111111111111111111111111111')
const PAYER = new PublicKey('SysvarRent111111111111111111111111111111111')
const BLOCKHASH = 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq2h'
const REASON = { code: 4, caseRef: 'FIU-NG/2026/004117' }

function only(plan: TxPlan): TransactionInstruction {
  const [instruction, ...rest] = plan.instructions
  if (instruction === undefined || rest.length > 0) {
    throw new Error(`${plan.step}: expected exactly one instruction`)
  }
  return instruction
}

const freezeArgs = (over: Partial<FreezeHolderArgs> = {}): FreezeHolderArgs => ({
  issuerId: ISSUER_ID,
  mint: MINT,
  tokenAccount: TOKEN_ACCOUNT,
  payer: PAYER,
  officer: OFFICER,
  reason: REASON,
  ...over,
})

const unfreezeArgs = (over: Partial<UnfreezeHolderArgs> = {}): UnfreezeHolderArgs => ({
  issuerId: ISSUER_ID,
  mint: MINT,
  tokenAccount: TOKEN_ACCOUNT,
  rentRecipient: PAYER,
  officer: OFFICER,
  reason: REASON,
  ...over,
})

const base58 = (keys: readonly PublicKey[]) => keys.map((key) => key.toBase58())

/** The arguments as the program will read them — the only check that a field was not encoded as zero. */
function decodedReason(plan: TxPlan): { code: number; caseRef: number[] } {
  const decoded = new BorshInstructionCoder(IDL).decode(Buffer.from(only(plan).data))
  if (decoded === null) throw new Error('the instruction does not decode')
  return (decoded.data as { args: { reason: { code: number; caseRef: number[] } } }).args.reason
}

describe('freeze_holder', () => {
  it('is signed by the payer and the officer, and nobody else', async () => {
    const plan = await buildFreezeHolder(program, freezeArgs())
    expect(plan.step).toBe('freeze-holder')
    expect(base58(plan.signers)).toEqual(base58([PAYER, OFFICER]))
  })

  it("names the record by the token account's address", async () => {
    const plan = await buildFreezeHolder(program, freezeArgs())
    const instruction = only(plan)
    expect(instruction.programId.equals(PROGRAM_ID)).toBe(true)
    expect(instruction.keys[3]?.pubkey.equals(TOKEN_ACCOUNT)).toBe(true)
    expect(instruction.keys[4]?.pubkey.equals(freezeRecordPda(TOKEN_ACCOUNT))).toBe(true)
  })

  it('carries the reason the program will read back', async () => {
    const reason = decodedReason(await buildFreezeHolder(program, freezeArgs()))
    expect(reason.code).toBe(4)
    expect(reason.caseRef).toEqual(caseRefBytes('FIU-NG/2026/004117'))
  })

  it('fits a transaction', async () => {
    const plan = await buildFreezeHolder(program, freezeArgs())
    expect(transactionBytes(compileTransaction(plan, BLOCKHASH))).toBeLessThanOrEqual(
      MAX_TRANSACTION_BYTES,
    )
  })
})

describe('unfreeze_holder', () => {
  it('is signed by the officer alone, who also pays the fee', async () => {
    const plan = await buildUnfreezeHolder(program, unfreezeArgs())
    expect(plan.step).toBe('unfreeze-holder')
    expect(base58(plan.signers)).toEqual(base58([OFFICER]))
  })

  it('returns the rent to the named recipient', async () => {
    const instruction = only(await buildUnfreezeHolder(program, unfreezeArgs()))
    expect(instruction.keys[4]?.pubkey.equals(freezeRecordPda(TOKEN_ACCOUNT))).toBe(true)
    expect(instruction.keys[5]?.pubkey.equals(PAYER)).toBe(true)
    expect(instruction.keys[5]?.isSigner).toBe(false)
  })

  it('carries a reason of its own', async () => {
    const reason = decodedReason(
      await buildUnfreezeHolder(program, unfreezeArgs({ reason: { code: 9, caseRef: 'X' } })),
    )
    expect(reason.code).toBe(9)
    expect(reason.caseRef).toEqual(caseRefBytes('X'))
  })
})

describe('a reason the program would refuse fails at assembly', () => {
  it('a missing or out-of-range code', async () => {
    for (const code of [0, -1, 1.5, 0x1_0000]) {
      await expect(
        buildFreezeHolder(program, freezeArgs({ reason: { ...REASON, code } })),
      ).rejects.toThrow(RangeError)
    }
  })

  it('an empty, overlong or non-printable case reference', () => {
    for (const caseRef of ['', 'A'.repeat(CASE_REF_BYTES + 1), 'CASE\n1', 'кейс-1']) {
      expect(() => caseRefBytes(caseRef)).toThrow(RangeError)
    }
  })

  it('a reference is padded with zeros to the full width', () => {
    const bytes = caseRefBytes('AB')
    expect(bytes).toHaveLength(CASE_REF_BYTES)
    expect(bytes.slice(0, 3)).toEqual([0x41, 0x42, 0])
    expect(caseRefBytes('A'.repeat(CASE_REF_BYTES))).not.toContain(0)
  })
})
