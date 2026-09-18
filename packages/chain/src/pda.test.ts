import { Connection, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { IDL } from './idl/issuer-forge.ts'
import {
  actionProposalPda,
  extraAccountMetaListPda,
  holderStatusPda,
  issuerConfigPda,
  mintPda,
  PROGRAM_ID,
  policyConfigPda,
  redemptionEscrowPda,
  reserveAttestationPda,
  SEED,
  tokenConfigPda,
  u32Seed,
  u64Seed,
  velocityCounterPda,
} from './pda.ts'
import { createForgeProgram } from './program.ts'

const ISSUER_ID = new PublicKey('11111111111111111111111111111112')
const MINT = new PublicKey('So11111111111111111111111111111111111111112')
const WALLET = new PublicKey('SysvarC1ock11111111111111111111111111111111')
const OTHER_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')

describe('numeric seeds', () => {
  // Bytes, not an address: a mistake in the order or the width yields a valid
  // address the program simply never derives, and it shows up as a refusal on
  // devnet.
  it('u32 — little-endian, exactly four bytes', () => {
    expect(u32Seed(1)).toEqual(new Uint8Array([1, 0, 0, 0]))
    expect(u32Seed(0x0a_0b_0c_0d)).toEqual(new Uint8Array([0x0d, 0x0c, 0x0b, 0x0a]))
    expect(u32Seed(0xff_ff_ff_ff)).toEqual(new Uint8Array([255, 255, 255, 255]))
  })

  it('u64 — little-endian, exactly eight bytes', () => {
    expect(u64Seed(1n)).toEqual(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0]))
    expect(u64Seed(0x01_02_03_04_05_06_07_08n)).toEqual(new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]))
  })

  it('a value outside the type is rejected, not truncated', () => {
    expect(() => u32Seed(-1)).toThrow(RangeError)
    expect(() => u32Seed(0x1_00_00_00_00)).toThrow(RangeError)
    expect(() => u32Seed(1.5)).toThrow(RangeError)
    expect(() => u64Seed(-1n)).toThrow(RangeError)
    expect(() => u64Seed(2n ** 64n)).toThrow(RangeError)
  })
})

describe('seed labels', () => {
  // The only label that can be checked against the program today rather than
  // against our own constant: `initialize_issuer` declares its PDA right in
  // the IDL.
  //
  // The instruction is looked up **by name**, not by index: Anchor orders the
  // list itself, and a new instruction shifts it — this test already failed
  // once on `execute`, whose first account is a token account with no PDA.
  it('`issuer` matches what the IDL declares', () => {
    const instruction = IDL.instructions.find((ix) => ix.name === 'initializeIssuer')
    const account = instruction?.accounts.find((a) => a.name === 'issuerConfig')
    const declared = account && 'pda' in account ? account.pda.seeds[0] : undefined
    expect(declared && 'value' in declared ? Uint8Array.from(declared.value) : undefined).toEqual(
      SEED.issuer,
    )
  })

  it('the other labels are exactly what the PLAN.md table says', () => {
    const decoder = new TextDecoder()
    expect(
      Object.fromEntries(Object.entries(SEED).map(([k, v]) => [k, decoder.decode(v)])),
    ).toEqual({
      issuer: 'issuer',
      mint: 'mint',
      token: 'token',
      policy: 'policy',
      holder: 'holder',
      velocity: 'velocity',
      proposal: 'proposal',
      reserve: 'reserve',
      redemption: 'redemption',
    })
  })
})

