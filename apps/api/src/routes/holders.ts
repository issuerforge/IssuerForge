// Онбординг холдерів: черга, розморожування, власний реєстр статусів
// (FR-008a, FR-008b2).
//
// **Це перша делегована операція проєкту (FR-035b), і вона має два шляхи —
// рівно ті самі два, що має програма.** `authority::require_routine` (T016)
// приймає або операційний ключ платформи в межах `delegation_mask`, або
// уповноваженого учасника складу. Маршрут дзеркалить це: є делегація — API
// підписує сам і віддає підпис; немає — віддає **непідписану** транзакцію на
// гаманець учасника, і підписує консоль.
//
// Другий шлях існує не для симетрії. Делегація відкликається однією дією, і
// якби операційний ключ був єдиним, хто вміє розморожувати, відкликання
// заморозило б онбординг назавжди: емітент утратив би здатність діяти власними
// руками рівно тоді, коли вирішив, що платформі більше не довіряє.
//
// **Ончейн-половина закрита в T016, білдери — у T020.** Тут немає жодного
// правила й жодної інструкції: маршрут читає стан, обирає шлях підпису й
// віддає результат.
import {
  buildSetHolderStatus,
  buildThawHolder,
  MAX_TRANSACTION_BYTES,
  type TxPlan,
  toUnsigned,
  transactionBytes,
} from '@forge/chain'
import { jurisdictionSchema, tierSchema } from '@forge/policy/model'
import { DELEGATION, hasPower, hasRole, ROLE_AUTHORISING } from '@forge/shared/api'
import { addressSchema, unixSecondsSchema } from '@forge/shared/primitives'
import { zValidator } from '@hono/zod-validator'
import { PublicKey } from '@solana/web3.js'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ChainReader } from '../chain.ts'
import type { Directory } from '../directory.ts'
import type { AppEnv } from '../env.ts'
import { ApiProblem, internal, invalidInput, notFound, unauthorized } from '../errors.ts'
import {
  decideThaw,
  HOLDER_STATES,
  type HolderRow,
  type HolderStatusFields,
  type HolderStore,
  toExpiryDate,
  toUnixSeconds,
} from '../holders.ts'
import { type OperationalSigner, SubmitError } from '../operational.ts'
import { chooseSigner } from '../signers.ts'

export interface HolderRouteDeps {
  chain: ChainReader
  directory: Directory
  holders: HolderStore
  operational: OperationalSigner
  now: () => Date
}

/**
 * Скільки гаманців приймає пачка.
 *
 * Пачка — це N окремих транзакцій, а не одна велика (`thaw_holder` має дев'ять
 * акаунтів, і в 1232 байти їх влізло б три-чотири). Тож межа тут не байтова, а
 * часова: двадцять п'ять підтверджень поспіль — це десятки секунд, і довшу
 * чергу клієнт мусить розбити сам, поки видно, де вона зупинилась.
 */
export const MAX_BATCH_WALLETS = 25

// ─── Тіла й параметри ────────────────────────────────────────────────────────

/**
 * `expiresAt` — unix-секунди; `null`, нуль або відсутнє означають «без строку».
 *
 * Нуль приймається як синонім відсутності саме тому, що так це записано в
 * акаунті (`HolderStatus.expires_at`, T016): клієнт, який прочитав ончейн-запис
 * і надіслав його назад, не має отримати відмову за те, що прочитав правильно.
 */
const expirySchema = unixSecondsSchema.nullish()

export const queueHolderBodySchema = z.strictObject({
  wallet: addressSchema,
  tier: tierSchema,
  jurisdiction: jurisdictionSchema,
  expiresAt: expirySchema,
})

export const holderStatusBodySchema = z.strictObject({
  tier: tierSchema,
  jurisdiction: jurisdictionSchema,
  // Явне поле, а не «відсутнє означає ні»: заборона — найсуворіше, що вміє
  // реєстр (FR-008a1), і знімати її пропуском поля не можна.
  denied: z.boolean(),
  expiresAt: expirySchema,
})

export const thawBatchBodySchema = z.strictObject({
  wallets: z
    .array(addressSchema)
    .min(1)
    .max(MAX_BATCH_WALLETS)
    // Повтор у списку для ланцюга нешкідливий (друге розморожування нічого не
    // робить), але у звіті він дав би два рядки на один рахунок — і офіцер
    // порахував би чергу неправильно.
    .refine((wallets) => new Set(wallets).size === wallets.length, 'wallets must be unique'),
})

