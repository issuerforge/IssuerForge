// Drizzle-схема. **Ончейн лишається джерелом правди** — ці таблиці існують,
// щоб консоль показувала стан без RPC на кожен рядок, і щоб журнал мав де
// лежати між подіями (docs/PLAN.md → «Модель даних»).
//
// Звідси два правила, які діють на всі таблиці нижче:
//
// 1. **Кожна таблиця несе `issuer_id`** — той самий base58-ключ, що є seed
//    `["issuer", issuer_id]`. Перекладу між базою і ланцюгом немає ніде, тож
//    немає й місця, де він може зійтись не з тим емітентом. На ньому ж стоїть
//    ізоляція орендарів (FR-036): політики RLS у T051 пишуться по одній колонці,
//    без жодного join.
// 2. **RLS увімкнений уже тут, без політик.** Це deny для всіх, крім власника
//    таблиці й `service_role`, яким ходить api. Стану «таблиця в Supabase є, а
//    захисту ще немає» не існує ніколи — T051 додає політики до вже закритих
//    таблиць, а не закриває відкриті.
//
// Колонки `source_slot` і `synced_at` — вік дзеркала, а не прикраса: рядок без
// них ще не бачений у мережі, а старий `synced_at` означає, що екран показує
// вчорашній склад. Повноваження все одно перевіряє програма, але екран, який
// мовчки бреше про ролі, у комплаєнс-продукті гірший за порожній.
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

/** Довжина base58-адреси Solana. Дешева перевірка проти порожнього рядка. */
const BASE58_LENGTH = sql`between 32 and 44`

/**
 * `pending` — транзакція випуску зібрана, підтвердження з мережі ще немає.
 * `live` — mint існує. `paused` — дзеркало розширення `Pausable` (FR-016),
 * авторитетним лишається сам mint.
 */
export const tokenState = pgEnum('token_state', ['pending', 'live', 'paused'])

/**
 * `pending` — рахунок у черзі на розморожування (FR-008b2); `thawed` —
 * розморожений; `frozen` — заморожений офіцером (FR-014). Розморожений рахунок
 * не означає дозволу на переказ: правила перевіряються на кожному (FR-008b1).
 */
export const holderState = pgEnum('holder_state', ['pending', 'thawed', 'frozen'])

/** Чиїм статусом є цей рядок (FR-008a). Атестації провайдера живуть у SAS. */
export const statusSource = pgEnum('status_source', ['issuer', 'provider'])

export const issuers = pgTable(
  'issuers',
  {
    /**
     * Ончейн-ідентифікатор емітента: base58 того ключа, з якого виведений
     * `IssuerConfig`. Рядок законно існує до транзакції — `issuer_id`
     * генерується клієнтом раніше за неї, і саме тому `source_slot` nullable.
     */
    issuerId: text('issuer_id').primaryKey(),
    legalName: text('legal_name').notNull(),
    /** ISO 3166-1 alpha-2. */
    jurisdiction: text('jurisdiction').notNull(),
    /** Хто засновував. Повноважень не дає — склад лежить у `role_assignments`. */
    founderWallet: text('founder_wallet').notNull(),
    quorumN: smallint('quorum_n').notNull(),
    operationalKey: text('operational_key'),
    delegationMask: smallint('delegation_mask').notNull().default(0),
    sourceSlot: bigint('source_slot', { mode: 'number' }),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('issuers_issuer_id_is_base58', sql`char_length(${t.issuerId}) ${BASE58_LENGTH}`),
    check('issuers_founder_is_base58', sql`char_length(${t.founderWallet}) ${BASE58_LENGTH}`),
    check('issuers_jurisdiction_is_alpha2', sql`${t.jurisdiction} ~ '^[A-Z]{2}$'`),
    // `MIN_QUORUM` з constants.rs. Кворум 1 програма відхиляє, тож базі нема
    // сенсу вміти його зберігати (FR-019).
    check('issuers_quorum_at_least_two', sql`${t.quorumN} >= 2`),
    check('issuers_delegation_mask_known', sql`${t.delegationMask} between 0 and 7`),
  ],
).enableRLS()

/**
 * Дзеркало `IssuerConfig.members` — рівно того масиву, і за його індексами.
 *
 * `member_index` не декоративний: бітмапа підписів у `ActionProposal` (T025)
 * індексує саме слоти складу, тож без індексу зібраний кворум нема до чого
 * прив'язати. Порожні слоти в дзеркало не потрапляють: видалення учасника
 * лишає слот вільним, а не зсуває решту.
 */
