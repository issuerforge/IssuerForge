// Випуск токена: три транзакції, як їх збирає майстер.
//
// **Проходить рівно тим шляхом, що й консоль** — тими самими білдерами T020,
// у тому самому порядку й із тією самою залежністю: друга й третя транзакції
// читають `TokenConfig`, якого до підтвердження першої не існує.
//
// Час від першої підпису до підтвердження третьої — це і є SC-001.
import { buildTokenIssuance, issuanceAddresses } from '@forge/chain'
import type { PolicyRules } from '@forge/policy/model'
import type { PublicKey } from '@solana/web3.js'
import { chainTime, type DemoContext } from './context.ts'
import type { Sent } from './send.ts'
import { submitPlan } from './send.ts'

export interface IssuanceInput {
  readonly issuerId: PublicKey
  readonly tokenIndex: number
  readonly decimals: number
  readonly policy: PolicyRules
  readonly initialSupply: bigint
  readonly reserveAmount: bigint
  readonly reserveCurrency: string
  readonly feeBps: number
  readonly attestationMaxAge: bigint
  readonly name: string
  readonly symbol: string
  readonly uri: string
}

export interface IssuanceResult {
  readonly addresses: ReturnType<typeof issuanceAddresses>
  readonly steps: readonly Sent[]
  /** Мілісекунди від першої відправки до підтвердження третьої (SC-001). */
  readonly elapsedMs: number
}

export async function issueToken(
  context: DemoContext,
  input: IssuanceInput,
): Promise<IssuanceResult> {
  const { connection, program, keys } = context
  const now = await chainTime(connection)

  const plans = await buildTokenIssuance(program, {
    issuerId: input.issuerId,
    tokenIndex: input.tokenIndex,
    founder: keys.founder.publicKey,
    attestor: keys.attestor.publicKey,
    decimals: input.decimals,
    // Акредитив і схема атестацій провайдера: у демо вони фікстурні, бо
    // сервісу атестацій на локальному валідаторі немає, а політика M1 читає
    // власний реєстр емітента. Адреси все одно мусять бути справжніми ключами —
    // програма їх зберігає й хук виводить із них акаунт.
    attestationCredential: keys.issuerId.publicKey,
    attestationSchema: keys.treasury.publicKey,
    treasury: keys.treasury.publicKey,
    feeBps: input.feeBps,
    attestationMaxAge: input.attestationMaxAge,
    reserveCurrency: input.reserveCurrency,
    policy: input.policy,
    initialSupply: input.initialSupply,
    reserveAmount: input.reserveAmount,
    reserveAttestedAt: BigInt(now),
    // Засновник отримує весь початковий випуск, тож його статус мусить
    // задовольняти власну політику — інакше токен нікуди не рухається.
    founderStatus: {
      tier: 2,
      jurisdiction: 'NG',
      denied: false,
      expiresAt: 0n,
    },
    name: input.name,
    symbol: input.symbol,
    uri: input.uri,
  })

  const startedAt = Date.now()
  const steps: Sent[] = []

  for (const plan of plans) {
    // Послідовно й з очікуванням: `dependsOnPrevious` у плані — це не примітка,
    // а заборона надіслати пачкою.
    steps.push(
      await submitPlan(
        connection,
        plan,
        // Підписанти виведені з інструкцій (T020); ключі добираються за
        // адресою, а не за здогадом про порядок.
        [keys.founder, keys.attestor].filter((keypair) =>
          plan.signers.some((signer) => signer.equals(keypair.publicKey)),
        ),
      ),
    )
  }

  return {
    addresses: issuanceAddresses(input.issuerId, input.tokenIndex),
    steps,
    elapsedMs: Date.now() - startedAt,
  }
}