/**
 * Підписант приходить параметром запиту, а не полем тіла, і це не косметика.
 *
 * Він не є частиною дії: дія — «розморозити цей рахунок», і вона однакова
 * незалежно від того, чиїм підписом виконана. Параметр лише **звужує** вибір
 * серед адрес, які склад уже назвав уповноваженими, і заразом дає єдину форму
 * трьом ручкам, одна з яких тіла не має взагалі.
 *
 * Названий підписант **вимикає делегацію** для цього запиту: емітент, який
 * назвав свій гаманець, сказав «підпишу сам», а не «підпиши за мене».
 */
export const signerQuerySchema = z.object({ signer: addressSchema.optional() })

export const holderQuerySchema = z.object({ state: z.enum(HOLDER_STATES).optional() })

// ─── Шлях підпису ────────────────────────────────────────────────────────────

/**
 * Хто підписує цей запит — і все, що для цього потрібно.
 *
 * Блокхеш лежить у самому шляху, а не поруч: непідписані транзакції пачки їдуть
 * до консолі однією відповіддю, і різні строки життя означали б, що останні
 * протухають, поки людина підписує перші (те саме рішення, що для трьох
 * транзакцій випуску, T021).
 */
type SigningPath =
  | { readonly mode: 'delegated' }
  | { readonly mode: 'member'; readonly signer: string; readonly blockhash: string }

type OutcomeKind = 'thawed' | 'updated' | 'unsigned' | 'failed'

interface Outcome {
  readonly wallet: string
  readonly outcome: OutcomeKind
}

