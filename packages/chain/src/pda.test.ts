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
  //
  // Інструкція шукається **за іменем**, а не за індексом: Anchor упорядковує
  // перелік сам, і нова інструкція зсуває його — так цей тест уже раз падав на
  // `execute`, у якої першим акаунтом стоїть токен-акаунт без PDA.
  it('`issuer` збігається з тим, що оголошує IDL', () => {
    const instruction = IDL.instructions.find((ix) => ix.name === 'initializeIssuer')
    const account = instruction?.accounts.find((a) => a.name === 'issuerConfig')
    const declared = account && 'pda' in account ? account.pda.seeds[0] : undefined
    expect(declared && 'value' in declared ? Uint8Array.from(declared.value) : undefined).toEqual(
      SEED.issuer,
    )
  })

  it('решта міток — рівно те, що каже таблиця PLAN.md', () => {
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

describe('адреси PDA', () => {
  // Пін-значення: будь-яка зміна seeds або кодування ловиться тут, а не в
  // транзакції на девнеті.
  //
  // Значення перераховані один раз — коли `anchor keys sync` замінив заглушку
  // `ForgePo1icy111…` на справжню адресу програми перед першим деплоєм (T024).
  // Це єдина законна причина їх міняти: усе інше, що зрушить ці адреси, — це
  // зміна seeds, тобто саме те, що тест і ловить.
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
  ])('%s виводиться в закріплену адресу', (_name, actual, expected) => {
    expect(actual.toBase58()).toBe(expected)
  })

  // Ця мітка звіряється з програмою, а не з власною константою: `create_token`
  // оголошує seeds mint прямо в IDL, і розбіжність означала б, що клієнт шукає
  // токен не там, де його створює програма.
  it('`mint` збігається з тим, що оголошує IDL', () => {
    const instruction = IDL.instructions.find((ix) => ix.name === 'createToken')
    const account = instruction?.accounts.find((a) => a.name === 'mint')
    const declared = account && 'pda' in account ? account.pda.seeds[0] : undefined
    expect(declared && 'value' in declared ? Uint8Array.from(declared.value) : undefined).toEqual(
      SEED.mint,
    )
  })

  it('номер токена входить в адресу mint', () => {
    expect(mintPda(ISSUER_ID, 0).equals(mintPda(ISSUER_ID, 1))).toBe(false)
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
