// Дзеркало складу емітента в базі — те, що в продукті пише індексатор.
//
// **Це найбільша частина шляху `--api`, і її не видно з опису задачі.**
// Повноваження в api дає не токен входу, а рядок у `role_assignments`
// (`apps/api/src/directory.ts`): сесія бере `issuer_id` і ролі звідти. Ці
// рядки — дзеркало ончейн-`IssuerConfig.members`, і наповнює його **T031**,
// якого ще немає: він у M2. Тож демо пише їх сама, і робить це рівно так, як
// робив би індексатор — з тих самих значень і з тим самим слотом.
//
// Рядок `issuers` потрібен не api (він його не читає взагалі), а зовнішньому
// ключу з `tokens`: без емітента резервація номера впала б на FK.
//
// **Коли з'явиться T031, цей файл має зникнути**, а не лишитись «швидким
// шляхом для демо»: два джерела дзеркала розійдуться мовчки.
import { createDatabase, type Database, issuers, roleAssignments } from '@forge/db'
import { ROLE } from '@forge/shared/api'
import type { PublicKey } from '@solana/web3.js'
import type { DemoKeys } from './context.ts'

export interface SeedInput {
  readonly issuerId: PublicKey
  readonly keys: DemoKeys
  readonly quorumN: number
  readonly delegationMask: number
  /** Слот, у якому склад став таким. Індексатор пише той, що прочитав. */
  readonly slot: number
}

/**
 * Склад демо в базі: три рядки в тому ж порядку, що й у `initialize_issuer`.
 *
 * `member_index` — це не порядковий номер рядка, а **слот складу**: за ним
 * кворум читає бітмапу підписів (T025). Розійтись із ланцюгом він не може, тож
 * береться з того самого переліку, з якого будувалась інструкція.
 */
export async function seedIssuer(db: Database, input: SeedInput): Promise<void> {
  const { keys, issuerId } = input
  const id = issuerId.toBase58()
  const syncedAt = new Date()

  await db
    .insert(issuers)
    .values({
      issuerId: id,
      legalName: 'Vantara Microfinance PLC',
      jurisdiction: 'NG',
      founderWallet: keys.founder.publicKey.toBase58(),
      quorumN: input.quorumN,
      operationalKey: keys.operational.publicKey.toBase58(),
      delegationMask: input.delegationMask,
      sourceSlot: input.slot,
      syncedAt,
    })
    .onConflictDoNothing()

  const members = [
    { wallet: keys.founder.publicKey.toBase58(), roles: ROLE.ADMIN },
    { wallet: keys.officer.publicKey.toBase58(), roles: ROLE.COMPLIANCE },
    { wallet: keys.attestor.publicKey.toBase58(), roles: ROLE.ATTESTOR },
  ]

  await db
    .insert(roleAssignments)
    .values(
      members.map((member, memberIndex) => ({
        issuerId: id,
        memberIndex,
        wallet: member.wallet,
        roles: member.roles,
        sourceSlot: input.slot,
        syncedAt,
      })),
    )
    .onConflictDoNothing()
}

export function openDatabase(url: string): Database {
  return createDatabase(url)
}

/**
 * Закриває пул з'єднань.
 *
 * Без цього процес демо не завершується **після успішного прогону**: `postgres`
 * тримає сокет відкритим, і подієвий цикл не порожніє. Симптом підступний тим,
 * що всі числа вже надруковані, — прогін виглядає зробленим і просто висить.
 */
export async function closeDatabase(db: Database): Promise<void> {
  await db.$client.end({ timeout: 5 })
}