export function createHolderRoutes(deps: HolderRouteDeps) {
  const app = new Hono<AppEnv>()

  const body = <S extends z.ZodType>(schema: S) =>
    zValidator('json', schema, (result) => {
      if (!result.success) throw result.error
    })

  const query = <S extends z.ZodType>(schema: S) =>
    zValidator('query', schema, (result) => {
      if (!result.success) throw result.error
    })

  /**
   * Токен, якого немає в цього емітента, не існує **для цієї сесії**.
   *
   * `NOT_FOUND`, а не `UNAUTHORIZED`: різниця між «чужий mint» і «неіснуючий»
   * розповідала б про чужі дані тому, хто перебирає адреси (FR-036, SC-011).
   */
  const requireToken = async (issuerId: string, mint: string) => {
    if (!(await deps.holders.ownsToken(issuerId, mint))) {
      throw notFound('this issuer has no such token')
    }
  }

  /** Розморожування й статуси — дія, а не читання: спостерігач їх не робить. */
  const requireAuthorising = (roles: number) => {
    if (!hasRole(roles, ROLE_AUTHORISING)) {
      throw unauthorized('this role cannot onboard holders')
    }
  }

  /**
   * Хто підпише — вирішується **один раз на запит**, а не на кожен гаманець:
   * `IssuerConfig` один на емітента, і пачка, у якої половина рахунків пішла
   * делегацією, а половина повернулась транзакціями, була б відповіддю, яку
   * нема як показати.
   */
  const signingPath = async (
    issuerId: string,
    wallets: readonly string[],
    power: number,
    requested: string | undefined,
  ): Promise<SigningPath> => {
    if (requested === undefined) {
      const config = await deps.chain.issuerConfig(new PublicKey(issuerId))
      if (config === undefined) throw notFound('this issuer has no IssuerConfig on chain yet')

      // Обидві умови обов'язкові: маска без збігу адрес означає, що емітент
      // делегував повноваження **іншому** ключу, і підписувати за нього нашим
      // було б рівно тим, чого FR-035a не дозволяє.
      if (
        config.operationalKey === deps.operational.publicKey.toBase58() &&
        hasPower(config.delegationMask, power)
      ) {
        return { mode: 'delegated' }
      }
    }

    const roster = await deps.directory.rosterFor(issuerId)
    const candidates = roster.filter(
      (entry) => hasRole(entry.roles, ROLE_AUTHORISING) && wallets.includes(entry.wallet),
    )
    const signer = chooseSigner(candidates, requested, 'signer')
    if (signer === undefined) {
      // Роль у сесії є — її вже перевірив `requireAuthorising`, — а адреси в
      // складі немає: або дзеркало складу відстало, або людина ввійшла іншим
      // гаманцем. Обидва випадки лікуються однаково: делегувати повноваження
      // або ввійти адресою, яка стоїть у складі.
      throw unauthorized(
        'the operational key cannot sign for this issuer, and no wallet of this session is in its roster',
        { power: powerLabel(power) },
      )
    }

    return { mode: 'member', signer, blockhash: await deps.chain.latestBlockhash() }
  }

  // ─── Черга ─────────────────────────────────────────────────────────────────

  /** Зарахування в чергу. Ланцюга не торкається: заявка — ще не дія. */
  app.post('/tokens/:mint/holders', body(queueHolderBodySchema), async (c) => {
    const session = c.get('session')
    const mint = addressParam(c.req.param('mint'), 'mint')
    requireAuthorising(session.roles)
    await requireToken(session.issuerId, mint)

    const input = c.req.valid('json')
    const queued = await deps.holders.enqueue({
      issuerId: session.issuerId,
      mint,
      wallet: input.wallet,
      tier: input.tier,
      jurisdiction: input.jurisdiction,
      expiresAt: toExpiryDate(input.expiresAt),
      at: deps.now(),
    })

    if (queued.kind === 'settled') {
      throw invalidInput('this account is already onboarded; change its status instead', {
        wallet: input.wallet,
        state: queued.row.state,
      })
    }

    return c.json({ holder: view(queued.row) })
  })

  /** Черга офіцера. Читання, тож ролі не питаємо — досить членства. */
  app.get('/tokens/:mint/holders', query(holderQuerySchema), async (c) => {
    const session = c.get('session')
    const mint = addressParam(c.req.param('mint'), 'mint')
    await requireToken(session.issuerId, mint)

    const rows = await deps.holders.list(session.issuerId, mint, c.req.valid('query').state)
    return c.json({ holders: rows.map(view) })
  })

  // ─── Розморожування ────────────────────────────────────────────────────────

  /**
   * Одне розморожування. Помилка тут — відмова запиту, а не рядок звіту:
   * гаманець названий у шляху, і «нуль із одного» замість причини означало б
   * 200 на дію, якої не сталося.
   */
  app.post('/tokens/:mint/holders/:wallet/thaw', query(signerQuerySchema), async (c) => {
    const session = c.get('session')
    const mint = addressParam(c.req.param('mint'), 'mint')
    const wallet = addressParam(c.req.param('wallet'), 'wallet')
    requireAuthorising(session.roles)
    await requireToken(session.issuerId, mint)

    const path = await signingPath(
      session.issuerId,
      session.wallets,
      DELEGATION.THAW_HOLDER,
      c.req.valid('query').signer,
    )

    const result = await thawOne(deps, session.issuerId, mint, wallet, path)
    return c.json({ ...describe(path), ...result })
  })

  /** Пачка: N транзакцій, звіт по кожній. Часткова відмова видима поіменно. */
  app.post(
    '/tokens/:mint/holders/thaw',
    query(signerQuerySchema),
    body(thawBatchBodySchema),
    async (c) => {
      const session = c.get('session')
      const mint = addressParam(c.req.param('mint'), 'mint')
      requireAuthorising(session.roles)
      await requireToken(session.issuerId, mint)

      const path = await signingPath(
        session.issuerId,
        session.wallets,
        DELEGATION.THAW_HOLDER,
        c.req.valid('query').signer,
      )

      const results: Outcome[] = []
      for (const wallet of c.req.valid('json').wallets) {
        try {
          // Послідовно, а не `Promise.all`: делегований шлях підписує одним
          // ключем, і паралельні транзакції одного платника з тим самим
          // блокхешем — це гонка за один слот, у якій частина зникає як дублі.
          results.push(await thawOne(deps, session.issuerId, mint, wallet, path))
        } catch (error) {
          results.push(failure(wallet, error))
        }
      }

      c.get('log').info({ mint, mode: path.mode, ...tally(results) }, 'holder thaw batch finished')
      return c.json({ ...describe(path), results })
    },
  )

  // ─── Реєстр статусів ───────────────────────────────────────────────────────

  /**
   * Оновлення власного реєстру (FR-008a, FR-008b1).
   *
   * Рахунок лишається таким, як був: ця дія нічого не морозить і нічого не
   * впускає — вона змінює те, що читає **кожен** переказ. Саме тому вона окрема
   * від розморожування й має власне повноваження в масці делегації.
   */
  app.post(
    '/tokens/:mint/holders/:wallet/status',
    query(signerQuerySchema),
    body(holderStatusBodySchema),
    async (c) => {
      const session = c.get('session')
      const mint = addressParam(c.req.param('mint'), 'mint')
      const wallet = addressParam(c.req.param('wallet'), 'wallet')
      requireAuthorising(session.roles)
      await requireToken(session.issuerId, mint)

      const input = c.req.valid('json')
      const status: HolderStatusFields = {
        tier: input.tier,
        jurisdiction: input.jurisdiction,
        denied: input.denied,
        expiresAt: input.expiresAt ?? null,
      }

      // `set_holder_status` акаунта не заводить (T016): запис створюється разом
      // із розморожуванням, бо статус без розмороженого рахунку нічого не
      // означає. Без цієї перевірки людина отримала б `AccountNotInitialized`.
      if (!(await deps.chain.holderStatusWritten(new PublicKey(mint), new PublicKey(wallet)))) {
        throw invalidInput('this account has no on-chain status yet; thaw it first', { wallet })
      }

      const path = await signingPath(
        session.issuerId,
        session.wallets,
        DELEGATION.SET_HOLDER_STATUS,
        c.req.valid('query').signer,
      )

      const plan = await buildSetHolderStatus(deps.chain.program, {
        issuerId: new PublicKey(session.issuerId),
        mint: new PublicKey(mint),
        wallet: new PublicKey(wallet),
        authority: authorityOf(deps, path),
        status: toBuilderStatus(status),
      })

      const dispatched = await dispatch(deps, plan, path)
      if (path.mode === 'delegated') {
        // Дзеркало пишеться **після** підтвердження: рядок, оновлений наперед,
        // розійшовся б із ланцюгом рівно там, де транзакція не пройшла.
        await deps.holders.saveStatus({
          issuerId: session.issuerId,
          mint,
          wallet,
          status,
          at: deps.now(),
        })
      }

      return c.json({
        ...describe(path),
        wallet,
        outcome: path.mode === 'delegated' ? 'updated' : 'unsigned',
        ...dispatched,
      })
    },
  )

  return app
}

