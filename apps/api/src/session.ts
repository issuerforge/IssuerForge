// Сесія: перевірений токен входу → `issuer_id` і маска ролей.
//
// Головне правило ізоляції орендарів (FR-036) формулюється тут одним реченням:
// **`issuerId` береться зі складу емітента, а не з запиту.** Заголовок
// `X-Issuer-Id` існує лише для випадку, коли членств кілька, і вміє тільки
// звузити вибір до одного з уже доведених — надати доступ він не може ніяк.
//
// Такий випадок не екзотика: аудитор або юрист законно обслуговує двох
// емітентів однією адресою, і саме двома орендарями вимірюється SC-011.
import { ISSUER_HEADER, type Membership, type Session } from '@forge/shared/api'
import { createMiddleware } from 'hono/factory'
import type { Directory } from './directory.ts'
import type { AppEnv } from './env.ts'
import { invalidInput, unauthorized } from './errors.ts'
import type { PrivyClient } from './privy.ts'

export interface SessionDeps {
  privy: PrivyClient
  directory: Directory
}

/** `Authorization: Bearer <token>`. Схема нечутлива до регістру за RFC 7235. */
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  const match = /^Bearer[ ]+(?<token>[^\s]+)$/i.exec(header)
  return match?.groups?.token
}

/**
 * Обирає орендаря серед доведених членств.
 *
 * Заголовок, що називає емітента поза цим переліком, — це `INVALID_INPUT`, а не
 * `NOT_FOUND`: існує той емітент чи ні, з боку цієї сесії питання не має сенсу,
 * і відповідь на нього була б відповіддю про чужі дані.
 */
export function selectMembership(
  memberships: readonly Membership[],
  requested: string | undefined,
): Membership {
  if (memberships.length === 0) {
    throw unauthorized('this wallet is not a member of any issuer')
  }

  if (requested === undefined) {
    const only = memberships[0]
    if (memberships.length === 1 && only !== undefined) return only
    throw invalidInput(`this account belongs to several issuers: pick one with ${ISSUER_HEADER}`, {
      issuerIds: memberships.map((m) => m.issuerId),
    })
  }

  const picked = memberships.find((m) => m.issuerId === requested)
  if (picked === undefined) {
    throw invalidInput(`${ISSUER_HEADER} does not name an issuer this account belongs to`, {
      issuerIds: memberships.map((m) => m.issuerId),
    })
  }
  return picked
}

/**
 * Middleware входу. Ставить `session` у контекст або не пускає далі взагалі —
 * стану «маршрут виконався без сесії» не існує.
 */
export function requireSession(deps: SessionDeps) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const token = bearerToken(c.req.header('authorization'))
    if (token === undefined) throw unauthorized('missing bearer access token')

    const user = await deps.privy.authenticate(token)
    const memberships = await deps.directory.membershipsFor(user.wallets)
    const membership = selectMembership(
      memberships,
      c.req.header(ISSUER_HEADER)?.trim() || undefined,
    )

    const session: Session = {
      userId: user.userId,
      wallets: user.wallets,
      issuerId: membership.issuerId,
      roles: membership.roles,
      memberships,
    }

    c.set('session', session)
    // `issuerId` у логері запиту — не прикраса: журнал комплаєнс-продукту
    // мусить давати відповідь «що робили в цього емітента» без join'ів.
    c.set('log', c.get('log').child({ issuerId: session.issuerId, userId: session.userId }))

    await next()
  })
}
