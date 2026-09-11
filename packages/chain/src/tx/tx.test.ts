import { encodeRules } from '@forge/policy/layout'
import { OPEN_POLICY } from '@forge/policy/model'
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { Connection, PublicKey, type TransactionInstruction } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { extraAccountMetaListPda, mintPda, tokenConfigPda } from '../pda.ts'
import { createForgeProgram } from '../program.ts'
import { buildSetHolderStatus, buildThawHolder } from './holders.ts'
import {
  buildCreateToken,
  buildInitializeExtraAccountMetaList,
  buildSetTokenMetadata,
  buildTokenIssuance,
  type CreateTokenArgs,
  type IssuanceArgs,
  issuanceAddresses,
} from './issue.ts'
import {
  compileTransaction,
  fromBase64,
  MAX_TRANSACTION_BYTES,
  type TxPlan,
  transactionBytes,
} from './plan.ts'

// Адреса ноди тут не використовується: жоден білдер випуску в мережу не ходить,
// а `Program` потребує провайдера лише для відправки, якої пакет не робить.
const program = createForgeProgram(new Connection('http://127.0.0.1:8899'))

const ISSUER_ID = new PublicKey('11111111111111111111111111111112')
const FOUNDER = new PublicKey('SysvarC1ock11111111111111111111111111111111')
const ATTESTOR = new PublicKey('SysvarRent111111111111111111111111111111111')
const TREASURY = new PublicKey('SysvarRecentB1ockHashes11111111111111111111')
const CREDENTIAL = new PublicKey('SysvarS1otHashes111111111111111111111111111')
const SCHEMA = new PublicKey('SysvarS1otHistory11111111111111111111111111')

/**
 * Єдина інструкція плану.
 *
 * Не зручність: усі плани T020 складаються рівно з однієї інструкції, і друга,
 * додана колись, змінила б розмір транзакції мовчки. Тому перевірка стоїть тут,
 * а не повторюється в кожному тесті.
 */
function only(plan: TxPlan): TransactionInstruction {
  const [instruction, ...rest] = plan.instructions
  if (instruction === undefined || rest.length > 0) {
    throw new Error(`${plan.step}: очікувалась рівно одна інструкція`)
  }
  return instruction
}

/** Адреса акаунта за позицією. Позиція значуща: її задає програма, не ми. */
function keyAt(plan: TxPlan, index: number): PublicKey {
  const key = only(plan).keys[index]
  if (key === undefined) throw new RangeError(`${plan.step}: немає акаунта ${index}`)
  return key.pubkey
}

/** Чужий blockhash — компіляція від нього не залежить, а розмір залежить лише від довжини. */
const BLOCKHASH = 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq2h'

const createArgs = (over: Partial<CreateTokenArgs> = {}): CreateTokenArgs => ({
  issuerId: ISSUER_ID,
  tokenIndex: 0,
  founder: FOUNDER,
  attestor: ATTESTOR,
  decimals: 2,
  attestationCredential: CREDENTIAL,
  attestationSchema: SCHEMA,
  treasury: TREASURY,
  feeBps: 25,
  attestationMaxAge: 604_800n,
  reserveCurrency: 'NGN',
  policy: OPEN_POLICY,
  initialSupply: 1_000_000n,
  reserveAmount: 1_000_000n,
  reserveAttestedAt: 1_800_000_000n,
  founderStatus: { tier: 3, jurisdiction: 'NG', denied: false, expiresAt: 0n },
  ...over,
})

const issuanceArgs = (over: Partial<IssuanceArgs> = {}): IssuanceArgs => ({
  ...createArgs(),
  name: 'Naira Stable',
  symbol: 'NGNS',
  uri: 'https://issuerforge.example/token/ngns.json',
  ...over,
})

