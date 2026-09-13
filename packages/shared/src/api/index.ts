// Контракти, спільні для сервера й консолі: маска ролей, форма сесії та імена
// заголовків. Схеми звідси валідують і відповідь на сервері, і те, що прочитав
// браузер, тож розбіжність між двома сторонами неможлива за побудовою.
import { z } from 'zod'
import { addressSchema } from '../primitives.ts'

/**
 * Бітмаска ролей — дзеркало `role` з `programs/issuer-forge/src/state/issuer.rs`.
 * Числа не «узгоджені», а ті самі: у базі лежить `role_assignments.roles`,
 * скопійований із `IssuerConfig.members[i].roles`, і будь-яке перекодування на
 * шляху ланцюг → база → екран було б місцем, де роль може змінитися мовчки.
 */
export const ROLE = {
  ADMIN: 1 << 0,
  COMPLIANCE: 1 << 1,
  ATTESTOR: 1 << 2,
  OBSERVER: 1 << 3,
} as const

export type RoleName = keyof typeof ROLE

export const ROLE_NAMES = Object.keys(ROLE) as readonly RoleName[]

/** Усі відомі біти. Те саме число стоїть `CHECK`-ом у `role_assignments`. */
export const ROLE_ALL = ROLE.ADMIN | ROLE.COMPLIANCE | ROLE.ATTESTOR | ROLE.OBSERVER

/** Ролі, підпис яких рахується в кворум (FR-019). */
export const ROLE_AUTHORISING = ROLE.ADMIN | ROLE.COMPLIANCE

/**
 * Порожня маска не є роллю: рядок складу з `roles == 0` — це вільний слот, а не
 * учасник без повноважень (для останнього існує `OBSERVER`).
 */
export const roleMaskSchema = z.number().int().min(1).max(ROLE_ALL)

export function hasRole(mask: number, role: number): boolean {
  return (mask & role) !== 0
}

export function roleNames(mask: number): RoleName[] {
  return ROLE_NAMES.filter((name) => hasRole(mask, ROLE[name]))
}

/**
 * Повноваження, делеговані операційному ключу платформи (FR-035) — дзеркало
 * `delegation` з того самого `state/issuer.rs`.
 *
 * Перелік закритий **у програмі**, а не в конфігурації: емісії, вилучення,
 * паузи й зміни політики тут немає й бути не може, тож скомпрометований
 * операційний ключ не отримує їх навіть із «повною» маскою (FR-035a).
 */
export const DELEGATION = {
  THAW_HOLDER: 1 << 0,
  SET_HOLDER_STATUS: 1 << 1,
  SETTLE_REDEMPTION: 1 << 2,
} as const

export type PowerName = keyof typeof DELEGATION

export const POWER_NAMES = Object.keys(DELEGATION) as readonly PowerName[]

export const DELEGATION_ALL =
  DELEGATION.THAW_HOLDER | DELEGATION.SET_HOLDER_STATUS | DELEGATION.SETTLE_REDEMPTION

/**
 * Та сама арифметика, що в `hasRole`, і навмисно **окрема назва**.
 *
 * Обидві маски — `number`, тож типи не втримають плутанини: `hasRole(mask,
 * ROLE.ADMIN)` над маскою делегації скомпілювався б і мовчки відповів би «так»
 * на `THAW_HOLDER`. Різні імена лишають цю помилку видимою при читанні — це
 * єдиний бар'єр, який тут узагалі можливий.
 */
export function hasPower(mask: number, power: number): boolean {
  return (mask & power) !== 0
}

export function powerNames(mask: number): PowerName[] {
  return POWER_NAMES.filter((name) => hasPower(mask, DELEGATION[name]))
}

/**
 * Членство одного користувача в одного емітента.
 *
 * `wallets` — ті з підтверджених адрес входу, які справді стоять у складі цього
 * емітента; маска — об'єднання їхніх ролей. `syncedAt` — вік дзеркала складу,
 * і він показується в консолі: екран, що мовчки малює вчорашній склад ролей, у
 * комплаєнс-продукті гірший за порожній.
 */
export const membershipSchema = z.object({
  issuerId: addressSchema,
  roles: roleMaskSchema,
  wallets: z.array(addressSchema).min(1),
  syncedAt: z.iso.datetime(),
})

export type Membership = z.infer<typeof membershipSchema>

/**
 * Сесія — те, що сервер вивів із перевіреного токена входу, і **тільки воно**.
 *
 * `issuerId` тут не з параметра запиту: він або єдиний серед членств, або
 * обраний заголовком `X-Issuer-Id` серед уже доведених членств. Заголовок
 * звужує вибір, а не надає доступ, тож правило FR-036 «жоден параметр запиту не
 * перекриває `issuer_id` сесії» лишається дійсним.
 *
 * Роль у сесії відкриває екрани й ручки. Дії з коштами вона не дозволяє: їх
 * перевіряє програма за кворумом (FR-019), і сесія на це не впливає ніяк.
 */
export const sessionSchema = z.object({
  /** DID постачальника входу. Ролі до нього не прив'язані (FR-034a). */
  userId: z.string().min(1),
  /** Усі підтверджені Solana-адреси акаунта входу. */
  wallets: z.array(addressSchema),
  issuerId: addressSchema,
  roles: roleMaskSchema,
  memberships: z.array(membershipSchema).min(1),
})

export type Session = z.infer<typeof sessionSchema>

/** Вибір емітента, коли членств кілька. Значення мусить бути серед членств. */
export const ISSUER_HEADER = 'x-issuer-id'

/** Наскрізний ідентифікатор запиту: приймається від клієнта, інакше свій. */
export const REQUEST_ID_HEADER = 'x-request-id'
