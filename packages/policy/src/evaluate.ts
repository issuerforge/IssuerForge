// Оцінювач правил на TS: політика + контекст переказу → вердикт із кодом (FR-004).
//
// Це друга реалізація моделі, першу виконує хук на Rust (T015). Вона існує не
// «для зручності UI»: майстер показує результат до підписання, і показувати він
// має рівно те, що потім скаже ланцюг. Розходження двох реалізацій ловиться
// диференційними тестами на спільних фікстурах (SC-008, T019).
//
// **Вхід — дзеркало того, що бачить хук, а не зведений результат.** Статус
// кожної сторони приходить окремо з кожного джерела, у трьох станах
// (`unavailable` / `absent` / `record`), а не одним готовим «денайд/рівень/країна».
// Це навмисно дорожча форма: злиття двох джерел (FR-008a1) і протермінування
// атестації (FR-008a2) — це і є те, що доручено T013, і подавати їх уже
// зробленими означало б винести з-під диференційної звірки саме той крок, де дві
// реалізації розійдуться найтихіше.
//
// **Порядок перевірок сюди не переписується.** Він оголошений один раз у
// `REFUSAL_CODES` (`@forge/shared/refusal`) і повторений у `docs/PLAN.md` →
// «Порядок перевірок у хуку». Нижче код **іде** цим переліком, а не відтворює
// його: `CHECKS` — таблиця «код → перевірка», а цикл перебирає `REFUSAL_CODES`.
// Перевірка, дописана з новим кодом, стає на своє місце сама; переставити
// перевірки тут неможливо, бо переліку тут немає.
//
// **Пауза й заморозка сюди не входять.** `TRANSFERS_PAUSED` і `ACCOUNT_FROZEN`
// повертає токен-програма **до** виклику хука (`source: 'token-program'`,
// `hookIndex: null`), тож у `evaluateTransfer` немає ані таких полів, ані таких
// відповідей: її вхід — рівно домен хука, і саме тому фікстура T019 не може
// нести того, чого Rust-половина не бачить. Сценарій «при паузі» з FR-004
// виражає `simulateTransfer` — тонкий шар зверху.
import { toU64, u64Schema, unixSecondsSchema } from '@forge/shared/primitives'
import { REFUSAL_CODES, type RefusalCode, refusalCodeSchema } from '@forge/shared/refusal'
import { z } from 'zod'
import {
  jurisdictionSchema,
  type PolicyRules,
  policyRulesSchema,
  type StatusSource,
  tierSchema,
} from './model.ts'

// ─── Запис статусу ───────────────────────────────────────────────────────────

/**
 * Спільні поля запису про адресу: обидва джерела кажуть про неї те саме коло
 * речей, різними акаунтами.
 *
 * `denied` — заборона емітента або відкликана атестація. Вона діє з **будь-якого**
 * джерела, незалежно від того, чи приймає це джерело правило (FR-008a1): перелік
 * `sources` називає джерела, які можуть дозволити, і ніколи не звужує коло тих,
 * що можуть заборонити.
 *
 * `expiresAt` — власний строк запису (`HolderStatus.expires_at`, `Attestation.expiry`).
 * `null` означає «без строку», а не «протерміновано»: запис без строку — дійсний
 * стан обох джерел.
 */
const statusFields = {
  denied: z.boolean(),
  tier: tierSchema,
  jurisdiction: jurisdictionSchema,
  expiresAt: unixSecondsSchema.nullable(),
}

/** Запис із власного реєстру емітента — `HolderStatus` PDA. */
export const registerStatusSchema = z.object(statusFields)

/**
 * Атестація провайдера — акаунт SAS, який хук читає напряму (спайк T057).
 *
 * `issuedAt` є тільки тут, і це не асиметрія заради асиметрії: `maxAttestationAgeSeconds`
 * із правила (FR-008a2) — це **вік** атестації, а віку без моменту видачі не
 * буває. У `HolderStatus` такого поля немає, тож нести його в спільній формі
 * означало б вигадувати у фікстурі значення, якого Rust-половина не читає.
 */
export const providerStatusSchema = z.object({ ...statusFields, issuedAt: unixSecondsSchema })

