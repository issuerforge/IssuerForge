// Каталог сценаріїв симуляції (FR-004): «переказ верифікованому, неверифікованому,
// понад ліміт, на заборонену адресу, при паузі».
//
// **Сценарій виводиться з політики, а не описується поруч із нею.** П'ять імен
// із вимоги — це п'ять питань до правил, і відповідь на кожне залежить від того,
// які правила ввімкнені: «понад ліміт» без жодного ліміту — питання без змісту,
// а «понад ліміт» при ліміті на переказ і ліміті за період означає перший із
// них, бо він спрацює раніше. Тримати цю логіку в консолі означало б, що екран
// майстра й демо-сценарій (T024) розійдуться в тому, що вважати порушенням.
//
// **Каталог живе в `policy`, а не в `apps/api`.** Він будує `TransferContext` —
// тобто говорить мовою моделі правил, а не мовою HTTP; маршрут симуляції з нього
// лише читає. Побічний наслідок: та сама функція годиться і майстрові, і демо,
// і жодне з двох місць не вигадує власного «понад ліміт».
//
// **Сума верифікованого переказу — це рівно ліміт**, а не одиниця. Межа
// показова: поруч стоять «рівно ліміт — дозволено» і «ліміт плюс один —
// відмова», тож людина бачить, де саме проходить лінія, а не два числа без
// зв'язку. Політика без лімітів дає одиницю — найменшу суму, яка взагалі буває.
import {
  fromU64,
  toU64,
  U64_MAX,
  type U64String,
  unixSecondsSchema,
} from '@forge/shared/primitives'
import { z } from 'zod'
import {
  OPEN_TOKEN_STATE,
  type PartyContext,
  simulateTransfer,
  type TokenProgramState,
  type TransferContext,
  type TransferVerdict,
} from './evaluate.ts'
import { type PolicyRules, policyRulesSchema } from './model.ts'

/**
 * Імена сценаріїв у порядку FR-004. Порядок не декоративний: майстер показує
 * їх списком згори вниз, і вимога читається саме цим рядком.
 */
export const SCENARIO_NAMES = ['verified', 'unverified', 'over-limit', 'denied', 'paused'] as const

export type ScenarioName = (typeof SCENARIO_NAMES)[number]

export const scenarioNameSchema = z.enum(SCENARIO_NAMES)

/**
 * Юрисдикція учасників, коли політика країн не обмежує.
 *
 * Потрібна тому, що `HolderStatus` без країни не буває — поле обов'язкове в
 * обох джерелах. Коли правило юрисдикцій є, береться перша з дозволених, і тоді
 * ця константа не використовується взагалі.
 */
export const SIMULATED_JURISDICTION = 'UA'

/**
 * Версія політики в симуляції — та сама з обох боків.
 *
 * `POLICY_VERSION_MISMATCH` — це стан мережі (підсунутий не той `PolicyConfig`),
 * а не властивість правил, тож окремим сценарієм він тут не з'являється: майстер
 * питає «що робить моя політика», а не «що буде, якщо підмінити акаунт».
 */
const SIMULATED_POLICY_VERSION = 1

/** Сума верифікованого переказу, коли політика не має жодного ліміту. */
const MINIMAL_AMOUNT = 1n

/**
 * Один сценарій: питання до правил разом із тим, чим воно є для оцінювача.
 *
 * `applicable` — чи має сценарій зміст за цієї політики. Незастосовний сценарій
 * не ховається: «понад ліміт» при політиці без лімітів мусить бути видимим
 * рядком «ліміту немає — переказ дозволено», інакше майстер мовчки покаже
 * чотири сценарії з п'яти, і зникнення пʼятого прочитається як «усе гаразд».
 */
export type Scenario = {
  readonly name: ScenarioName
  readonly applicable: boolean
  readonly amount: U64String
  readonly context: TransferContext
  readonly token: TokenProgramState
}

export type ScenarioResult = Scenario & { readonly verdict: TransferVerdict }

/**
 * Сторона переказу в тому вигляді, у якому її бачить хук.
 *
 * Запис кладеться **тільки в ті джерела, які приймає правило**: джерело поза
 * переліком дало б `STATUS_SOURCE_NOT_ACCEPTED` — правильну відмову на неправильне
 * питання, бо сценарій «верифікований» питає не про це.
 *
 * `expiresAt: null` — запис без строку. Протермінування має власні коди й власні
 * фікстури (T019); підмішувати його в кожен сценарій означало б, що «понад
 * ліміт» одного дня почне відмовляти з іншої причини.
 */