// ─── Одне розморожування ─────────────────────────────────────────────────────

async function thawOne(
  deps: HolderRouteDeps,
  issuerId: string,
  mint: string,
  wallet: string,
  path: SigningPath,
) {
  const mintKey = new PublicKey(mint)
  const walletKey = new PublicKey(wallet)

  // Порядок значущий: «чи писали запис» питається в ланцюга, і саме ця
  // відповідь вирішує, чи несе транзакція статус. База лише постачає значення.
  const written = await deps.chain.holderStatusWritten(mintKey, walletKey)
  const intent = decideThaw(await deps.holders.get(issuerId, mint, wallet), written)

  if (intent.kind === 'refuse') {
    throw intent.reason === 'not-queued'
      ? notFound('this account is not in the thaw queue; add it first', { wallet })
      : invalidInput('this queue entry has no tier or jurisdiction to write', { wallet })
  }

  const authority = authorityOf(deps, path)
  const plan = await buildThawHolder(deps.chain.program, {
    issuerId: new PublicKey(issuerId),
    mint: mintKey,
    wallet: walletKey,
    // Платник і санкціонувач — одна адреса: оренду двох акаунтів (`HolderStatus`
    // і `VelocityCounter`) платить той, хто підписує. У делегованому шляху це
    // платформа, і це прямий наслідок делегації, а не окреме рішення.
    payer: authority,
    authority,
    status: intent.kind === 'first' ? toBuilderStatus(intent.status) : null,
  })

  const dispatched = await dispatch(deps, plan, path)
  if (path.mode === 'delegated') {
    await deps.holders.markThawed({
      issuerId,
      mint,
      wallet,
      // Дзеркало отримує статус лише тоді, коли його писала й транзакція:
      // повторне розморожування ончейн-запису не чіпає (T016).
      status: intent.kind === 'first' ? intent.status : undefined,
      at: deps.now(),
    })
  }

  const outcome: OutcomeKind = path.mode === 'delegated' ? 'thawed' : 'unsigned'
  return { wallet, outcome, ...dispatched }
}