export type RegisterStatus = z.infer<typeof registerStatusSchema>
export type ProviderStatus = z.infer<typeof providerStatusSchema>

/**
 * Стан одного джерела для однієї сторони. Станів три, а не два, і третій —
 * найважливіший.
 *
 * `unavailable` — акаунт не переданий у переказ або переданий не той. Це **не**
 * «запису немає»: ми не знаємо, є він чи ні, а недоступність джерела не має
 * послаблювати політику (FR-013), тож у неї окремий стан і окремий код відмови.
 * `absent` — джерело доступне, і запису про адресу в ньому немає.
 */
const unavailableSchema = z.object({ kind: z.literal('unavailable') })
const absentSchema = z.object({ kind: z.literal('absent') })

export const providerStateSchema = z.discriminatedUnion('kind', [
  unavailableSchema,
  absentSchema,
  z.object({ kind: z.literal('record'), record: providerStatusSchema }),
])

export const registerStateSchema = z.discriminatedUnion('kind', [
  unavailableSchema,
  absentSchema,
  z.object({ kind: z.literal('record'), record: registerStatusSchema }),
])

/** Обидва джерела для однієї сторони переказу. */
export const partyContextSchema = z.object({
  provider: providerStateSchema,
  register: registerStateSchema,
})

export type PartyContext = z.infer<typeof partyContextSchema>

// ─── Контекст переказу ───────────────────────────────────────────────────────

/** Версія `PolicyConfig` — `u32`, як і seed акаунта. */
const U32_MAX = 0xff_ff_ff_ff

export const policyVersionSchema = z.number().int().min(0).max(U32_MAX)

/**
 * `VelocityCounter` відправника: початок вікна й витрачене в ньому.
 *
 * Лічильник належить саме відправнику — ліміт за період обмежує того, хто
 * відправляє. Він створюється при `thaw_holder`, і його відсутність є відмовою,
 * а не пропуском перевірки (FR-013), тому в контексті він опціональний, а не
 * «нульовий за замовчуванням».
 */
export const velocityCounterSchema = z.object({
  windowStart: unixSecondsSchema,
  spentInWindow: u64Schema,
})

/**
 * Усе, що хук має в руках у момент переказу.
 *
 * `mintPolicyVersion` — версія, на яку налаштований mint (`TokenConfig.policy_version`);
 * `policyVersion` — версія переданого `PolicyConfig`. Це дві різні речі, і саме
 * їх порівнює перша перевірка: політика, підсунута замість чинної, інакше
 * виконалася б замість неї.
 *
 * `now` — час блоку в unix-секундах (`Clock`), а не час клієнта. У симуляції це
 * робить результат відтворюваним: та сама фікстура дає ту саму відповідь і через
 * рік, тож диференційний тест не залежить від годинника машини.
 */
export const transferContextSchema = z.object({
  sender: partyContextSchema,
  recipient: partyContextSchema,
  amount: u64Schema,
  velocity: velocityCounterSchema.optional(),
  mintPolicyVersion: policyVersionSchema,
  policyVersion: policyVersionSchema,
  now: unixSecondsSchema,
})

export type TransferContext = z.infer<typeof transferContextSchema>

// ─── Вердикт ─────────────────────────────────────────────────────────────────

/**
 * Відповідь оцінювача.
 *
 * Несе **тільки** код — рівно те, що повертає хук і що видно холдеру (FR-011).
 * Пояснень людською мовою тут немає навмисно: текст у вердикті став би другою
 * поверхнею, яку диференційний тест мусив би або звіряти (а Rust її не має), або
 * мовчки ігнорувати. Копію для екрана складає консоль (T023) за кодом.
 */
export type TransferVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: RefusalCode }

export const transferVerdictSchema = z.discriminatedUnion('allowed', [
  z.object({ allowed: z.literal(true) }),
  z.object({ allowed: z.literal(false), code: refusalCodeSchema }),
])

const ALLOWED: TransferVerdict = { allowed: true }

const refuse = (code: RefusalCode): TransferVerdict => ({ allowed: false, code })

// ─── Злиття двох джерел ──────────────────────────────────────────────────────

