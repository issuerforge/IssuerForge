// Вибір орендаря, коли людина у складі кількох емітентів.
//
// Це стан клієнта, а не право: api звіряє `X-Issuer-Id` з уже доведеними
// членствами й уміє тільки звузити вибір (`apps/api/src/session.ts`). Тому
// підроблене значення в сховищі браузера не дає нічого — воно або серед
// членств, або відкидається.
//
// Складне тут одне: збережений емітент може зникнути зі складу між сеансами
// (роль відкликали кворумом). Консоль мусить це помітити й сказати вголос, а не
// показати порожній екран із заголовком, якому api відповідає 400.

/** Ключ сховища. Один на застосунок; префікс — щоб не збігтися з чужим. */
export const TENANT_STORAGE_KEY = 'issuerforge.issuerId'

export interface TenantChoice {
  /** Емітент, від імені якого йдуть запити. `undefined` — треба обрати. */
  issuerId: string | undefined
  /**
   * Збережений вибір більше не серед членств: роль відкликали або запис у
   * сховищі чужий. Консоль показує це один раз і чистить сховище.
   */
  dropped: string | undefined
}

/**
 * Зводить збережений вибір зі складом членств.
 *
 * Єдине членство перекриває збережене значення, а не звіряється з ним: людину,
 * у якої лишився один емітент, не має зупиняти запис про той, якого вже немає.
 */
export function resolveTenant(
  issuerIds: readonly string[],
  stored: string | null | undefined,
): TenantChoice {
  const only = issuerIds.length === 1 ? issuerIds[0] : undefined
  if (only !== undefined) {
    return { issuerId: only, dropped: stored != null && stored !== only ? stored : undefined }
  }

  if (stored == null || stored === '') return { issuerId: undefined, dropped: undefined }
  if (issuerIds.includes(stored)) return { issuerId: stored, dropped: undefined }
  return { issuerId: undefined, dropped: stored }
}

/**
 * Читання й запис сховища загорнуті, бо `localStorage` кидає в приватному
 * режимі й за вимкнених даних сайту. Впасти на цьому — значить не пустити в
 * консоль через налаштування браузера, яке до ролей не має стосунку.
 */
export function readStoredTenant(storage: Storage | undefined = safeStorage()): string | null {
  try {
    return storage?.getItem(TENANT_STORAGE_KEY) ?? null
  } catch {
    return null
  }
}

export function writeStoredTenant(
  issuerId: string | undefined,
  storage: Storage | undefined = safeStorage(),
): void {
  try {
    if (issuerId === undefined) storage?.removeItem(TENANT_STORAGE_KEY)
    else storage?.setItem(TENANT_STORAGE_KEY, issuerId)
  } catch {
    // Вибір лишається в пам'яті вкладки — цього достатньо, щоб працювати.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}
