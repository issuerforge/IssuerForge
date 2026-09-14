// Дві ручки майстра випуску: симуляція політики (FR-004) і збірка транзакцій
// випуску (FR-001).
//
// **Схеми тіл і відповідей живуть у `../contracts/tokens.ts`.** Вони не можуть
// лежати в `@forge/shared` (тіло випуску несе політику, а `policy` залежить від
// `shared` сам — вийшов би цикл) і не мають лежати тут: консоль читає той самий
// контракт, і разом із ним затягнула б у бандл `hono`, `drizzle` і `postgres`.
// Маршрут лишає собі рівно обробники.
//
// **Ключів емітента тут немає.** `POST /api/tokens` не підписує й не відправляє:
// назовні йдуть три непідписані транзакції та перелік адрес, чиїх підписів їм
// бракує. Підписує гаманець у браузері.
//
import {
  buildTokenIssuance,
  issuanceAddresses,
  MAX_TRANSACTION_BYTES,
  mintPda,
  toUnsigned,
  transactionBytes,
} from '@forge/chain'
import { simulateScenarios } from '@forge/policy/scenarios'
import { hasRole, ROLE } from '@forge/shared/api'
import { toU64 } from '@forge/shared/primitives'
import { zValidator } from '@hono/zod-validator'
import { PublicKey } from '@solana/web3.js'
import { Hono } from 'hono'
import type { z } from 'zod'
import type { ChainReader } from '../chain.ts'
import {
  type CreateTokenResponse,
  createTokenBodySchema,
  type SimulatePolicyResponse,
  simulatePolicyBodySchema,
} from '../contracts/tokens.ts'
import type { Directory } from '../directory.ts'
import type { AppEnv } from '../env.ts'
import { internal, invalidInput, notFound, unauthorized } from '../errors.ts'
import type { IssuanceStore } from '../issuance.ts'
import { chooseSigner } from '../signers.ts'

// Реекспорт для тих, хто вже читав контракт звідси: тестам і консолі байдуже,
// у якому файлі він оголошений, а два шляхи імпорту одного значення — ні.
export {
  type CreateTokenBody,
  type CreateTokenResponse,
  createTokenBodySchema,
  createTokenResponseSchema,
  type SimulatePolicyBody,
  type SimulatePolicyResponse,
  simulatePolicyBodySchema,
  simulatePolicyResponseSchema,
} from '../contracts/tokens.ts'

export interface TokenRouteDeps {
  chain: ChainReader
  directory: Directory
  issuance: IssuanceStore
  /** Годинник сервера. Підмінюється в тестах — час не є прихованим входом. */
  now: () => Date
}

// ─── Маршрути ────────────────────────────────────────────────────────────────

