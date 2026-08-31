import { Connection, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { IDL } from './idl/issuer-forge.ts'
import {
  actionProposalPda,
  extraAccountMetaListPda,
  holderStatusPda,
  issuerConfigPda,
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

describe('числові seeds', () => {
  // Байти, а не адреса: помилка в порядку або в ширині дає валідну адресу, якої
  // програма просто не виводить, і виявляється вона відмовою на девнеті.
  it('u32 — little-endian, рівно чотири байти', () => {
    expect(u32Seed(1)).toEqual(new Uint8Array([1, 0, 0, 0]))
    expect(u32Seed(0x0a_0b_0c_0d)).toEqual(new Uint8Array([0x0d, 0x0c, 0x0b, 0x0a]))
    expect(u32Seed(0xff_ff_ff_ff)).toEqual(new Uint8Array([255, 255, 255, 255]))
  })

  it('u64 — little-endian, рівно вісім байтів', () => {
    expect(u64Seed(1n)).toEqual(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0]))
    expect(u64Seed(0x01_02_03_04_05_06_07_08n)).toEqual(new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]))
  })

  it('значення поза типом відхиляється, а не обрізається', () => {
    expect(() => u32Seed(-1)).toThrow(RangeError)
    expect(() => u32Seed(0x1_00_00_00_00)).toThrow(RangeError)
    expect(() => u32Seed(1.5)).toThrow(RangeError)
    expect(() => u64Seed(-1n)).toThrow(RangeError)
    expect(() => u64Seed(2n ** 64n)).toThrow(RangeError)
  })
})

describe('мітки seeds', () => {
  // Єдина мітка, яку сьогодні можна звірити з програмою, а не з власною
  // константою: `initialize_issuer` оголошує свій PDA прямо в IDL.
  it('`issuer` збігається з тим, що оголошує IDL', () => {
    const declared = IDL.instructions[0].accounts[0].pda.seeds[0].value
    expect(SEED.issuer).toEqual(Uint8Array.from(declared))
  })

  it('решта міток — рівно те, що каже таблиця PLAN.md', () => {
    const decoder = new TextDecoder()
    expect(
      Object.fromEntries(Object.entries(SEED).map(([k, v]) => [k, decoder.decode(v)])),
    ).toEqual({
      issuer: 'issuer',
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

describe('адреси PDA', () => {
  // Пін-значення: будь-яка зміна seeds або кодування ловиться тут, а не в
  // транзакції на девнеті.
  it.each([
    ['IssuerConfig', issuerConfigPda(ISSUER_ID), 'EeYRwFELCb26ZFoiurGWwkekrDDAERBUWYKVXqs2ZDNw'],
    ['TokenConfig', tokenConfigPda(MINT), '4yQao3mhkWiWNgY5jmtbvJSbuRikmgMy8iT4kkmpcYPN'],
    ['PolicyConfig', policyConfigPda(MINT, 7), 'Edd5LtcqDu6CSGrKcXbtYBw5zjruZxuBiSEFbwBFSXAE'],
    ['HolderStatus', holderStatusPda(MINT, WALLET), '7ZNF8xYgg1hr784ewVVEPu51vCY6688frAwPfkFE3pXP'],
    [
      'VelocityCounter',
      velocityCounterPda(MINT, WALLET),
      'p58tX7p3bQuH8xBRHhorK9bnTyF2AmogzafEgGzvfM9',
    ],
    ['ActionProposal', actionProposalPda(MINT, 9n), 'DGro4ay5DE2hXucH1oP6SPFm6Q9pZ6qfRBnWYjrRZPVy'],
    [
      'ReserveAttestation',
      reserveAttestationPda(MINT, 3n),
      '6ES79hyhhst36qUwk5RMSg9iNvL33sCxsXwd73MCn6mh',
    ],
    [
      'RedemptionEscrow',
      redemptionEscrowPda(MINT, ISSUER_ID),
      'B91BqGRN4mrgtNdVK2kwTNch8sokPswycj5R7CCxwM1x',
    ],
  ])('%s виводиться в закріплену адресу', (_name, actual, expected) => {
    expect(actual.toBase58()).toBe(expected)
  })

  it('версія політики входить в адресу', () => {
    expect(policyConfigPda(MINT, 1).equals(policyConfigPda(MINT, 2))).toBe(false)
  })

  it('індекс атестації входить в адресу', () => {
    expect(reserveAttestationPda(MINT, 0n).equals(reserveAttestationPda(MINT, 1n))).toBe(false)
  })

  it('адреса залежить від програми, а не тільки від seeds', () => {
    expect(tokenConfigPda(MINT, OTHER_PROGRAM).equals(tokenConfigPda(MINT))).toBe(false)
  })

  // Формулу задає spl-tlv-account-resolution, і токен-програма шукає акаунт саме
  // за нею. Тест тримає її на видноті: розбіжність робить переказ неможливим.
  it('ExtraAccountMetaList — `["extra-account-metas", mint]` під програмою хука', () => {
    const [expected] = PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('extra-account-metas'), MINT.toBytes()],
      PROGRAM_ID,
    )
    expect(extraAccountMetaListPda(MINT).equals(expected)).toBe(true)
  })
})

describe('клієнт програми', () => {
  const program = createForgeProgram(new Connection('http://127.0.0.1:8899'))

  it('адреса програми — з IDL, одна на пакет', () => {
    expect(PROGRAM_ID.toBase58()).toBe(IDL.address)
    expect(program.programId.equals(PROGRAM_ID)).toBe(true)
  })

  it('IDL дає типізовані інструкції й акаунти', () => {
    expect(typeof program.methods.initializeIssuer).toBe('function')
    expect(program.account.issuerConfig).toBeDefined()
  })

  /**
   * Головна перевірка вендорованого IDL: Anchor резолвить `issuer_config` за
   * seeds, які оголосила **програма**, а `issuerConfigPda` — за нашими. Збіг
   * означає, що копія IDL і pda.ts описують ту саму адресу; розбіжність тут —
   * єдине місце, де її видно без мережі.
   */
  it('резолюція за IDL збігається з issuerConfigPda', async () => {
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
