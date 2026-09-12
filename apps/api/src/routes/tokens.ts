// Дві ручки майстра випуску: симуляція політики (FR-004) і збірка транзакцій
// випуску (FR-001).
//
// **Схеми тіл живуть тут, а не в `@forge/shared`.** Тіло випуску несе політику,
// тобто `policyRulesSchema` з `@forge/policy`, а `shared` — базовий пакет, від
// якого `policy` залежить сам; залежність назад зробила б цикл. Тому контракт
// оголошений там, де маршрут, і **експортується** з нього — консоль (T023) бере
// ці ж схеми, а не пише другий опис того самого тіла.
//
// **Ключів емітента тут немає.** `POST /api/tokens` не підписує й не відправляє:
// назовні йдуть три непідписані транзакції та перелік адрес, чиїх підписів їм
// бракує. Підписує гаманець у браузері.
//
// **Межі значень нижче — дзеркало `create_token.rs`.** Програма перевіряє все це
// сама й лишається авторитетом; тут перевірка стоїть, щоб помилка в майстрі була
// реченням у формі, а не відмовою девнета через півхвилини.
import {
  buildTokenIssuance,
  issuanceAddresses,
  MAX_TRANSACTION_BYTES,
  mintPda,
  toUnsigned,
  transactionBytes,
} from '@forge/chain'
import { jurisdictionSchema, policyRulesSchema, tierSchema } from '@forge/policy/model'
import { SCENARIO_NAMES, scenarioNameSchema, simulateScenarios } from '@forge/policy/scenarios'
import { hasRole, ROLE } from '@forge/shared/api'
import { addressSchema, toU64, u64Schema, unixSecondsSchema } from '@forge/shared/primitives'
import { zValidator } from '@hono/zod-validator'
import { PublicKey } from '@solana/web3.js'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ChainReader } from '../chain.ts'
import type { Directory, RosterEntry } from '../directory.ts'
import type { AppEnv } from '../env.ts'
import { internal, invalidInput, notFound, unauthorized } from '../errors.ts'
import type { IssuanceStore } from '../issuance.ts'

export interface TokenRouteDeps {
  chain: ChainReader
  directory: Directory
  issuance: IssuanceStore
  /** Годинник сервера. Підмінюється в тестах — час не є прихованим входом. */
  now: () => Date
}

// ─── Межі, узяті з програми ──────────────────────────────────────────────────

/** `MAX_NAME_LEN`, `MAX_SYMBOL_LEN`, `MAX_URI_LEN` з `create_token.rs`. */
export const MAX_NAME_BYTES = 32
export const MAX_SYMBOL_BYTES = 12
export const MAX_URI_BYTES = 200
/** `MAX_FEE_BPS`: сто відсотків у базисних пунктах. */
export const MAX_FEE_BPS = 10_000
/** Точність токена. Стеля — та сама, що `CHECK` у таблиці `tokens`. */
export const MAX_DECIMALS = 9

/**
 * Рядок, обмежений **байтами**, а не символами.
 *
 * Програма міряє `args.name.len()`, тобто довжину UTF-8. Перевірка по символах
 * пропустила б назву з кирилицею, яка вдвічі довша за дозволене, — і відмова
 * прийшла б із мережі після двох підписів.
 */
