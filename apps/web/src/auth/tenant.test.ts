import { describe, expect, it } from 'vitest'
import { readStoredTenant, resolveTenant, TENANT_STORAGE_KEY, writeStoredTenant } from './tenant'

const ONE = 'Iss1'
const TWO = 'Iss2'

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed))
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  }
}

/** Сховище, яке кидає на кожній дії: приватний режим, вимкнені дані сайту. */
const hostileStorage = (): Storage =>
  new Proxy({} as Storage, {
    get() {
      throw new DOMException('access denied', 'SecurityError')
    },
  })

describe('resolveTenant', () => {
  it('picks the only membership and ignores what was stored', () => {
    expect(resolveTenant([ONE], TWO)).toEqual({ issuerId: ONE, dropped: TWO })
    expect(resolveTenant([ONE], null)).toEqual({ issuerId: ONE, dropped: undefined })
  })

  it('keeps a stored choice that is still among the memberships', () => {
    expect(resolveTenant([ONE, TWO], TWO)).toEqual({ issuerId: TWO, dropped: undefined })
  })

  // Роль відкликають кворумом, і збережений вибір переживає це відкликання.
  it('drops a stored choice the memberships no longer contain', () => {
    expect(resolveTenant([ONE, TWO], 'Iss3')).toEqual({ issuerId: undefined, dropped: 'Iss3' })
  })

  it('asks for a choice when several memberships and nothing stored', () => {
    expect(resolveTenant([ONE, TWO], null)).toEqual({ issuerId: undefined, dropped: undefined })
    expect(resolveTenant([ONE, TWO], '')).toEqual({ issuerId: undefined, dropped: undefined })
  })

  // Порожній склад — це `UNAUTHORIZED` від api, і до вибору справа не доходить.
  // Але збережений емітент цю адресу справді більше не називає, тож він
  // відкинутий: інше значення тут було б неправдою заради круглішого тесту.
  it('drops the stored choice when there is no membership at all', () => {
    expect(resolveTenant([], ONE)).toEqual({ issuerId: undefined, dropped: ONE })
  })
})

describe('the tenant store', () => {
  it('round-trips a choice and clears it', () => {
    const storage = memoryStorage()
    writeStoredTenant(ONE, storage)
    expect(storage.getItem(TENANT_STORAGE_KEY)).toBe(ONE)
    expect(readStoredTenant(storage)).toBe(ONE)

    writeStoredTenant(undefined, storage)
    expect(readStoredTenant(storage)).toBeNull()
  })

  // Не пустити в консоль через налаштування приватності браузера було б
  // відмовою з причини, яка до ролей не має стосунку.
  it('survives a storage that throws on every access', () => {
    const storage = hostileStorage()
    expect(() => writeStoredTenant(ONE, storage)).not.toThrow()
    expect(readStoredTenant(storage)).toBeNull()
  })

  it('survives no storage at all', () => {
    expect(readStoredTenant(undefined)).toBeNull()
    expect(() => writeStoredTenant(ONE, undefined)).not.toThrow()
  })
})