/** Чинний запис, зведений до того, що з нього читають перевірки. */
type StatusFact = {
  readonly source: StatusSource
  readonly denied: boolean
  readonly tier: number
  readonly jurisdiction: string
}

/**
 * Сторона переказу очима правил.
 *
 * `fresh` — чинні записи з усіх джерел (з них діє заборона); `accepted` — ті з
 * них, які правило приймає (тільки вони можуть дозволити); `unavailable` — чи
 * було хоч одне джерело недоступне.
 *
 * `unavailable` рахується по **обох** джерелах, а не лише по прийнятих: якщо
 * заборона діє з будь-якого джерела, то й недоступність будь-якого джерела може
 * ховати заборону. Пропустити переказ, не подивившись у джерело, яке могло
 * сказати «ні», — це рівно те послаблення політики, яке забороняє FR-013.
 */
type PartyView = {
  readonly fresh: readonly StatusFact[]
  readonly accepted: readonly StatusFact[]
  readonly unavailable: boolean
}

/**
 * Запис чинний, поки не настав його власний строк.
 *
 * Порівняння суворе: у секунду `expiresAt` запис уже протермінований. Межу треба
 * було обрати, і обрана та, за якої «діє до» читається як «діє до, не включно».
 * Важливо лише, щоб Rust-половина обрала ту саму (T015).
 */
const isCurrent = (expiresAt: number | null, now: number): boolean =>
  expiresAt === null || now < expiresAt

/**
 * Атестація провайдера чинна, поки не настав її строк **і** поки її вік не
 * перевищив дозволений політикою (FR-008a2).
 *
 * Протермінована атестація прирівнюється до відсутньої, а не до заборони: далі
 * рішення ухвалює те саме правило статусу, тож на виході буде `*_STATUS_MISSING`
 * або дозвіл із другого джерела. Окремого коду відмови «протерміновано» немає, і
 * це не пропуск — його поява зробила б протермінування самостійною причиною
 * відмови, тобто іншою поведінкою, ніж написана у вимозі.
 *
 * Наслідок, який варто сказати вголос: протермінована атестація і **не**
 * забороняє. Із чинних записів вона вибуває цілком, разом зі своїм `denied`.
 */
function isProviderCurrent(
  record: ProviderStatus,
  maxAgeSeconds: number | undefined,
  now: number,
): boolean {
  if (!isCurrent(record.expiresAt, now)) return false
  return maxAgeSeconds === undefined || now - record.issuedAt <= maxAgeSeconds
}

const toFact = ({ denied, tier, jurisdiction }: RegisterStatus): Omit<StatusFact, 'source'> => ({
  denied,
  tier,
  jurisdiction,
})

function viewParty(party: PartyContext, policy: PolicyRules, now: number): PartyView {
  const fresh: StatusFact[] = []
  let unavailable = false

  const { provider, register } = party

  if (provider.kind === 'unavailable') {
    unavailable = true
  } else if (
    provider.kind === 'record' &&
    isProviderCurrent(provider.record, policy.status.maxAttestationAgeSeconds, now)
  ) {
    fresh.push({ source: 'provider', ...toFact(provider.record) })
  }

  if (register.kind === 'unavailable') {
    unavailable = true
  } else if (register.kind === 'record' && isCurrent(register.record.expiresAt, now)) {
    fresh.push({ source: 'register', ...toFact(register.record) })
  }

  const accepts = new Set<StatusSource>(policy.status.sources)
  return { fresh, accepted: fresh.filter((fact) => accepts.has(fact.source)), unavailable }
}

/** Про сторону не відомо нічого: обидва джерела доступні й обидва мовчать. */
const nothingKnown = (party: PartyView): boolean => !party.unavailable && party.fresh.length === 0

/** Статус є, але жодне з джерел, що його дали, правило не приймає. */
const onlyUnaccepted = (party: PartyView): boolean =>
  party.fresh.length > 0 && party.accepted.length === 0

/**
 * Рівень сторони — **найнижчий** серед прийнятих джерел: при розбіжності діє
 * суворіше (FR-008a1). Друге джерело може тільки звузити коло, дозволене першим.
 *
 * Нуль на порожньому переліку недосяжний — до цієї перевірки доходять лише
 * сторони з прийнятим записом, — але він і безпечний: сторона без статусу не
 * пройде `minTier`, більший за нуль.
 */
