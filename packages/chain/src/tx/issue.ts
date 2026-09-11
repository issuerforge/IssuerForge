// Випуск токена — три транзакції, а не одна (FR-001, борг T018).
//
// **Чому три.** `create_token` важить ~1180 із 1232 байтів: 384 байти політики,
// 13 акаунтів, два підписи. Ані рядки метаданих, ані перелік акаунтів хука туди
// не влізають, тож обидва йдуть окремо. Обидва вікна безпечні, але з різних
// причин, і різницю варто знати: без метаданих токен просто без назви, а без
// переліку акаунтів токен-програма **не може** резолвити хук — переказ не
// проходить узагалі.
//
// **Адреси всіх трьох відомі до першої з них**: mint є PDA (`["mint", issuer_id,
// index]`), тож зібрати можна одразу все. Відправляти — по черзі: другій і
// третій потрібен `TokenConfig`, якого до підтвердження першої не існує.
//
// **Номер токена приходить аргументом, а не читається тут.** `IssuerConfig`
// читає той, у кого вже є Connection (маршрут API), а білдер лишається чистим.
// Наслідок гонки чесний: якщо номер за цей час зайняв інший випуск, транзакція
// впаде на вже існуючому акаунті — видимою відмовою, а не токеном-близнюком.
import { BN } from '@coral-xyz/anchor'
import { encodeRules } from '@forge/policy/layout'
import type { PolicyRules } from '@forge/policy/model'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token'
import type { PublicKey } from '@solana/web3.js'
import {
  extraAccountMetaListPda,
  holderStatusPda,
  issuerConfigPda,
  mintPda,
  policyConfigPda,
  reserveAttestationPda,
  tokenConfigPda,
  velocityCounterPda,
} from '../pda.ts'
import type { ForgeProgram } from '../program.ts'
import { type TxPlan, toPlan } from './plan.ts'

/** Номер першої версії політики. Її пише `create_token`; `set_policy` — з другої. */
export const FIRST_POLICY_VERSION = 1

/** Індекс першої атестації резерву. Її створює `create_token`. */
export const FIRST_ATTESTATION_INDEX = 0n

/**
 * Статус холдера у формі, яку приймає програма.
 *
 * `expiresAt` нуль означає «без строку», а не «протерміновано» — та сама
 * домовленість, що в `HolderStatus` і в оцінювачі правил.
 */
export type HolderStatusInput = {
  readonly tier: number
  readonly jurisdiction: string
  readonly denied: boolean
  readonly expiresAt: bigint
}

export type CreateTokenArgs = {
  readonly issuerId: PublicKey
  /**
   * `IssuerConfig.token_count` **до** випуску — номер, який займе цей токен.
   * Він же seed адреси mint, тож адреса відома до підписання.
   */
  readonly tokenIndex: number
  readonly founder: PublicKey
  readonly attestor: PublicKey
  readonly decimals: number
  readonly attestationCredential: PublicKey
  readonly attestationSchema: PublicKey
  readonly treasury: PublicKey
  readonly feeBps: number
  readonly attestationMaxAge: bigint
  /** Валюта резерву, вона ж валюта токена: 3–8 великих літер. */
  readonly reserveCurrency: string
  readonly policy: PolicyRules
  readonly initialSupply: bigint
  readonly reserveAmount: bigint
  readonly reserveAttestedAt: bigint
  readonly founderStatus: HolderStatusInput
}

/**
 * Валюта в тій формі, у якій її тримає акаунт: рівно вісім байтів, добиті
 * нулями. Довжину перевіряє програма, але зібрати неправильний масив тут — це
 * відмова на девнеті замість помилки в тесті.
 */
function currencyBytes(currency: string): number[] {
  const bytes = new TextEncoder().encode(currency)
  if (bytes.length === 0 || bytes.length > 8) {
    throw new RangeError(`currency must be 1 to 8 bytes: ${currency}`)
  }
  return [...bytes, ...new Array(8 - bytes.length).fill(0)]
}

/**
 * `bigint` → `BN`.
 *
 * Межа пакета навмисно тримає `bigint`: це рідний тип мови для u64, і саме він
 * приходить із `@forge/shared`. Anchor 0.32.1 усередині кодує через `BN`, тож
 * перетворення живе тут — рівно в одному місці, і `BN` не витікає в типи, які
 * читає консоль.
 */
const bn = (value: bigint): BN => new BN(value.toString())

function jurisdictionBytes(code: string): number[] {
  const bytes = new TextEncoder().encode(code)
  if (bytes.length !== 2) {
    throw new RangeError(`jurisdiction must be an alpha-2 code: ${code}`)
  }
  return [...bytes]
}

const toStatusInput = (status: HolderStatusInput) => ({
  tier: status.tier,
  jurisdiction: jurisdictionBytes(status.jurisdiction),
  denied: status.denied,
  expiresAt: bn(status.expiresAt),
})

/**
 * Адреси, які виводяться з випуску. Потрібні й білдерам, і консолі: майстер
 * показує адресу токена до підписання, бо вона вже відома.
 */
