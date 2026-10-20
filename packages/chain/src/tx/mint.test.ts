import { BorshInstructionCoder } from '@coral-xyz/anchor'
import { U64_MAX } from '@forge/shared/primitives'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token'
import { Connection, PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { IDL } from '../idl/issuer-forge.ts'
import {
  actionProposalPda,
  freezeRecordPda,
  issuerConfigPda,
  PROGRAM_ID,
  reserveAttestationPda,
  tokenConfigPda,
} from '../pda.ts'
import { createForgeProgram } from '../program.ts'
import { buildMint, type MintArgs } from './mint.ts'
import { compileTransaction, MAX_TRANSACTION_BYTES, type TxPlan, transactionBytes } from './plan.ts'
import { buildProposeAction, decodeProposedAction } from './proposal.ts'

const program = createForgeProgram(new Connection('http://127.0.0.1:8899'))

const ISSUER_ID = new PublicKey('11111111111111111111111111111112')
const MINT = new PublicKey('So11111111111111111111111111111111111111112')
const TOKEN_ACCOUNT = new PublicKey('SysvarRecentB1ockHashes11111111111111111111')
const ADMIN_A = new PublicKey('SysvarC1ock11111111111111111111111111111111')
const ADMIN_B = new PublicKey('SysvarS1otHashes111111111111111111111111111')
const PAYER = new PublicKey('SysvarRent111111111111111111111111111111111')
const TREASURY = new PublicKey('SysvarStakeHistory1111111111111111111111111')
const TREASURY_ACCOUNT = getAssociatedTokenAddressSync(TREASURY, MINT, true, TOKEN_2022_PROGRAM_ID)
const BLOCKHASH = 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq2h'
const NONCE = 42n
const PROPOSAL = actionProposalPda(MINT, NONCE)

function only(plan: TxPlan): TransactionInstruction {
  const [instruction, ...rest] = plan.instructions
  if (instruction === undefined || rest.length > 0) {
    throw new Error(`${plan.step}: expected exactly one instruction`)
  }
  return instruction
}

const mintArgs = (over: Partial<MintArgs> = {}): MintArgs => ({
  issuerId: ISSUER_ID,
  mint: MINT,
  proposal: PROPOSAL,
  tokenAccount: TOKEN_ACCOUNT,
  amount: 1_000_000_000n,
  attestationIndex: 3n,
  approvers: [ADMIN_A, ADMIN_B],
  treasury: TREASURY,
  payer: PAYER,
  ...over,
})

const base58 = (keys: readonly PublicKey[]) => keys.map((key) => key.toBase58())

describe('an issuance', () => {
  it('addresses the accounts the program declares, the latest attestation, the treasury, the approvers after them', async () => {
    const plan = await buildMint(program, mintArgs())
    const instruction = only(plan)

    expect(plan.step).toBe('mint')
    expect(instruction.programId.equals(PROGRAM_ID)).toBe(true)
    expect(base58(instruction.keys.map((key) => key.pubkey))).toEqual(
      base58([
        issuerConfigPda(ISSUER_ID),
        tokenConfigPda(MINT),
        MINT,
        reserveAttestationPda(MINT, 3n),
        TOKEN_ACCOUNT,
        TREASURY,
        TREASURY_ACCOUNT,
        freezeRecordPda(TREASURY_ACCOUNT),
        PROPOSAL,
        PAYER,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
        SystemProgram.programId,
        ADMIN_A,
        ADMIN_B,
      ]),
    )
    // Nobody signs but whoever pays the fee: the quorum is in the proposal.
    expect(base58(plan.signers)).toEqual(base58([PAYER]))
    expect(instruction.keys.slice(-2).every((key) => !key.isSigner && !key.isWritable)).toBe(true)
  })

  it('the amount survives a round trip through the program coder past 2^53', async () => {
    const amount = 2n ** 60n + 7n
    const data = only(await buildMint(program, mintArgs({ amount }))).data
    const decoded = new BorshInstructionCoder(IDL).decode(Buffer.from(data))
    if (decoded === null) throw new Error('the mint data did not decode')

    expect(decoded.name).toBe('mint')
    expect(
      (decoded.data as { args: { amount: { toString(): string } } }).args.amount.toString(),
    ).toBe(amount.toString())
  })

  it('an amount of nothing or past u64, a negative index, or no approvers is refused at assembly', async () => {
    for (const over of [
      { amount: 0n },
      { amount: U64_MAX + 1n },
      { attestationIndex: -1n },
      { approvers: [] },
    ]) {
      await expect(buildMint(program, mintArgs(over))).rejects.toThrow(RangeError)
    }
  })

  it('a quorum of eight still fits in one transaction', async () => {
    const eight = Array.from(
      { length: 8 },
      (_, index) => PublicKey.findProgramAddressSync([Buffer.from([index])], PROGRAM_ID)[0],
    )
    const plan = await buildMint(program, mintArgs({ approvers: eight }))
    expect(transactionBytes(compileTransaction(plan, BLOCKHASH))).toBeLessThanOrEqual(
      MAX_TRANSACTION_BYTES,
    )
  })
})

describe('an issuance proposal', () => {
  const propose = (amount: bigint) =>
    buildProposeAction(program, {
      issuerId: ISSUER_ID,
      mint: MINT,
      nonce: NONCE,
      termSeconds: 3 * 24 * 60 * 60,
      action: { kind: 'mint', tokenAccount: TOKEN_ACCOUNT, amount },
      payer: ADMIN_A,
      proposer: ADMIN_A,
    })

  it('survives the round trip whole — account and amount', async () => {
    const amount = 2n ** 60n + 7n
    const body = decodeProposedAction(only(await propose(amount)).data)

    expect(body?.nonce).toBe(NONCE)
    if (body?.action.kind !== 'mint') throw new Error('expected an issuance body')
    expect(body.action.tokenAccount.toBase58()).toBe(TOKEN_ACCOUNT.toBase58())
    expect(body.action.amount).toBe(amount)
  })

  it('of nothing or past u64 is refused at assembly', async () => {
    for (const amount of [0n, U64_MAX + 1n]) {
      await expect(propose(amount)).rejects.toThrow(RangeError)
    }
  })
})