function mergedTier(party: PartyView): number {
  const tiers = party.accepted.map((fact) => fact.tier)
  return tiers.length === 0 ? 0 : Math.min(...tiers)
}

/**
 * Юрисдикція не підходить, якщо **хоч одне** прийняте джерело називає країну
 * поза переліком. Та сама суворість: збіг одного джерела не перекриває
 * розбіжність другого.
 */
const jurisdictionRefused = (party: PartyView, allowed: readonly string[] | undefined): boolean =>
  allowed !== undefined && party.accepted.some((fact) => !allowed.includes(fact.jurisdiction))

/**
 * Витрачене у вікні плюс сума переказу перевищує ліміт за період.
 *
 * Вікно, яке вже закінчилось, дає нуль витраченого: `VelocityCounter` скидається
 * на межі вікна, і хук робить це в тій самій інструкції. Читати `spentInWindow`
 * без порівняння з `windowStart` означало б рахувати позаминулий тиждень у
 * поточному ліміті.
 */
function periodExceeded(policy: PolicyRules, ctx: TransferContext): boolean {
  const limit = policy.periodLimit
  if (limit === undefined || ctx.velocity === undefined) return false
  const windowOpen = ctx.now < ctx.velocity.windowStart + limit.windowSeconds
  const spent = windowOpen ? toU64(ctx.velocity.spentInWindow) : 0n
  return spent + toU64(ctx.amount) > toU64(limit.amount)
}

// ─── Перевірки ───────────────────────────────────────────────────────────────

/** Усе, на що дивляться перевірки. Збирається один раз на виклик. */
type Subject = {
  readonly policy: PolicyRules
  readonly ctx: TransferContext
  readonly sender: PartyView
  readonly recipient: PartyView
}

type Check = (subject: Subject) => boolean

/**
 * Таблиця «код відмови → перевірка». Порядок задає не вона, а `REFUSAL_CODES`,
 * яким іде цикл нижче.
 *
 * `null` означає «цей код повертає не хук». Тип `Record<RefusalCode, …>` робить
 * таблицю вичерпною: новий код відмови не скомпілюється, доки про нього не
 * сказано, перевірка це хука чи ні — і `UNKNOWN_RULE_KIND` із боргу T012 не
 * зможе з'явитися в переліку мовчки, без перевірки тут.
 */
const CHECKS: Record<RefusalCode, Check | null> = {
  /** Політика, підсунута замість тієї, на яку налаштований mint. */
  POLICY_VERSION_MISMATCH: ({ ctx }) => ctx.policyVersion !== ctx.mintPolicyVersion,
  SENDER_STATUS_MISSING: ({ sender }) => nothingKnown(sender),
  RECIPIENT_STATUS_MISSING: ({ recipient }) => nothingKnown(recipient),
  STATUS_SOURCE_NOT_ACCEPTED: ({ sender, recipient }) =>
    onlyUnaccepted(sender) || onlyUnaccepted(recipient),
  STATUS_SOURCE_UNAVAILABLE: ({ sender, recipient }) => sender.unavailable || recipient.unavailable,
  SENDER_DENIED: ({ sender }) => sender.fresh.some((fact) => fact.denied),
  RECIPIENT_DENIED: ({ recipient }) => recipient.fresh.some((fact) => fact.denied),
  RECIPIENT_TIER_TOO_LOW: ({ policy, recipient }) => mergedTier(recipient) < policy.status.minTier,
  RECIPIENT_JURISDICTION_NOT_ALLOWED: ({ policy, recipient }) =>
    jurisdictionRefused(recipient, policy.jurisdictions),
  TRANSFER_LIMIT_EXCEEDED: ({ policy, ctx }) =>
    policy.transferLimit !== undefined && toU64(ctx.amount) > toU64(policy.transferLimit),
  VELOCITY_COUNTER_MISSING: ({ policy, ctx }) =>
    policy.periodLimit !== undefined && ctx.velocity === undefined,
  PERIOD_LIMIT_EXCEEDED: ({ policy, ctx }) => periodExceeded(policy, ctx),
  /** `Pausable` на mint — переказ падає до виклику хука (FR-016). */
  TRANSFERS_PAUSED: null,
  /** `DefaultAccountState = Frozen` або `freeze_account` — так само (FR-014). */
  ACCOUNT_FROZEN: null,
}

