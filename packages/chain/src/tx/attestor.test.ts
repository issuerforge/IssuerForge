import { BorshInstructionCoder } from '@coral-xyz/anchor'
import { Connection, PublicKey, type TransactionInstruction } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { IDL } from '../idl/issuer-forge.ts'
import { actionProposalPda, issuerConfigPda, PROGRAM_ID, tokenConfigPda } from '../pda.ts'
import { createForgeProgram } from '../program.ts'
import { ATTESTATION_MAX_AGE_MAX, buildSetAttestor, type SetAttestorArgs } from './attestor.ts'
import type { TxPlan } from './plan.ts'
import { buildProposeAction, decodeProposedAction, type ProposeActionArgs } from './proposal.ts'

const program = createForgeProgram(new Connection('http://127.0.0.1:8899'))

const ISSUER_ID = new PublicKey('11111111111111111111111111111112')
const MINT = new PublicKey('So11111111111111111111111111111111111111112')
const SUCCESSOR = new PublicKey('SysvarC1ock11111111111111111111111111111111')
const ADMIN = new PublicKey('SysvarS1otHashes111111111111111111111111111')
const OFFICER = new PublicKey('SysvarRent111111111111111111111111111111111')
const DAY = 24 * 60 * 60
const NONCE = 7n
const REASON = { code: 21, caseRef: 'AUDIT/2026/0007' }

function only(plan: TxPlan): TransactionInstruction {
  const [instruction, ...rest] = plan.instructions
  if (instruction === undefined || rest.length > 0) {
    throw new Error(`${plan.step}: expected exactly one instruction`)
  }
  return instruction
}

const setArgs = (over: Partial<SetAttestorArgs> = {}): SetAttestorArgs => ({
  issuerId: ISSUER_ID,
  mint: MINT,
  attestor: SUCCESSOR,
  attestationMaxAge: 30 * DAY,
  reason: REASON,
  payer: ADMIN,
  quorum: { kind: 'immediate', signers: [ADMIN, OFFICER] },
  ...over,
})

const proposeArgs = (over: Partial<ProposeActionArgs> = {}): ProposeActionArgs => ({
  issuerId: ISSUER_ID,
  mint: MINT,
  nonce: NONCE,
  termSeconds: 3 * DAY,
  action: {
    kind: 'set-attestor',
    attestor: SUCCESSOR,
    attestationMaxAge: 30 * DAY,
    reason: REASON,
  },
  payer: ADMIN,
  proposer: ADMIN,
  ...over,
})

type DecodedSetAttestor = {
  args: {
    attestor: PublicKey
    attestationMaxAge: { toNumber(): number }
    reason: { code: number; caseRef: number[] }
  }
}

describe('a change of the reserve terms', () => {
  it('on the immediate path the quorum signs in remaining accounts and the proposal slot is empty', async () => {
    const plan = await buildSetAttestor(program, setArgs())
    expect(plan.step).toBe('set-attestor')
    const keys = only(plan).keys

    expect(keys.map((key) => key.pubkey.toBase58())).toEqual([
      issuerConfigPda(ISSUER_ID).toBase58(),
      tokenConfigPda(MINT).toBase58(),
      PROGRAM_ID.toBase58(),
      ADMIN.toBase58(),
      OFFICER.toBase58(),
    ])
    expect(keys[1]?.isWritable).toBe(true)
    expect(keys.slice(3).every((key) => key.isSigner && !key.isWritable)).toBe(true)
  })

  it('on the deferred path the approvers ride unsigned after the proposal', async () => {
    const proposal = actionProposalPda(MINT, NONCE)
    const keys = only(
      await buildSetAttestor(
        program,
        setArgs({ quorum: { kind: 'proposal', proposal, approvers: [ADMIN, OFFICER] } }),
      ),
    ).keys

    expect(keys[2]?.pubkey.equals(proposal)).toBe(true)
    expect(keys[2]?.isWritable).toBe(true)
    expect(keys.slice(3).map((key) => [key.pubkey.toBase58(), key.isSigner])).toEqual([
      [ADMIN.toBase58(), false],
      [OFFICER.toBase58(), false],
    ])
  })

  it('carries the attestor, the period and the reason through the program coder', async () => {
    const data = only(await buildSetAttestor(program, setArgs())).data
    const decoded = new BorshInstructionCoder(IDL).decode(data)
    if (decoded === null) throw new Error('the set_attestor data did not decode')
    expect(decoded.name).toBe('setAttestor')
    const { args } = decoded.data as DecodedSetAttestor
    expect(args.attestor.toBase58()).toBe(SUCCESSOR.toBase58())
    expect(args.attestationMaxAge.toNumber()).toBe(30 * DAY)
    expect(args.reason.code).toBe(21)
  })

  it('a period the program would refuse is refused at assembly', async () => {
    for (const attestationMaxAge of [0, -DAY, 1.5, ATTESTATION_MAX_AGE_MAX + 1]) {
      await expect(buildSetAttestor(program, setArgs({ attestationMaxAge }))).rejects.toThrow(
        RangeError,
      )
    }
    await expect(
      buildSetAttestor(program, setArgs({ attestationMaxAge: ATTESTATION_MAX_AGE_MAX })),
    ).resolves.toBeDefined()
  })

  it('a path that names nobody is refused at assembly', async () => {
    await expect(
      buildSetAttestor(program, setArgs({ quorum: { kind: 'immediate', signers: [] } })),
    ).rejects.toThrow(RangeError)
    await expect(
      buildSetAttestor(
        program,
        setArgs({
          quorum: { kind: 'proposal', proposal: actionProposalPda(MINT, NONCE), approvers: [] },
        }),
      ),
    ).rejects.toThrow(RangeError)
  })
})

describe('raising a change of the reserve terms', () => {
  it('is raised under the token and survives the round trip whole', async () => {
    const instruction = only(await buildProposeAction(program, proposeArgs()))
    expect(instruction.keys[1]?.pubkey.equals(tokenConfigPda(MINT))).toBe(true)

    expect(decodeProposedAction(instruction.data)).toEqual({
      nonce: NONCE,
      action: {
        kind: 'set-attestor',
        attestor: SUCCESSOR,
        attestationMaxAge: 30 * DAY,
        reason: REASON,
      },
    })
  })

  it('a period the program would refuse is not raised', async () => {
    await expect(
      buildProposeAction(
        program,
        proposeArgs({
          action: {
            kind: 'set-attestor',
            attestor: SUCCESSOR,
            attestationMaxAge: 0,
            reason: REASON,
          },
        }),
      ),
    ).rejects.toThrow(RangeError)
  })
})
