// Емісія понад атестований резерв — вимір SC-005 (частково, як його несе M1).
//
// **Перевірка одна на всі шляхи появи токенів** (T055): і початковий випуск у
// `create_token`, і майбутня `mint` проходять ту саму нерівність. На M1 існує
// лише перший шлях, тож саме він і міряється: десять спроб випустити більше,
// ніж атестовано, і жодна не має пройти.
import { buildTokenIssuance } from '@forge/chain'
import type { PolicyRules } from '@forge/policy/model'
import type { PublicKey } from '@solana/web3.js'
import { chainTime, type DemoContext } from './context.ts'
import { expectRefusal, PassedThrough, type Refused } from './send.ts'

export interface ReserveReport {
  readonly attempts: number
  readonly refused: number
  readonly codes: readonly (string | undefined)[]
}

/**
 * Усі спроби беруть **той самий** номер токена — наступний вільний.
 *
 * Спокуса дати кожній свій номер веде в хибний вимір: `create_token` виводить
 * seeds mint із `issuer_config.token_count`, а не з аргументу, тож друга спроба
 * з номером `2` падає на `ConstraintSeeds` — тобто на невідповідності адреси, а
 * не на резерві. Так перший прогін і дав дев'ять «відмов» не тієї природи.
 * Жодна спроба не проходить, лічильник не рухається, і номер лишається вільним.
 */
export async function attemptOverReserve(
  context: DemoContext,
  issuerId: PublicKey,
  policy: PolicyRules,
  attempts: number,
  nextIndex: number,
): Promise<ReserveReport> {
  const { connection, program, keys } = context
  const codes: (string | undefined)[] = []
  let refused = 0

  for (let index = 0; index < attempts; index += 1) {
    const now = await chainTime(connection)
    const reserveAmount = 1_000_000n
    // Понад резерв рівно на одиницю: поруч видно лінію, а не два непов'язані
    // числа (те саме правило, що в каталозі сценаріїв T021).
    const initialSupply = reserveAmount + 1n

    const plans = await buildTokenIssuance(program, {
      issuerId,
      tokenIndex: nextIndex,
      founder: keys.founder.publicKey,
      attestor: keys.attestor.publicKey,
      decimals: 2,
      attestationCredential: keys.issuerId.publicKey,
      attestationSchema: keys.treasury.publicKey,
      treasury: keys.treasury.publicKey,
      feeBps: 0,
      attestationMaxAge: BigInt(24 * 3600),
      reserveCurrency: 'NGN',
      policy,
      initialSupply,
      reserveAmount,
      reserveAttestedAt: BigInt(now),
      founderStatus: { tier: 2, jurisdiction: 'NG', denied: false, expiresAt: 0n },
      name: `Over Reserve ${index}`,
      symbol: `OVR${index}`,
      uri: 'https://vantara.example/over.json',
    })

    const first = plans[0]
    if (first === undefined) throw new Error('the issuance builder produced no transaction')

    let refusal: Refused | undefined
    try {
      refusal = await expectRefusal(connection, keys.founder.publicKey, first.instructions, [
        keys.founder,
        keys.attestor,
      ])
    } catch (error) {
      if (!(error instanceof PassedThrough)) throw error
    }

    if (refusal !== undefined) refused += 1
    codes.push(refusal?.name)
  }

  return { attempts, refused, codes }
}