describe('випуск токена', () => {
  it('складається з тих самих акаунтів, що оголошує програма', async () => {
    const plan = await buildCreateToken(program, createArgs())
    const { mint, issuerConfig, tokenConfig, policyConfig, attestation } = issuanceAddresses(
      ISSUER_ID,
      0,
    )

    const keys = only(plan).keys.map((key) => key.pubkey.toBase58())
    // Тринадцять акаунтів — те число, під яке рахований бюджет транзакції
    // (SCRATCHPAD.md, блок T018). Чотирнадцятий не поміститься мовчки.
    expect(keys).toHaveLength(13)
    expect(keys.slice(0, 7)).toEqual(
      [FOUNDER, ATTESTOR, issuerConfig, mint, tokenConfig, policyConfig, attestation].map((key) =>
        key.toBase58(),
      ),
    )
    // Token-2022 передається явно: mint із розширеннями в старій токен-програмі
    // не буває, а токен без розширень виглядав би працюючим.
    expect(keys).toContain(TOKEN_2022_PROGRAM_ID.toBase58())
  })

  it('підписантів двоє, і вони виведені з інструкції', async () => {
    const plan = await buildCreateToken(program, createArgs())
    expect(plan.signers.map((key) => key.toBase58())).toEqual([
      FOUNDER.toBase58(),
      ATTESTOR.toBase58(),
    ])
    expect(plan.feePayer.toBase58()).toBe(FOUNDER.toBase58())
  })

  /**
   * Найважливіший тест пакета. Бюджет транзакції — найтісніше обмеження
   * проєкту: T018 порахував ~1180 із 1232 **на папері**, і тут це число
   * нарешті міряється, а не оцінюється. Політика взята найкоротша (`OPEN_POLICY`),
   * але вона все одно займає всі 384 байти: масив слотів фіксованої довжини.
   */
  it('уміщається в транзакцію — той самий бюджет, що рахував T018', async () => {
    const plan = await buildCreateToken(program, createArgs())
    const size = transactionBytes(compileTransaction(plan, BLOCKHASH))

    expect(size).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES)
    // Запас називається числом навмисно: якщо він зникне, це має бути видно в
    // діффі тесту, а не в невдалій транзакції на девнеті.
    expect(MAX_TRANSACTION_BYTES - size).toBeGreaterThan(20)
  })

  it('транзакція версійна, з порожнім переліком таблиць адрес', async () => {
    const plan = await buildCreateToken(program, createArgs())
    const transaction = compileTransaction(plan, BLOCKHASH)

    expect(transaction.version).toBe(0)
    expect(transaction.message.addressTableLookups).toEqual([])
  })

  /**
   * Два підписи `create_token` ставлять різні гаманці, тож транзакція їздить
   * між ними рядком. Круг мусить давати ті самі байти: підпис стосується
   * конкретних байтів, і транзакція, зібрана вдруге, була б іншою.
   */
  it('переживає круг через транспортну форму без змін', async () => {
    const plan = await buildCreateToken(program, createArgs())
    const transaction = compileTransaction(plan, BLOCKHASH)
    const base64 = Buffer.from(transaction.serialize()).toString('base64')

    expect(Buffer.from(fromBase64(base64).serialize())).toEqual(
      Buffer.from(transaction.serialize()),
    )
  })

  it('політика їде канонічними байтами, а не структурою', async () => {
    const plan = await buildCreateToken(program, createArgs())
    const data = only(plan).data
    const encoded = Buffer.from(encodeRules(OPEN_POLICY))

    expect(encoded).toHaveLength(384)
    expect(data.includes(encoded)).toBe(true)
  })

  it('номер токена входить в адресу mint, тож два випуски не збігаються', async () => {
    const first = await buildCreateToken(program, createArgs({ tokenIndex: 0 }))
    const second = await buildCreateToken(program, createArgs({ tokenIndex: 1 }))

    expect(keyAt(first, 3).equals(mintPda(ISSUER_ID, 0))).toBe(true)
    expect(keyAt(second, 3).equals(mintPda(ISSUER_ID, 1))).toBe(true)
  })
})