function party(
  policy: PolicyRules,
  options: { readonly now: number; readonly known: boolean; readonly denied: boolean },
): PartyContext {
  const accepts = new Set(policy.status.sources)
  const record = {
    denied: options.denied,
    tier: policy.status.minTier,
    jurisdiction: policy.jurisdictions?.[0] ?? SIMULATED_JURISDICTION,
    expiresAt: null,
  }
  const known = (source: 'provider' | 'register') => options.known && accepts.has(source)

  return {
    provider: known('provider')
      ? { kind: 'record', record: { ...record, issuedAt: options.now } }
      : { kind: 'absent' },
    register: known('register') ? { kind: 'record', record } : { kind: 'absent' },
  }
}

/**
 * Ліміт, який спрацює першим, — найменший із чинних.
 *
 * Не «ліміт на переказ, а якщо його немає, то за період»: політика з обома
 * лімітами відхилить суму меншим із них, і сценарій «понад ліміт», побудований
 * від більшого, показав би відмову з коду, якого людина не очікує.
 */
function bindingLimit(policy: PolicyRules): bigint | undefined {
  const limits = [policy.transferLimit, policy.periodLimit?.amount]
    .filter((value): value is U64String => value !== undefined)
    .map(toU64)
  return limits.length === 0 ? undefined : limits.reduce((a, b) => (a < b ? a : b))
}

/** Контекст переказу: усе, крім того, що вирішує сам сценарій. */
function context(
  policy: PolicyRules,
  options: {
    readonly now: number
    readonly amount: bigint
    readonly recipient: PartyContext
  },
): TransferContext {
  return {
    sender: party(policy, { now: options.now, known: true, denied: false }),
    recipient: options.recipient,
    amount: fromU64(options.amount),
    // Лічильник відправника є рівно тоді, коли політика має ліміт за період:
    // його відсутність за такої політики — це `VELOCITY_COUNTER_MISSING`,
    // тобто стан рахунку, а не сценарій правил.
    velocity:
      policy.periodLimit === undefined
        ? undefined
        : { windowStart: options.now, spentInWindow: '0' },
    mintPolicyVersion: SIMULATED_POLICY_VERSION,
    policyVersion: SIMULATED_POLICY_VERSION,
    now: options.now,
  }
}

/**
 * Один сценарій за іменем.
 *
 * Політика проганяється через схему: нормалізація (порядок джерел, порядок
 * юрисдикцій) впливає на те, яку країну візьме сценарій, тож рахувати треба з
 * того самого значення, яке потім побачить оцінювач.
 */
export function buildScenario(rules: PolicyRules, name: ScenarioName, now: number): Scenario {
  const policy = policyRulesSchema.parse(rules)
  const at = unixSecondsSchema.parse(now)
  const limit = bindingLimit(policy)
  const withinLimit = limit ?? MINIMAL_AMOUNT
  const known = (denied = false) => party(policy, { now: at, known: true, denied })

  const scenario = (
    amount: bigint,
    recipient: PartyContext,
    token: TokenProgramState = OPEN_TOKEN_STATE,
    applicable = true,
  ): Scenario => ({
    name,
    applicable,
    amount: fromU64(amount),
    context: context(policy, { now: at, amount, recipient }),
    token,
  })

  switch (name) {
    case 'verified':
      return scenario(withinLimit, known())

    case 'unverified':
      return scenario(withinLimit, party(policy, { now: at, known: false, denied: false }))

    case 'over-limit': {
      // Ліміт у стелю u64 перевищити нічим: сценарію не існує, і вигадувати
      // йому суму означало б показати «дозволено» як відповідь на питання,
      // якого не поставили.
      const exceeds = limit !== undefined && limit < U64_MAX
      return scenario(exceeds ? withinLimit + 1n : withinLimit, known(), OPEN_TOKEN_STATE, exceeds)
    }

    case 'denied':
      return scenario(withinLimit, known(true))

    case 'paused':
      return scenario(withinLimit, known(), { ...OPEN_TOKEN_STATE, paused: true })
  }
}

/**
 * Увесь набір (або названа його частина) разом із вердиктами.
 *
 * `simulateTransfer`, а не `evaluateTransfer`: сценарій «при паузі» живе на шарі
 * токен-програми, і без нього п'ятірка з FR-004 неповна.
 */
export function simulateScenarios(
  rules: PolicyRules,
  options: { readonly now: number; readonly names?: readonly ScenarioName[] | undefined },
): ScenarioResult[] {
  const names = options.names ?? SCENARIO_NAMES
  return names.map((name) => {
    const scenario = buildScenario(rules, name, options.now)
    return { ...scenario, verdict: simulateTransfer(rules, scenario.context, scenario.token) }
  })
}
