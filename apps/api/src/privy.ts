// Вхід у консоль: перевірка токена Privy і склад підтверджених гаманців (FR-034).
//
// Два кроки, і вони різні за природою:
//
// 1. **Підпис токена перевіряється локально** — ES256 проти публічного ключа з
//    оточення. Мережі тут немає взагалі, тож недоступність постачальника входу
//    не робить кожен запит повільним, а прострочений токен відсікається дешево.
// 2. **Адреси гаманців доводиться питати.** У токені Privy їх немає ніколи:
//    claim'и — це `sub` (DID), `sid`, `iss`, `aud`, `iat`, `exp`. Роль же
//    прив'язана до адреси, а не до облікового запису входу (FR-034a), тож без
//    кроку DID → гаманці сесія не має чим шукати повноваження.
//
// Клієнт не бере адресу з тіла запиту принципово: значення, яке надсилає
// браузер, доводить лише те, що браузер уміє його надрукувати.
import { addressSchema } from '@forge/shared/primitives'
import { importSPKI, type JWTPayload, jwtVerify, type KeyObject } from 'jose'
import { z } from 'zod'
import { internal, unauthorized } from './errors.ts'

/** Privy підписує токени доступу ES256 і тільки ним. */
const ALGORITHM = 'ES256'
const ISSUER = 'privy.io'

/**
 * Скільки склад гаманців живе в кеші.
 *
 * Хвилина — це вікно, у якому відв'язаний у Privy гаманець ще вважається
 * підтвердженим. Воно свідоме: сам по собі гаманець нічого не дозволяє, бо
 * повноваження дає рядок у складі емітента, який читається з бази **на кожен
 * запит** і не кешується. Без кешу ж кожне звертання до консолі — це запит до
 * стороннього сервісу на шляху відповіді.
 */
const CACHE_TTL_MS = 60_000

/** Стеля кешу: після неї витісняється найдавніше вставлений запис. */
const CACHE_MAX_ENTRIES = 1_000

export interface PrivyUser {
  /** DID: `did:privy:...`. Ролей не несе — це ідентифікатор входу. */
  userId: string
  /** Підтверджені Solana-адреси акаунта: вбудований гаманець і зовнішні. */
  wallets: string[]
}

export interface PrivyClient {
  authenticate(token: string): Promise<PrivyUser>
}

export interface PrivyClientOptions {
  appId: string
  appSecret: string
  /** PEM SPKI публічного ключа застосунку. */
  verificationKey: string
  apiUrl: string
  /** Підмінюється в тестах — мережі в них немає. */
  fetch?: typeof globalThis.fetch
  now?: () => number
  cacheTtlMs?: number
}

/**
 * Відповідь Privy читається `looseObject`: сервіс додає поля до пов'язаних
 * акаунтів між релізами, і сувора схема робила б будь-яке нове поле відмовою
 * входу. Ми забираємо рівно те, що читаємо, і не заперечуємо проти решти.
 */
const linkedAccountSchema = z.looseObject({
  type: z.string(),
  address: z.string().optional(),
  chain_type: z.string().optional(),
})

const privyUserSchema = z.looseObject({
  id: z.string().min(1),
  linked_accounts: z.array(linkedAccountSchema).default([]),
})

interface CacheEntry {
  wallets: string[]
  expiresAt: number
}

export function createPrivyClient(options: PrivyClientOptions): PrivyClient {
  const doFetch = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now
  const ttl = options.cacheTtlMs ?? CACHE_TTL_MS
  const cache = new Map<string, CacheEntry>()

  // Ключ імпортується один раз і лениво: розбір PEM коштує помітно більше за
  // саму перевірку підпису, а падати на битому ключі краще при першому вході,
  // ніж на старті процесу, який ще нічого не обслуговує.
  let keyPromise: Promise<CryptoKey | KeyObject> | undefined
  const key = () => {
    keyPromise ??= importSPKI(options.verificationKey, ALGORITHM)
    return keyPromise
  }

  const authorization = `Basic ${Buffer.from(`${options.appId}:${options.appSecret}`).toString('base64')}`

  async function verify(token: string): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(token, await key(), {
        issuer: ISSUER,
        audience: options.appId,
        algorithms: [ALGORITHM],
      })
      return payload
    } catch {
      // Причина відмови назовні не йде: «прострочений» проти «чужий підпис» —
      // це підказка тому, хто підбирає токени, і нікому більше.
      throw unauthorized('invalid or expired access token')
    }
  }

  async function fetchWallets(userId: string): Promise<string[]> {
    let response: Response
    try {
      response = await doFetch(`${options.apiUrl}/api/v1/users/${encodeURIComponent(userId)}`, {
        headers: {
          authorization,
          'privy-app-id': options.appId,
          accept: 'application/json',
        },
      })
    } catch (cause) {
      throw internal('login provider is unreachable', { cause: String(cause) })
    }

    // Токен підписаний нашим застосунком, але користувача вже немає — це вхід,
    // що не веде нікуди, а не збій сервера.
    if (response.status === 404) throw unauthorized('login account no longer exists')
    if (!response.ok) {
      throw internal('login provider returned an error', { status: response.status })
    }

    const parsed = privyUserSchema.safeParse(await response.json())
    if (!parsed.success) throw internal('login provider returned an unexpected payload')

    const wallets = parsed.data.linked_accounts
      .filter((a) => a.type === 'wallet' && a.chain_type === 'solana')
      .map((a) => a.address)
      // Адреса іншої мережі або порожній рядок тут не помилка постачальника —
      // акаунт законно тримає гаманці кількох ланцюгів. Нас цікавлять ті, які
      // взагалі можуть стояти у складі емітента.
      .filter((a): a is string => addressSchema.safeParse(a).success)

    return [...new Set(wallets)]
  }

  async function wallets(userId: string): Promise<string[]> {
    const cached = cache.get(userId)
    if (cached && cached.expiresAt > now()) return cached.wallets

    const fresh = await fetchWallets(userId)
    if (cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next()
      if (!oldest.done) cache.delete(oldest.value)
    }
    cache.set(userId, { wallets: fresh, expiresAt: now() + ttl })
    return fresh
  }

  return {
    async authenticate(token: string): Promise<PrivyUser> {
      const payload = await verify(token)
      const userId = payload.sub
      if (!userId) throw unauthorized('access token has no subject')
      return { userId, wallets: await wallets(userId) }
    },
  }
}