describe('випуск — це три транзакції', () => {
  it('вони йдуть у порядку відправки, і порядок несе сам результат', async () => {
    const plans = await buildTokenIssuance(program, issuanceArgs())

    expect(plans.map((plan) => plan.step)).toEqual([
      'create-token',
      'token-metadata',
      'hook-accounts',
    ])
    // Друга й третя читають `TokenConfig`, якого до підтвердження першої не
    // існує. Прапорець тут — щоб майстер не міг відправити їх пачкою.
    expect(plans.map((plan) => plan.dependsOnPrevious)).toEqual([false, true, true])
  })

  it('усі три адресують той самий токен, відомий до першої з них', async () => {
    const plans = await buildTokenIssuance(program, issuanceArgs())
    const mint = mintPda(ISSUER_ID, 0)

    const [create, metadata, hook] = plans
    const holds = (plan: TxPlan | undefined, address: PublicKey): boolean =>
      plan !== undefined && only(plan).keys.some((key) => key.pubkey.equals(address))

    expect(holds(create, mint)).toBe(true)
    expect(holds(metadata, tokenConfigPda(mint))).toBe(true)
    expect(holds(hook, extraAccountMetaListPda(mint))).toBe(true)
  })

  it('метадані й перелік акаунтів хука підписує один засновник', async () => {
    const [, metadata, hook] = await buildTokenIssuance(program, issuanceArgs())
    expect(metadata?.signers).toHaveLength(1)
    expect(hook?.signers).toHaveLength(1)
  })

  it('кожна з трьох уміщається в транзакцію', async () => {
    const plans = await buildTokenIssuance(program, issuanceArgs())
    for (const plan of plans) {
      expect(transactionBytes(compileTransaction(plan, BLOCKHASH))).toBeLessThanOrEqual(
        MAX_TRANSACTION_BYTES,
      )
    }
  })

  it('найдовші допустимі метадані теж уміщаються', async () => {
    // Стелі задає програма (32/12/200); транзакція мусить тримати їх усі.
    const plan = await buildSetTokenMetadata(program, {
      issuerId: ISSUER_ID,
      mint: mintPda(ISSUER_ID, 0),
      payer: FOUNDER,
      authority: ATTESTOR,
      name: 'x'.repeat(32),
      symbol: 'y'.repeat(12),
      uri: `https://${'z'.repeat(180)}.example`,
    })

    expect(transactionBytes(compileTransaction(plan, BLOCKHASH))).toBeLessThanOrEqual(
      MAX_TRANSACTION_BYTES,
    )
    // Платник і той, хто санкціонує, — різні підписи: тут місце для цього є, на
    // відміну від `create_token`.
    expect(plan.signers).toHaveLength(2)
  })

  it('перелік акаунтів хука адресується під програмою хука', async () => {
    const mint = mintPda(ISSUER_ID, 0)
    const plan = await buildInitializeExtraAccountMetaList(program, { mint, payer: FOUNDER })
    expect(keyAt(plan, 1).equals(extraAccountMetaListPda(mint))).toBe(true)
  })
})

describe('онбординг холдера', () => {
  const mint = mintPda(ISSUER_ID, 0)

  it('розморожування підписують платник і той, хто санкціонує', async () => {
    const plan = await buildThawHolder(program, {
      issuerId: ISSUER_ID,
      mint,
      wallet: TREASURY,
      payer: FOUNDER,
      authority: ATTESTOR,
      status: { tier: 2, jurisdiction: 'NG', denied: false, expiresAt: 0n },
    })

    expect(plan.step).toBe('thaw-holder')
    expect(plan.signers.map((key) => key.toBase58())).toEqual([
      FOUNDER.toBase58(),
      ATTESTOR.toBase58(),
    ])
  })

  it('повторне розморожування йде без статусу', async () => {
    const plan = await buildThawHolder(program, {
      issuerId: ISSUER_ID,
      mint,
      wallet: TREASURY,
      payer: FOUNDER,
      authority: ATTESTOR,
      // `null` — «запис уже є, я його не чіпаю». Програма відхиляє розбіжність
      // між наміром і станом акаунта, тож форма тут значуща.
      status: null,
    })

    expect(plan.instructions).toHaveLength(1)
    expect(transactionBytes(compileTransaction(plan, BLOCKHASH))).toBeLessThanOrEqual(
      MAX_TRANSACTION_BYTES,
    )
  })

  it('зміна статусу не чіпає токен-акаунта — заморозка є окремою дією', async () => {
    const plan = await buildSetHolderStatus(program, {
      issuerId: ISSUER_ID,
      mint,
      wallet: TREASURY,
      authority: ATTESTOR,
      status: { tier: 1, jurisdiction: 'KE', denied: true, expiresAt: 0n },
    })

    expect(only(plan).keys).toHaveLength(4)
    expect(plan.signers.map((key) => key.toBase58())).toEqual([ATTESTOR.toBase58()])
  })

  it('юрисдикція не того розміру відхиляється при збірці, а не в мережі', async () => {
    await expect(
      buildSetHolderStatus(program, {
        issuerId: ISSUER_ID,
        mint,
        wallet: TREASURY,
        authority: ATTESTOR,
        status: { tier: 1, jurisdiction: 'NGA', denied: false, expiresAt: 0n },
      }),
    ).rejects.toThrow(RangeError)
  })
})

describe('валюта резерву', () => {
  it('добивається нулями до восьми байтів', async () => {
    const plan = await buildCreateToken(program, createArgs({ reserveCurrency: 'NGN' }))
    expect(only(plan).data.includes(Buffer.from([0x4e, 0x47, 0x4e, 0, 0, 0, 0, 0]))).toBe(true)
  })

  it('довша за вісім байтів відхиляється при збірці', async () => {
    await expect(
      buildCreateToken(program, createArgs({ reserveCurrency: 'TOOLONGXX' })),
    ).rejects.toThrow(RangeError)
  })
})