export function createTokenRoutes(deps: TokenRouteDeps) {
  const app = new Hono<AppEnv>()

  /**
   * Помилка розбору тіла йде тим самим шляхом, що й решта: `onError` перетворює
   * `ZodError` на `INVALID_INPUT` зі списком полів. Без цього гачка валідатор
   * відповів би власним тілом, якого клієнт не вміє читати.
   */
  const body = <S extends z.ZodType>(schema: S) =>
    zValidator('json', schema, (result) => {
      if (!result.success) throw result.error
    })

  /**
   * Симуляція. У мережу не ходить і ролі не питає: це читання власної чернетки,
   * а не дія з коштами — будь-який учасник складу має право її побачити.
   */
  app.post('/policy/simulate', body(simulatePolicyBodySchema), (c) => {
    const { policy, scenarios } = c.req.valid('json')
    const now = Math.floor(deps.now().getTime() / 1000)

    // `satisfies` тут не косметика: відповідь і схема, яку читає консоль,
    // лежать у різних файлах, і без цього рядка поле, перейменоване тут,
    // виявилося б помилкою розбору в браузері, а не помилкою збірки.
    return c.json({
      now,
      scenarios: simulateScenarios(policy, { now, names: scenarios }).map((scenario) => ({
        name: scenario.name,
        applicable: scenario.applicable,
        amount: scenario.amount,
        verdict: scenario.verdict,
      })),
    } satisfies SimulatePolicyResponse)
  })

  /** Збірка випуску: три непідписані транзакції й адреси, відомі наперед. */
  app.post('/tokens', body(createTokenBodySchema), async (c) => {
    const input = c.req.valid('json')
    const session = c.get('session')
    const at = deps.now()
    const now = Math.floor(at.getTime() / 1000)

    const roster = await deps.directory.rosterFor(session.issuerId)

    // Засновник — адреса **цієї сесії** з роллю адміністратора: `create_token`
    // вимагає адміністратора складу, і чужу адресу сюди підставити не можна.
    const founder = chooseSigner(
      roster.filter(
        (entry) => hasRole(entry.roles, ROLE.ADMIN) && session.wallets.includes(entry.wallet),
      ),
      input.founder,
      'founder',
    )
    if (founder === undefined) {
      throw unauthorized('issuing a token requires an admin wallet of this issuer')
    }

    // Атестатор — будь-яка адреса складу з роллю атестатора: він підписує поруч,
    // а не входить у консоль. Без нього випуску не існує, бо перша атестація
    // резерву створюється тією ж транзакцією (FR-022).
    const attestor = chooseSigner(
      roster.filter((entry) => hasRole(entry.roles, ROLE.ATTESTOR)),
      input.attestor,
      'attestor',
    )
    if (attestor === undefined) {
      throw invalidInput('this issuer has no attestor in its roster; add one before issuing')
    }

    const attestedAt = input.reserve.attestedAt ?? now
    if (attestedAt > now) {
      throw invalidInput('the reserve attestation is dated in the future', { now })
    }
    // Випуск із уже протермінованою атестацією програма відхилить, і токен не
    // з'явиться взагалі. Сказати це до двох підписів — дешевше.
    if (now - attestedAt > input.attestation.maxAgeSeconds) {
      throw invalidInput('the reserve attestation would already be expired at issuance', {
        attestedAt,
        now,
        maxAgeSeconds: input.attestation.maxAgeSeconds,
      })
    }

    const issuerId = new PublicKey(session.issuerId)
    const tokenIndex = await deps.chain.tokenCount(issuerId)
    if (tokenIndex === undefined) {
      throw notFound('this issuer has no IssuerConfig on chain yet')
    }

    const mint = mintPda(issuerId, tokenIndex)
    const reservation = await deps.issuance.reserve({
      issuerId: session.issuerId,
      mint: mint.toBase58(),
      symbol: input.symbol,
      name: input.name,
      decimals: input.decimals,
      at,
    })
    if (reservation.kind === 'taken') {
      // Номер один на емітента, тож зайнятий номер — це не «спробуйте інший»:
      // назвати, хто його тримає й відколи, — єдина корисна відповідь.
      throw invalidInput('another issuance already holds the next token number', {
        mint: mint.toBase58(),
        tokenIndex,
        symbol: reservation.holder.symbol,
        name: reservation.holder.name,
        since: reservation.since.toISOString(),
      })
    }

    const plans = await buildTokenIssuance(deps.chain.program, {
      issuerId,
      tokenIndex,
      founder: new PublicKey(founder),
      attestor: new PublicKey(attestor),
      decimals: input.decimals,
      attestationCredential: new PublicKey(input.attestation.credential),
      attestationSchema: new PublicKey(input.attestation.schema),
      treasury: new PublicKey(input.fee.treasury),
      feeBps: input.fee.bps,
      attestationMaxAge: BigInt(input.attestation.maxAgeSeconds),
      reserveCurrency: input.reserve.currency,
      policy: input.policy,
      initialSupply: toU64(input.initialSupply),
      reserveAmount: toU64(input.reserve.amount),
      reserveAttestedAt: BigInt(attestedAt),
      founderStatus: {
        tier: input.founderStatus.tier,
        jurisdiction: input.founderStatus.jurisdiction,
        denied: false,
        expiresAt: BigInt(input.founderStatus.expiresAt),
      },
      name: input.name,
      symbol: input.symbol,
      uri: input.uri,
    })

    // **Blockhash один на всі три.** Людина підписує їх однією дією майстра, і
    // три різні строки життя означали б, що третя транзакція протухає раніше,
    // ніж дійде черга її підписати.
    const blockhash = await deps.chain.latestBlockhash()
    const transactions = plans.map((plan) => {
      const unsigned = toUnsigned(plan, blockhash)
      const bytes = transactionBytes(unsigned.transaction)
      // Найтісніше обмеження проєкту (T018). Транзакція, що переросла ліміт,
      // мусить упасти тут, поки видно, яка саме, — а не в мережі без пояснень.
      if (bytes > MAX_TRANSACTION_BYTES) {
        throw internal(`${plan.step} does not fit in a transaction`, {
          bytes,
          limit: MAX_TRANSACTION_BYTES,
        })
      }
      return {
        step: unsigned.step,
        base64: unsigned.base64,
        signers: unsigned.signers.map((signer) => signer.toBase58()),
        dependsOnPrevious: unsigned.dependsOnPrevious,
        bytes,
      }
    })

    const addresses = issuanceAddresses(issuerId, tokenIndex)

    // Зібраний, але непідписаний випуск у ончейн-журнал (FR-018) не потрапляє
    // ніколи — його там і не має бути. Рядок лога тут єдиний, хто пам'ятає, що
    // хтось займав номер під цю назву, і саме за ним пояснюється зайнятий номер.
    c.get('log').info(
      { mint: addresses.mint.toBase58(), tokenIndex, symbol: input.symbol, founder, attestor },
      'issuance assembled',
    )

    return c.json({
      tokenIndex,
      mint: addresses.mint.toBase58(),
      tokenConfig: addresses.tokenConfig.toBase58(),
      policyConfig: addresses.policyConfig.toBase58(),
      attestation: addresses.attestation.toBase58(),
      extraAccountMetaList: addresses.extraAccountMetaList.toBase58(),
      founder,
      attestor,
      blockhash,
      transactions,
    } satisfies CreateTokenResponse)
  })

  return app
}