// ─── Дрібні перетворення ─────────────────────────────────────────────────────

function authorityOf(deps: HolderRouteDeps, path: SigningPath): PublicKey {
  return path.mode === 'delegated' ? deps.operational.publicKey : new PublicKey(path.signer)
}

/** План → підпис (делеговано) або непідписана транзакція (гаманцем складу). */
async function dispatch(deps: HolderRouteDeps, plan: TxPlan, path: SigningPath) {
  if (path.mode === 'member') {
    const unsigned = toUnsigned(plan, path.blockhash)
    const bytes = transactionBytes(unsigned.transaction)
    // Та сама перевірка, що на випуску (T021): транзакція, яка переросла ліміт,
    // мусить упасти тут, поки видно, яка саме.
    if (bytes > MAX_TRANSACTION_BYTES) {
      throw internal(`${plan.step} does not fit in a transaction`, {
        bytes,
        limit: MAX_TRANSACTION_BYTES,
      })
    }

    return {
      transaction: {
        step: unsigned.step,
        base64: unsigned.base64,
        signers: unsigned.signers.map((signer) => signer.toBase58()),
        dependsOnPrevious: unsigned.dependsOnPrevious,
        bytes,
      },
    }
  }

  try {
    return { signature: await deps.operational.submit(plan) }
  } catch (error) {
    throw asProblem(error)
  }
}

/**
 * Відмова програми — це відповідь про стан ланцюга, а не збій API.
 *
 * Тому вона стає `INVALID_INPUT` із власним текстом програми: «повноваження не
 * делеговане» треба показати людині дослівно. Усе, що не розібралося в код
 * програми, — мережа, і це вже `INTERNAL`.
 */
function asProblem(error: unknown): unknown {
  if (!(error instanceof SubmitError)) return error
  if (error.program === undefined) return internal(error.message, { cause: 'network' })

  return invalidInput(error.program.message, {
    program: { code: error.program.code, name: error.program.name },
  })
}

function failure(wallet: string, error: unknown): Outcome & { error: Record<string, string> } {
  // Не `ApiProblem` — це не відмова однієї заявки, а зламаний запит цілком
  // (битий JSON, впала база). Ковтати таке в рядок звіту означало б 200 на
  // пачку, з якої нічого не могло вийти.
  if (!(error instanceof ApiProblem)) throw error

  return { wallet, outcome: 'failed', error: { code: error.code, message: error.message } }
}

function tally(results: readonly Outcome[]) {
  return {
    ok: results.filter((result) => result.outcome !== 'failed').length,
    failed: results.filter((result) => result.outcome === 'failed').length,
  }
}

/** Спільна «шапка» відповіді: як підписано і чим — для непідписаного шляху. */
function describe(path: SigningPath) {
  return path.mode === 'delegated'
    ? { mode: 'delegated' as const }
    : { mode: 'member' as const, signer: path.signer, blockhash: path.blockhash }
}

function view(row: HolderRow) {
  return {
    wallet: row.wallet,
    state: row.state,
    tier: row.tier,
    jurisdiction: row.jurisdiction,
    denied: row.denied,
    expiresAt: row.expiresAt === null ? null : toUnixSeconds(row.expiresAt),
    requestedAt: row.requestedAt.toISOString(),
    thawedAt: row.thawedAt === null ? null : row.thawedAt.toISOString(),
  }
}

/** Форма статусу, яку приймають білдери T020: `bigint`, нуль — «без строку». */
function toBuilderStatus(status: HolderStatusFields) {
  return {
    tier: status.tier,
    jurisdiction: status.jurisdiction,
    denied: status.denied,
    expiresAt: BigInt(status.expiresAt ?? 0),
  }
}

function powerLabel(power: number): string {
  return power === DELEGATION.THAW_HOLDER ? 'THAW_HOLDER' : 'SET_HOLDER_STATUS'
}

/**
 * Адреса зі шляху перевіряється тією ж схемою, що й тіло.
 *
 * Без цього `new PublicKey('..')` кидає з надр web3.js, і 400 перетворюється на
 * 500 на найдешевшій із можливих помилок — одруківці в адресі.
 */
function addressParam(value: string | undefined, label: string): string {
  const parsed = addressSchema.safeParse(value)
  if (!parsed.success) throw invalidInput(`${label} is not a base58 address`)
  return parsed.data
}
