import { BorshInstructionCoder } from '@coral-xyz/anchor'
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { Connection, PublicKey, type TransactionInstruction } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { IDL } from '../idl/issuer-forge.ts'
import { actionProposalPda, issuerConfigPda, PROGRAM_ID, tokenConfigPda } from '../pda.ts'
import { createForgeProgram } from '../program.ts'
import { buildChangeCirculation, type ChangeCirculationArgs } from './pause.ts'
import { compileTransaction, MAX_TRANSACTION_BYTES, type TxPlan, transactionBytes } from './plan.ts'
import { caseRefBytes } from './reason.ts'

const program = createForgeProgram(new Connection('http://127.0.0.1:8899'))

const ISSUER_ID = new PublicKey('11111111111111111111111111111112')
const MINT = new PublicKey('So11111111111111111111111111111111111111112')
const OFFICER = new PublicKey('SysvarS1otHashes111111111111111111111111111')
const ADMIN = new PublicKey('SysvarC1ock11111111111111111111111111111111')
const PAYER = new PublicKey('SysvarRent111111111111111111111111111111111')
const BLOCKHASH = 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq2h'
const PROPOSAL = actionProposalPda(MINT, 42n)
const REASON = { code: 9, caseRef: 'INC-2026-0412' }

function only(plan: TxPlan): TransactionInstruction {
  const [instruction, ...rest] = plan.instructions
  if (instruction === undefined || rest.length > 0) {
    throw new Error(`${plan.step}: expected exactly one instruction`)
  }
  return instruction
}

const args = (over: Partial<ChangeCirculationArgs> = {}): ChangeCirculationArgs => ({
  direction: 'pause',
  issuerId: ISSUER_ID,
  mint: MINT,
  proposal: PROPOSAL,
  reason: REASON,
  approvers: [OFFICER, ADMIN],
  payer: PAYER,
  ...over,
})

const base58 = (keys: readonly PublicKey[]) => keys.map((key) => key.toBase58())

describe('a pause and its lifting', () => {
  it('addresses the accounts the program declares, the approvers after them in order', async () => {
    const plan = await buildChangeCirculation(program, args())
    const instruction = only(plan)

    expect(plan.step).toBe('pause-circulation')
    expect(instruction.programId.equals(PROGRAM_ID)).toBe(true)
    expect(base58(instruction.keys.map((key) => key.pubkey))).toEqual(
      base58([
        issuerConfigPda(ISSUER_ID),
        tokenConfigPda(MINT),
        MINT,
        PROPOSAL,
        TOKEN_2022_PROGRAM_ID,
        OFFICER,
        ADMIN,
      ]),
    )
    // Nobody in the instruction signs: the payer is only the fee payer, and
    // the approvers are named, not asked again.
    expect(instruction.keys.some((key) => key.isSigner)).toBe(false)
    expect(base58(plan.signers)).toEqual(base58([PAYER]))
  })

  it('each direction is its own instruction, carrying the reason as proposed', async () => {
    const coder = new BorshInstructionCoder(IDL)
    for (const [direction, name, step] of [
      ['pause', 'pauseCirculation', 'pause-circulation'],
      ['resume', 'resumeCirculation', 'resume-circulation'],
    ] as const) {
      const plan = await buildChangeCirculation(program, args({ direction }))
      const decoded = coder.decode(Buffer.from(only(plan).data))
      if (decoded === null) throw new Error(`${name} did not decode`)
      const reason = (decoded.data as { args: { reason: { code: number; caseRef: number[] } } })
        .args.reason

      expect(plan.step).toBe(step)
      expect(decoded.name).toBe(name)
      expect(reason.code).toBe(REASON.code)
      expect(reason.caseRef).toEqual(caseRefBytes(REASON.caseRef))
    }
  })

  it('no approvers is refused at assembly', async () => {
    await expect(buildChangeCirculation(program, args({ approvers: [] }))).rejects.toThrow(
      RangeError,
    )
  })

  it('a quorum of eight still fits in one transaction', async () => {
    const eight = Array.from(
      { length: 8 },
      (_, index) => PublicKey.findProgramAddressSync([Buffer.from([index])], PROGRAM_ID)[0],
    )
    const plan = await buildChangeCirculation(program, args({ approvers: eight }))
    expect(transactionBytes(compileTransaction(plan, BLOCKHASH))).toBeLessThanOrEqual(
      MAX_TRANSACTION_BYTES,
    )
  })
})