export function issuanceAddresses(issuerId: PublicKey, tokenIndex: number) {
  const mint = mintPda(issuerId, tokenIndex)
  return {
    mint,
    issuerConfig: issuerConfigPda(issuerId),
    tokenConfig: tokenConfigPda(mint),
    policyConfig: policyConfigPda(mint, FIRST_POLICY_VERSION),
    attestation: reserveAttestationPda(mint, FIRST_ATTESTATION_INDEX),
    extraAccountMetaList: extraAccountMetaListPda(mint),
  }
}

/**
 * Транзакція 1: mint із розширеннями, конфігурація, політика версії 1,
 * атестація резерву #0 і початкова емісія.
 *
 * Підписів два — засновник (він же платник) і атестатор. Кворуму немає: розбір
 * причини — у `SCRATCHPAD.md`, блок T018.
 */
export async function buildCreateToken(
  program: ForgeProgram,
  args: CreateTokenArgs,
): Promise<TxPlan> {
  const { mint, issuerConfig, tokenConfig, policyConfig, attestation } = issuanceAddresses(
    args.issuerId,
    args.tokenIndex,
  )

  const instruction = await program.methods
    .createToken({
      decimals: args.decimals,
      attestationCredential: args.attestationCredential,
      attestationSchema: args.attestationSchema,
      treasury: args.treasury,
      feeBps: args.feeBps,
      attestationMaxAge: bn(args.attestationMaxAge),
      reserveCurrency: currencyBytes(args.reserveCurrency),
      // Політика їде байтами, а не структурою: канонічне кодування — єдина
      // форма, у якій вона існує в акаунті, і саме її хешує програма.
      rules: Buffer.from(encodeRules(args.policy)),
      initialSupply: bn(args.initialSupply),
      reserveAmount: bn(args.reserveAmount),
      reserveAttestedAt: bn(args.reserveAttestedAt),
      founderStatus: toStatusInput(args.founderStatus),
    })
    .accountsPartial({
      founder: args.founder,
      attestor: args.attestor,
      issuerConfig,
      mint,
      tokenConfig,
      policyConfig,
      attestation,
      founderTokenAccount: getAssociatedTokenAddressSync(
        mint,
        args.founder,
        false,
        TOKEN_2022_PROGRAM_ID,
      ),
      holderStatus: holderStatusPda(mint, args.founder),
      velocityCounter: velocityCounterPda(mint, args.founder),
      // Токен-програма передається явно, хоч програма й приймає інтерфейс:
      // mint із розширеннями буває тільки в Token-2022, і помилка тут дала б
      // токен без жодного розширення, який виглядав би працюючим.
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .instruction()

  return toPlan('create-token', args.founder, [instruction])
}

export type SetTokenMetadataArgs = {
  readonly issuerId: PublicKey
  readonly mint: PublicKey
  readonly payer: PublicKey
  /** Адміністратор складу емітента. Платником бути не зобов'язаний. */
  readonly authority: PublicKey
  readonly name: string
  readonly symbol: string
  readonly uri: string
}

/** Транзакція 2: назва, символ і посилання в самому mint. */
export async function buildSetTokenMetadata(
  program: ForgeProgram,
  args: SetTokenMetadataArgs,
): Promise<TxPlan> {
  const instruction = await program.methods
    .setTokenMetadata({ name: args.name, symbol: args.symbol, uri: args.uri })
    .accountsPartial({
      issuerConfig: issuerConfigPda(args.issuerId),
      tokenConfig: tokenConfigPda(args.mint),
      mint: args.mint,
      payer: args.payer,
      authority: args.authority,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .instruction()

  return toPlan('token-metadata', args.payer, [instruction], true)
}

/**
 * Транзакція 3: перелік акаунтів, які токен-програма підкладатиме хуку.
 *
 * Без неї переказів немає взагалі — резолюція акаунтів хука падає на боці
 * токен-програми. Тому вона мусить пройти до першого переказу, і майстер не має
 * права показати токен готовим, доки її немає.
 */
export async function buildInitializeExtraAccountMetaList(
  program: ForgeProgram,
  args: { readonly mint: PublicKey; readonly payer: PublicKey },
): Promise<TxPlan> {
  const instruction = await program.methods
    .initializeExtraAccountMetaList()
    .accountsPartial({
      payer: args.payer,
      extraAccountMetaList: extraAccountMetaListPda(args.mint),
      tokenConfig: tokenConfigPda(args.mint),
      mint: args.mint,
    })
    .instruction()

  return toPlan('hook-accounts', args.payer, [instruction], true)
}

export type IssuanceArgs = CreateTokenArgs & {
  readonly name: string
  readonly symbol: string
  readonly uri: string
}

/**
 * Увесь випуск одним викликом: три плани в порядку відправки.
 *
 * Порядок несе сам результат, а не домовленість між викликачами: другий і
 * третій план мають `dependsOnPrevious`, тож майстер не може відправити їх
 * пачкою й отримати відмову «акаунта немає».
 */
export async function buildTokenIssuance(
  program: ForgeProgram,
  args: IssuanceArgs,
): Promise<TxPlan[]> {
  const { mint } = issuanceAddresses(args.issuerId, args.tokenIndex)

  return [
    await buildCreateToken(program, args),
    await buildSetTokenMetadata(program, {
      issuerId: args.issuerId,
      mint,
      payer: args.founder,
      authority: args.founder,
      name: args.name,
      symbol: args.symbol,
      uri: args.uri,
    }),
    await buildInitializeExtraAccountMetaList(program, { mint, payer: args.founder }),
  ]
}
