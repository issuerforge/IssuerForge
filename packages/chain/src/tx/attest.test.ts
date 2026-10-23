import { BorshInstructionCoder } from '@coral-xyz/anchor'
import { Connection, PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { IDL } from '../idl/issuer-forge.ts'
import { PROGRAM_ID, reserveAttestationPda, tokenConfigPda } from '../pda.ts'
import { createForgeProgram } from '../program.ts'
import { type AttestReserveArgs, buildAttestReserve } from './attest.ts'
import { compileTransaction, MAX_TRANSACTION_BYTES, type TxPlan, transactionBytes } from './plan.ts'

const program = createForgeProgram(new Connection('http://127.0.0.1:8899'))

const MINT = new PublicKey('So11111111111111111111111111111111111111112')
const ATTESTOR = new PublicKey('SysvarC1ock11111111111111111111111111111111')
const PAYER = new PublicKey('SysvarRent111111111111111111111111111111111')
const BLOCKHASH = 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq2h'

function only(plan: TxPlan): TransactionInstruction {
  const [instruction, ...rest] = plan.instructions
  if (instruction === undefined || rest.length > 0) {
    throw new Error(`${plan.step}: expected exactly one instruction`)
  }
  return instruction
}

const attestArgs = (over: Partial<AttestReserveArgs> = {}): AttestReserveArgs => ({
  mint: MINT,
  index: 4n,
  amount: 2_540_000_000n,
  currency: 'NGN',
  attestedAt: 1_800_000_000,
  attestationMaxAge: 604_800,
  attestor: ATTESTOR,
  payer: ATTESTOR,
  ...over,
})

type Decoded = {
  amount: { toString(): string }
  currency: number[]
  attestedAt: { toString(): string }
  attestationMaxAge: { toString(): string }
}

function decoded(plan: TxPlan): Decoded {
  const result = new BorshInstructionCoder(IDL).decode(Buffer.from(only(plan).data))
  if (result === null) throw new Error('the instruction does not decode')
  expect(result.name).toBe('attestReserve')
  return (result.data as { args: Decoded }).args
}

describe('a reserve attestation', () => {
  it('writes the record at the index it is given, signed by the attestor alone', async () => {
    const plan = await buildAttestReserve(program, attestArgs())
    const instruction = only(plan)

    expect(plan.step).toBe('attest-reserve')
    expect(instruction.programId.equals(PROGRAM_ID)).toBe(true)
    expect(instruction.keys.map((key) => key.pubkey.toBase58())).toEqual(
      [
        tokenConfigPda(MINT),
        reserveAttestationPda(MINT, 4n),
        ATTESTOR,
        ATTESTOR,
        SystemProgram.programId,
      ].map((key) => key.toBase58()),
    )
    expect(plan.signers.map((key) => key.toBase58())).toEqual([ATTESTOR.toBase58()])
  })

  it('a separate payer is a second signer and the fee payer', async () => {
    const plan = await buildAttestReserve(program, attestArgs({ payer: PAYER }))

    expect(plan.feePayer.equals(PAYER)).toBe(true)
    expect(plan.signers.map((key) => key.toBase58()).sort()).toEqual(
      [ATTESTOR.toBase58(), PAYER.toBase58()].sort(),
    )
  })

  it('the terms survive the program coder: an amount past 2^53, the currency padded to eight bytes', async () => {
    const amount = 2n ** 60n + 7n
    const args = decoded(await buildAttestReserve(program, attestArgs({ amount })))

    expect(args.amount.toString()).toBe(amount.toString())
    expect(args.currency).toEqual([78, 71, 78, 0, 0, 0, 0, 0])
    expect(args.attestedAt.toString()).toBe('1800000000')
    expect(args.attestationMaxAge.toString()).toBe('604800')
  })

  it('refuses at assembly what the program would refuse after a signature', async () => {
    await expect(buildAttestReserve(program, attestArgs({ amount: -1n }))).rejects.toThrow(
      RangeError,
    )
    await expect(buildAttestReserve(program, attestArgs({ amount: 2n ** 64n }))).rejects.toThrow(
      RangeError,
    )
    await expect(buildAttestReserve(program, attestArgs({ index: -1n }))).rejects.toThrow(
      RangeError,
    )
  })

  it('fits in a transaction', async () => {
    const plan = await buildAttestReserve(program, attestArgs({ payer: PAYER }))
    expect(transactionBytes(compileTransaction(plan, BLOCKHASH))).toBeLessThanOrEqual(
      MAX_TRANSACTION_BYTES,
    )
  })
})