const bounded = (maxBytes: number, label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .refine(
      (value) => new TextEncoder().encode(value).length <= maxBytes,
      `${label} must be at most ${maxBytes} bytes`,
    )

/** `validate_currency` з `state/reserve.rs`: 3–8 великих латинських літер. */
const currencySchema = z
  .string()
  .regex(/^[A-Z]{3,8}$/, 'expected 3 to 8 uppercase letters, like USD or NGN')

// ─── POST /api/policy/simulate ───────────────────────────────────────────────

/**
 * Тіло симуляції: чернетка політики й, за бажанням, звужений набір сценаріїв.
 *
 * Сценарії названі іменами, а не описані контекстами: що таке «понад ліміт» за
 * цієї політики, вирішує каталог у `@forge/policy` (T021), і те саме число
 * бачать майстер і демо-сценарій. Клієнт, який складав би контексти сам, мав би
 * власну відповідь на це питання.
 */
export const simulatePolicyBodySchema = z.strictObject({
  policy: policyRulesSchema,
  /**
   * Стеля й заборона повторів — не педантизм, а межа роботи, яку запит замовляє.
   *
   * Перелік іменований і скінченний, тож більше за каталог попросити нема чого;
   * без стелі та сама назва, повторена 50 000 разів, коштувала б секунди
   * процесора й чотирьох мегабайтів відповіді на один запит (виміряно).
   * Дублікат — помилка клієнта, а не спосіб замовити сценарій двічі.
   */
  scenarios: z
    .array(scenarioNameSchema)
    .min(1)
    .max(SCENARIO_NAMES.length)
    .refine((names) => new Set(names).size === names.length, 'a scenario is named twice')
    .optional(),
})

export type SimulatePolicyBody = z.infer<typeof simulatePolicyBodySchema>

// ─── POST /api/tokens ────────────────────────────────────────────────────────

/**
 * Тіло випуску.
 *
 * **Невідоме поле — помилка, а не сміття.** Схема строга: `attestedat` замість
 * `attestedAt` інакше просто зникло б, і атестація резерву отримала б час
 * запиту замість дати звіту аудитора — тобто мовчки інше значення там, де вся
 * задача продукту в тому, щоб чисел не підміняли.
 *
 * Чого тут немає навмисно:
 * - **номера токена** — його диктує `issuer_config.token_count`, а не клієнт;
 * - **`issuer_id`** — він береться з сесії й не перекривається параметром (FR-036);
 * - **`denied` у статусі засновника** — емітент не заводить власного засновника
 *   в чорний список у мить випуску, а поле, яке завжди `false`, було б місцем,
 *   де випуск можна зробити непрацездатним одним зайвим полем у JSON.
 */
export const createTokenBodySchema = z
  .strictObject({
    name: bounded(MAX_NAME_BYTES, 'name'),
    symbol: bounded(MAX_SYMBOL_BYTES, 'symbol'),
    uri: bounded(MAX_URI_BYTES, 'uri'),
    decimals: z.number().int().min(0).max(MAX_DECIMALS),
    policy: policyRulesSchema,
    initialSupply: u64Schema,
    reserve: z.strictObject({
      amount: u64Schema,
      currency: currencySchema,
      /**
       * Коли резерв підтверджений. За замовчуванням — час запиту.
       *
       * Поле існує тому, що атестація буває зроблена раніше за випуск (звіт
       * підписали вчора), а програма порівнює саме цей момент із дозволеним
       * віком. Час із майбутнього вона відхиляє, і маршрут відхиляє його теж.
       */
      attestedAt: unixSecondsSchema.optional(),
    }),
    attestation: z.strictObject({
      credential: addressSchema,
      schema: addressSchema,
      /**
       * Скільки атестація резерву лишається чинною. Стелі немає: строк
       * призначає емітент зі своїм аудитором, і вигадана тут межа відкинула б
       * дійсний випуск із причини, якої немає в жодній вимозі.
       */
      maxAgeSeconds: z.number().int().positive(),
    }),
    fee: z.strictObject({
      treasury: addressSchema,
      bps: z.number().int().min(0).max(MAX_FEE_BPS),
    }),
    founderStatus: z.strictObject({
      tier: tierSchema,
      jurisdiction: jurisdictionSchema,
      /** Нуль — без строку, як і в самому `HolderStatus`. */
      expiresAt: unixSecondsSchema.default(0),
    }),
    /** Потрібні, лише коли в складі кілька адміністраторів або атестаторів. */
    founder: addressSchema.optional(),
    attestor: addressSchema.optional(),
  })
  // Та сама нерівність, що в `ReserveCheck`: обіг нульовий, тож уся емісія
  // мусить уміститись в атестований резерв (FR-022). Програма перевірить це
  // ще раз і лишається авторитетом.
  .refine((body) => toU64(body.initialSupply) <= toU64(body.reserve.amount), {
    error: 'initial supply exceeds the attested reserve',
    path: ['initialSupply'],
  })

export type CreateTokenBody = z.infer<typeof createTokenBodySchema>

// ─── Підписанти ──────────────────────────────────────────────────────────────

/**
 * Один із кандидатів на підпис.
 *
 * Адреси приходять зі складу, а не з тіла запиту: тіло може лише **звузити**
 * вибір до одного з уже доведених — те саме правило, за яким `X-Issuer-Id`
 * обирає орендаря серед членств (`session.ts`). Порожній перелік — не помилка
 * вибору, тож рішення про код відмови ухвалює викликач.
 */
function chooseSigner(
  candidates: readonly RosterEntry[],
  requested: string | undefined,
  label: string,
): string | undefined {
  const wallets = candidates.map((entry) => entry.wallet)
  if (wallets.length === 0) return undefined

  if (requested === undefined) {
    const only = wallets[0]
    if (wallets.length === 1 && only !== undefined) return only
    throw invalidInput(`this issuer has several wallets that can sign as ${label}: name one`, {
      [label]: wallets,
    })
  }

  if (!wallets.includes(requested)) {
    throw invalidInput(`the wallet named as ${label} cannot sign in that role`, {
      [label]: wallets,
    })
  }
  return requested
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

    return c.json({
      now,
      scenarios: simulateScenarios(policy, { now, names: scenarios }).map((scenario) => ({
        name: scenario.name,
        applicable: scenario.applicable,
        amount: scenario.amount,
        verdict: scenario.verdict,
      })),
    })
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
    })
  })

  return app
}
