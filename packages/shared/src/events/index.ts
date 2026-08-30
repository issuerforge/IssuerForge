import { z } from 'zod'
import {
  addressSchema,
  blockTimeSchema,
  signatureSchema,
  slotSchema,
  u64Schema,
  unixSecondsSchema,
} from '../primitives.ts'
import { refusalCodeSchema } from '../refusal.ts'

/**
 * Індексовані події: те, що `apps/worker` виймає з логів програми й токен-програми
 * і що потім живе трьома життями — стрічкою в консолі (FR-037), рядками журналу
 * (FR-018) і дзеркалом у Postgres (`docs/PLAN.md` → «Модель даних»).
 *
 * Один союз на всіх трьох споживачів, а не три схожі типи. Причина в SC-006:
 * незалежний верифікатор читає експортований NDJSON і звіряє його з мережею, не
 * звертаючись до API. Якби журнал мав власну форму, звірка доводила б збіг
 * журналу з мережею, але нічого не казала б про те, що бачив емітент у консолі.
 *
 * Ончейн лишається джерелом правди; кожна подія несе `signature` і `slot`, тобто
 * рівно те, з чим її можна перевірити, маючи лише RPC.
 */

/**
 * Спільні поля. Ідентичність події — пара `signature` + `eventIndex`: одна
 * транзакція законно містить кілька переказів (дроблення — це сценарій із
 * SC-002), тож підпис сам по собі ключем не є.
 */
const envelope = {
  signature: signatureSchema,
  slot: slotSchema,
  blockTime: blockTimeSchema,
  /** Порядковий номер події всередині транзакції, від нуля. */
  eventIndex: z.number().int().nonnegative(),
  mint: addressSchema,
}

/**
 * Виконаний переказ (FR-037).
 *
 * Несе і токен-акаунти, і гаманці власників: перші потрібні, щоб звірити подію
 * з інструкцією в транзакції, другі — щоб показати сторону людині. Хук читає
 * `owner` із даних токен-акаунта, тож обидві пари він має в руках і без
 * додаткових запитів до RPC.
 */
export const transferEventSchema = z.object({
  kind: z.literal('transfer'),
  ...envelope,
  source: addressSchema,
  destination: addressSchema,
  sender: addressSchema,
  recipient: addressSchema,
  amount: u64Schema,
})

/**
 * Відхилений переказ (FR-011).
 *
 * `code` — розібрана назва причини, `programError` — сире число з мережі.
 * Тримаються обидва: воркер старший за програму бачить незнайомий номер, і
 * подія з `code: null` лишається перевірюваною й не зникає зі стрічки.
 *
 * `ruleSlot` — номер слоту в `PolicyConfig.rules` (0…15), який спрацював, або
 * `null` для відмов, що не походять від правила (розбіжність версії політики,
 * пауза, заморозка). Саме він зв'язує відмову з пунктом збірника правил, який
 * емітент бачив у майстрі.
 */
export const refusalEventSchema = z.object({
  kind: z.literal('refusal'),
  ...envelope,
  source: addressSchema,
  destination: addressSchema,
  sender: addressSchema,
  recipient: addressSchema,
  amount: u64Schema,
  code: refusalCodeSchema.nullable(),
  programError: z.number().int().nullable(),
  ruleSlot: z.number().int().min(0).max(15).nullable(),
})

/**
 * Дії, які вимагають коду підстави й посилання на кейс (FR-017).
 *
 * Розморожування рахунку при онбордингу сюди **не** входить: воно не має кейсу,
 * підписується операційним ключем у межах делегації (FR-035) і є зміною
 * реєстру статусів, а не комплаєнс-дією. Його місце — черга розморожування
 * (FR-008b2), задачі T022 і T031.
 */
export const COMPLIANCE_ACTIONS = [
  'freeze',
  'unfreeze',
  'seize',
  'pause',
  'unpause',
  'set_policy',
  'set_roles',
  'set_attestor',
] as const

export type ComplianceAction = (typeof COMPLIANCE_ACTIONS)[number]

export const complianceActionSchema = z.enum(COMPLIANCE_ACTIONS)

/**
 * Комплаєнс-дія (FR-017, FR-018, FR-019c).
 *
 * `signers` — поіменний склад, а не лічильник: FR-019c вимагає показати, **хто**
 * санкціонував дію з коштами, і «кворум зібрано» цю вимогу не задовольняє.
 * Мінімум один підпис: заморозку окремого рахунку виконує офіцер одноосібно
 * (FR-014), кворум потрібен лише діям із коштами (FR-019).
 *
 * `target` і `amount` нульові там, де їх немає за змістом: пауза не має цілі,
 * зміна політики не має суми. Порожній рядок чи нуль на цих місцях читалися б
 * як значення.
 */
export const complianceEventSchema = z.object({
  kind: z.literal('compliance'),
  ...envelope,
  action: complianceActionSchema,
  target: addressSchema.nullable(),
  amount: u64Schema.nullable(),
  reasonCode: z.string().min(1),
  caseRef: z.string().min(1),
  signers: z.array(addressSchema).min(1),
})

/**
 * Опублікована атестація резерву (FR-021, FR-026).
 *
 * `index` — позиція в append-only послідовності `["reserve", mint, index]`:
 * запис не редагується й не видаляється, тож індекс і є історією.
 *
 * `currency` — валюта резерву, не токена, і вона не обов'язково збігається з
 * валютою обігу. `amount` — у найменших одиницях цієї валюти.
 */
export const attestationEventSchema = z.object({
  kind: z.literal('attestation'),
  ...envelope,
  index: z.number().int().nonnegative(),
  amount: u64Schema,
  currency: z.string().min(3).max(8),
  attestor: addressSchema,
  attestedAt: unixSecondsSchema,
  expiresAt: unixSecondsSchema,
})

/**
 * Союз усього, що індексується до M2 включно.
 *
 * Пропозиції дій (FR-019b) і погашення (US4) сюди ще не входять — вони
 * приходять зі своїми задачами (T031/T032 і T048). Дискримінатор `kind` робить
 * розширення додаванням члена: наявні споживачі від нового члена не ламаються.
 */
export const indexedEventSchema = z.discriminatedUnion('kind', [
  transferEventSchema,
  refusalEventSchema,
  complianceEventSchema,
  attestationEventSchema,
])

export type TransferEvent = z.infer<typeof transferEventSchema>
export type RefusalEvent = z.infer<typeof refusalEventSchema>
export type ComplianceEvent = z.infer<typeof complianceEventSchema>
export type AttestationEvent = z.infer<typeof attestationEventSchema>
export type IndexedEvent = z.infer<typeof indexedEventSchema>

export type IndexedEventKind = IndexedEvent['kind']

/**
 * Ключ події для дедуплікації.
 *
 * Індексатор перечитує логи після переривання зв'язку, тож та сама подія
 * приходить двічі; ключ має бути похідним від мережі, а не від часу вставки.
 */
export function eventKey(event: IndexedEvent): string {
  return `${event.signature}:${event.eventIndex}`
}