export const roleAssignments = pgTable(
  'role_assignments',
  {
    issuerId: text('issuer_id')
      .notNull()
      .references(() => issuers.issuerId, { onDelete: 'cascade' }),
    memberIndex: smallint('member_index').notNull(),
    wallet: text('wallet').notNull(),
    /** Бітмаска ролей, як у ланцюзі: admin 1, compliance 2, attestor 4, observer 8. */
    roles: smallint('roles').notNull(),
    sourceSlot: bigint('source_slot', { mode: 'number' }).notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.issuerId, t.memberIndex] }),
    // Дублікат адреси програма відхиляє: одна людина мала б два голоси, тобто
    // кворум 2-з-N, який збирається одним підписом.
    uniqueIndex('role_assignments_issuer_wallet_key').on(t.issuerId, t.wallet),
    // Вхід у консоль іде від адреси гаманця до емітента (FR-034a), а не навпаки.
    index('role_assignments_wallet_idx').on(t.wallet),
    check('role_assignments_wallet_is_base58', sql`char_length(${t.wallet}) ${BASE58_LENGTH}`),
    check('role_assignments_member_index_in_range', sql`${t.memberIndex} between 0 and 7`),
    check('role_assignments_roles_not_empty', sql`${t.roles} between 1 and 15`),
  ],
).enableRLS()

export const tokens = pgTable(
  'tokens',
  {
    mint: text('mint').primaryKey(),
    issuerId: text('issuer_id')
      .notNull()
      .references(() => issuers.issuerId, { onDelete: 'restrict' }),
    symbol: text('symbol').notNull(),
    name: text('name').notNull(),
    decimals: smallint('decimals').notNull(),
    policyVersion: integer('policy_version').notNull().default(0),
    state: tokenState('state').notNull().default('pending'),
    sourceSlot: bigint('source_slot', { mode: 'number' }),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Мішень складеного ключа з `holders`: без цього обмеження денормалізований
    // там `issuer_id` можна було б поставити чужий.
    unique('tokens_mint_issuer_key').on(t.mint, t.issuerId),
    index('tokens_issuer_idx').on(t.issuerId),
    check('tokens_mint_is_base58', sql`char_length(${t.mint}) ${BASE58_LENGTH}`),
    check('tokens_decimals_in_range', sql`${t.decimals} between 0 and 9`),
    check('tokens_policy_version_non_negative', sql`${t.policyVersion} >= 0`),
  ],
).enableRLS()

/**
 * Власний реєстр статусів емітента (FR-008a) і черга розморожування (FR-008b2).
 *
 * Тут лежить **одне з двох** джерел статусу; атестації провідника верифікації
 * живуть у SAS і в базу не дзеркаляться — правило зводить їх у момент переказу,
 * і зводить суворіше (FR-008a1).
 */
export const holders = pgTable(
  'holders',
  {
    mint: text('mint').notNull(),
    wallet: text('wallet').notNull(),
    // Денормалізація навмисна: RLS має відсікати рядок за однією колонкою, без
    // join до `tokens`. Складений ключ нижче не дає їй розійтися з правдою.
    issuerId: text('issuer_id').notNull(),
    state: holderState('state').notNull().default('pending'),
    tier: smallint('tier'),
    /** ISO 3166-1 alpha-2, як і в емітента. */
    jurisdiction: text('jurisdiction'),
    statusSource: statusSource('status_source'),
    /** Заборона з власного реєстру. Перекриває будь-який дозвіл (FR-008a1). */
    denied: boolean('denied').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    thawedAt: timestamp('thawed_at', { withTimezone: true }),
    /** Коли рахунок став у чергу. Черга — це `state = 'pending'`. */
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    sourceSlot: bigint('source_slot', { mode: 'number' }),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.mint, t.wallet] }),
    foreignKey({
      columns: [t.mint, t.issuerId],
      foreignColumns: [tokens.mint, tokens.issuerId],
      name: 'holders_token_fk',
    }).onDelete('cascade'),
    // `GET /api/tokens/:mint/holders?state=pending` — черга офіцера.
    index('holders_queue_idx').on(t.issuerId, t.state),
    check('holders_wallet_is_base58', sql`char_length(${t.wallet}) ${BASE58_LENGTH}`),
    check('holders_tier_in_range', sql`${t.tier} is null or ${t.tier} between 0 and 255`),
    check(
      'holders_jurisdiction_is_alpha2',
      sql`${t.jurisdiction} is null or ${t.jurisdiction} ~ '^[A-Z]{2}$'`,
    ),
    // Черга — це рахунок, якого ще не впускали, і тільки він має право не мати
    // часу розморожування. `frozen` таке право не повертає: офіцер заморожує
    // вже впущений рахунок (FR-014), і момент, коли той був впущений, лишається
    // в журналі, а не стирається дією.
    check(
      'holders_thawed_at_matches_state',
      sql`(${t.state} = 'pending') = (${t.thawedAt} is null)`,
    ),
  ],
).enableRLS()

export type Issuer = typeof issuers.$inferSelect
export type NewIssuer = typeof issuers.$inferInsert
export type RoleAssignment = typeof roleAssignments.$inferSelect
export type NewRoleAssignment = typeof roleAssignments.$inferInsert
export type Token = typeof tokens.$inferSelect
export type NewToken = typeof tokens.$inferInsert
export type Holder = typeof holders.$inferSelect
export type NewHolder = typeof holders.$inferInsert