// ─── Оцінювач ────────────────────────────────────────────────────────────────

/**
 * Політика + контекст → вердикт.
 *
 * Домен рівно один: перевірки хука. Пауза й заморозка сюди не входять — для них
 * є `simulateTransfer`.
 *
 * Обидва входи проганяються через схему. Оцінювати неперевірену політику
 * означає відповідати про політику, якої не могло існувати в акаунті, а
 * неперевірений контекст — про переказ, якого не могло статися в мережі; в обох
 * випадках майстер показав би відповідь, якої ланцюг не дасть.
 */
export function evaluateTransfer(rules: PolicyRules, context: TransferContext): TransferVerdict {
  const policy = policyRulesSchema.parse(rules)
  const ctx = transferContextSchema.parse(context)
  const subject: Subject = {
    policy,
    ctx,
    sender: viewParty(ctx.sender, policy, ctx.now),
    recipient: viewParty(ctx.recipient, policy, ctx.now),
  }

  // Відмова — це **перша** перевірка, що не пройшла, а не набір усіх, що не
  // пройшли. Дві реалізації, які відхилили той самий переказ із різних причин,
  // розійшлися — навіть якщо обидві сказали «ні» (SC-008).
  for (const code of REFUSAL_CODES) {
    // `null` пропускається мовчки: це коди токен-програми, і їх тут немає не
    // тому, що перевірку забули.
    if (CHECKS[code]?.(subject)) return refuse(code)
  }
  return ALLOWED
}

/**
 * Коди, які цей модуль справді перевіряє, у порядку перевірки.
 *
 * Виведені з таблиці, а не перелічені вдруге: розбіжність між «які перевірки
 * реалізовані» і «які коди оголошені хуковими» стає видимою тестом, а не
 * читанням двох файлів поруч.
 */
export function implementedRefusalCodes(): RefusalCode[] {
  return REFUSAL_CODES.filter((code) => CHECKS[code] !== null)
}

// ─── Шар токен-програми ──────────────────────────────────────────────────────

/**
 * Стан, який до хука не доходить: пауза на mint і заморозка рахунків сторін.
 *
 * Живе окремо від `TransferContext` навмисно — щоб фікстура диференційного тесту
 * не могла нести полів, яких Rust-половина не бачить.
 */
export const tokenProgramStateSchema = z.object({
  paused: z.boolean(),
  senderFrozen: z.boolean(),
  recipientFrozen: z.boolean(),
})

export type TokenProgramState = z.infer<typeof tokenProgramStateSchema>

/** Нічого не заважає: токен не на паузі, обидва рахунки розморожені. */
export const OPEN_TOKEN_STATE: TokenProgramState = {
  paused: false,
  senderFrozen: false,
  recipientFrozen: false,
}

/**
 * Повний шлях переказу, як його бачить холдер: спершу токен-програма, потім хук.
 *
 * Порядок тут зворотний до `REFUSAL_CODES`, і це не суперечність: у переліку
 * `TRANSFERS_PAUSED` і `ACCOUNT_FROZEN` стоять у кінці як коди, яких хук не
 * повертає, а в житті вони спрацьовують першими — токен-програма відхиляє
 * переказ **до** того, як покличе хук. Саме тому їх немає в `evaluateTransfer`.
 *
 * Це та форма, якою майстер показує сценарій «при паузі» з FR-004.
 */
export function simulateTransfer(
  rules: PolicyRules,
  context: TransferContext,
  token: TokenProgramState = OPEN_TOKEN_STATE,
): TransferVerdict {
  const state = tokenProgramStateSchema.parse(token)
  if (state.paused) return refuse('TRANSFERS_PAUSED')
  if (state.senderFrozen || state.recipientFrozen) return refuse('ACCOUNT_FROZEN')
  return evaluateTransfer(rules, context)
}