describe('PDA addresses', () => {
  // Pinned values: any change to the seeds or the encoding is caught here,
  // not in a transaction on devnet.
  //
  // The values were recomputed once — when `anchor keys sync` replaced the
  // placeholder `ForgePo1icy111…` with the real program address before the
  // first deploy (T024). That is the only legitimate reason to change them:
  // anything else that moves these addresses is a change of seeds, i.e.
  // exactly what the test catches.
  it.each([
    ['IssuerConfig', issuerConfigPda(ISSUER_ID), '78JU4hsTQ33q6DgvU5K3BRjLdKe2eqgapNucWGcr3RuU'],
    ['mint', mintPda(ISSUER_ID, 0), '91YeQseGJTGKM24XpSRjEC1zQWxKGuo5Bkf15xRX7ubS'],
    ['TokenConfig', tokenConfigPda(MINT), '33UvoN3RFpgqvdfqDdhu5W8yXZKKcsseXDjBRJ9Gp8cy'],
    ['PolicyConfig', policyConfigPda(MINT, 7), 'F69qxiRVkW8Arciysxy1VRp2ZCzRmB7sFj4pqSK8csM6'],
    ['HolderStatus', holderStatusPda(MINT, WALLET), '2HZzDNCwFS4eov9i7tE3YVV9SphuzMEaHTkbEZqeqyJv'],
    [
      'VelocityCounter',
      velocityCounterPda(MINT, WALLET),
      '7bUQHhSdGttaGvhVoHwJZeDYeMxQbRrMArrwKfRxp2rj',
    ],
    ['ActionProposal', actionProposalPda(MINT, 9n), 'Hi33NTpXc2JnDTYasHPEmFPbNigkW5LHAFeyEuDVGrD2'],
    [
      'ReserveAttestation',
      reserveAttestationPda(MINT, 3n),
      'FK1U9P45qLBpLm7ZjNMc9vxmxkTy4TzB4b4nAL25qyjc',
    ],
    [
      'RedemptionEscrow',
      redemptionEscrowPda(MINT, ISSUER_ID),
      'ACvCyUZBRMpAToAW3jGpgPiXvESv14LRdBPvLDpoQDYp',
    ],
  ])('%s derives to the pinned address', (_name, actual, expected) => {
    expect(actual.toBase58()).toBe(expected)
  })

  // This label is checked against the program, not against our own constant:
  // `create_token` declares the mint seeds right in the IDL, and a divergence
  // would mean the client looks for the token somewhere other than where the
  // program creates it.
  it('`mint` matches what the IDL declares', () => {
    const instruction = IDL.instructions.find((ix) => ix.name === 'createToken')
    const account = instruction?.accounts.find((a) => a.name === 'mint')
    const declared = account && 'pda' in account ? account.pda.seeds[0] : undefined
    expect(declared && 'value' in declared ? Uint8Array.from(declared.value) : undefined).toEqual(
      SEED.mint,
    )
  })

  it('the token number is part of the mint address', () => {
    expect(mintPda(ISSUER_ID, 0).equals(mintPda(ISSUER_ID, 1))).toBe(false)
  })

  it('the policy version is part of the address', () => {
    expect(policyConfigPda(MINT, 1).equals(policyConfigPda(MINT, 2))).toBe(false)
  })

  it('the attestation index is part of the address', () => {
    expect(reserveAttestationPda(MINT, 0n).equals(reserveAttestationPda(MINT, 1n))).toBe(false)
  })

  it('the address depends on the program, not only on the seeds', () => {
    expect(tokenConfigPda(MINT, OTHER_PROGRAM).equals(tokenConfigPda(MINT))).toBe(false)
  })

  // The formula is set by spl-tlv-account-resolution, and the token program
  // looks the account up by exactly that. The test keeps it in plain sight: a
  // divergence makes a transfer impossible.
  it('ExtraAccountMetaList is `["extra-account-metas", mint]` under the hook program', () => {
    const [expected] = PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('extra-account-metas'), MINT.toBytes()],
      PROGRAM_ID,
    )
    expect(extraAccountMetaListPda(MINT).equals(expected)).toBe(true)
  })
})

describe('the program client', () => {
  const program = createForgeProgram(new Connection('http://127.0.0.1:8899'))

  it('the program address comes from the IDL, one per package', () => {
    expect(PROGRAM_ID.toBase58()).toBe(IDL.address)
    expect(program.programId.equals(PROGRAM_ID)).toBe(true)
  })

  it('the IDL yields typed instructions and accounts', () => {
    expect(typeof program.methods.initializeIssuer).toBe('function')
    expect(program.account.issuerConfig).toBeDefined()
  })

  /**
   * The main check of the vendored IDL: Anchor resolves `issuer_config` from
   * the seeds the **program** declared, and `issuerConfigPda` from ours. A
   * match means the IDL copy and pda.ts describe the same address; a
   * divergence here is the only place it is visible without the network.
   */
  it('IDL-driven resolution matches issuerConfigPda', async () => {
    const instruction = await program.methods
      .initializeIssuer({
        issuerId: ISSUER_ID,
        members: [
          { wallet: WALLET, roles: 1 },
          { wallet: OTHER_PROGRAM, roles: 1 },
        ],
        quorumN: 2,
        operationalKey: WALLET,
        delegationMask: 0,
      })
      .accounts({ payer: WALLET, founder: WALLET })
      .instruction()

    const resolved = instruction.keys[0]
    expect(resolved?.pubkey.equals(issuerConfigPda(ISSUER_ID))).toBe(true)
  })
})
