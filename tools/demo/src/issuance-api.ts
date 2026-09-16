// Випуск через api — той самий шлях, яким іде майстер у браузері.
//
// Різниця з `issuance.ts` не в результаті, а в тому, **що саме міряється**.
// Прямий шлях збирає три транзакції в цьому ж процесі; тут їх збирає сервер,
// і в час SC-001 входить усе, що між: вхід, склад, резервація номера в базі,
// відповідь, і аж потім три підписи й три підтвердження.
//
// Транзакції приходять непідписаними (SC-012), а blockhash — один на всі три:
// людина підписує їх однією дією майстра, і три строки життя означали б, що
// третя протухає в черзі (рішення T021).
import type { CreateTokenBody } from '@forge/api/contracts'
import { fromBase64 } from '@forge/chain'
import type { PolicyRules } from '@forge/policy/model'
import { PublicKey } from '@solana/web3.js'
import type { ApiClient } from './api.ts'
import { chainTime, type DemoContext } from './context.ts'
import { type Sent, send } from './send.ts'

export interface ApiIssuanceInput {
  readonly decimals: number
  readonly policy: PolicyRules
  readonly initialSupply: bigint
  readonly reserveAmount: bigint
  readonly reserveCurrency: string
  readonly feeBps: number
  readonly attestationMaxAge: number
  readonly name: string
  readonly symbol: string
  readonly uri: string
}

export interface ApiIssuanceResult {
  readonly mint: PublicKey
  readonly tokenIndex: number
  readonly steps: readonly Sent[]
  /** Мілісекунди від запиту до api до підтвердження третьої транзакції. */
  readonly elapsedMs: number
  /** Скільки з них пішло на саму відповідь api — решта це мережа. */
  readonly apiMs: number
}

export async function issueViaApi(
  context: DemoContext,
  api: ApiClient,
  input: ApiIssuanceInput,
): Promise<ApiIssuanceResult> {
  const { connection, keys } = context

  // Час береться з ланцюга, а не з годинника хоста: `Clock::unix_timestamp`
  // виводиться зі слотів і відстає, а атестацію «з майбутнього» відхиляють і
  // маршрут, і програма (борг T021 №6).
  const attestedAt = await chainTime(connection)

  const body: CreateTokenBody = {
    name: input.name,
    symbol: input.symbol,
    uri: input.uri,
    decimals: input.decimals,
    policy: input.policy,
    initialSupply: input.initialSupply.toString(),
    reserve: {
      amount: input.reserveAmount.toString(),
      currency: input.reserveCurrency,
      attestedAt,
    },
    attestation: {
      // Фікстурні акредитив і схема — ті самі, що в прямому шляху: сервісу
      // атестацій немає, але адреси мусять бути справжніми ключами.
      credential: keys.issuerId.publicKey.toBase58(),
      schema: keys.treasury.publicKey.toBase58(),
      maxAgeSeconds: input.attestationMaxAge,
    },
    fee: { treasury: keys.treasury.publicKey.toBase58(), bps: input.feeBps },
    founderStatus: { tier: 2, jurisdiction: 'NG', expiresAt: 0 },
  }

  const startedAt = Date.now()
  const plan = await api.createToken(body)
  const apiMs = Date.now() - startedAt

  const signable = [keys.founder, keys.attestor]
  const steps: Sent[] = []

  for (const unsigned of plan.transactions) {
    const transaction = fromBase64(unsigned.base64)
    // Ключі добираються за адресами, які назвав сервер, а не за здогадом про
    // порядок: `signers` виведені з інструкцій (T020), і другий перелік тут
    // розійшовся б рівно тоді, коли інструкція отримає нового підписанта.
    transaction.sign(
      signable.filter((keypair) => unsigned.signers.includes(keypair.publicKey.toBase58())),
    )
    // Послідовно: `dependsOnPrevious` — заборона надіслати пачкою.
    steps.push(await send(connection, transaction))
  }

  return {
    mint: new PublicKey(plan.mint),
    tokenIndex: plan.tokenIndex,
    steps,
    elapsedMs: Date.now() - startedAt,
    apiMs,
  }
}
