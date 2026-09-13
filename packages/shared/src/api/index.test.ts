import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DELEGATION,
  DELEGATION_ALL,
  hasPower,
  hasRole,
  membershipSchema,
  powerNames,
  ROLE,
  ROLE_ALL,
  ROLE_AUTHORISING,
  roleNames,
  sessionSchema,
} from './index.ts'

const ISSUER_RS = fileURLToPath(
  new URL('../../../../programs/issuer-forge/src/state/issuer.rs', import.meta.url),
)

/**
 * `pub const ADMIN: u8 = 1 << 0;` → 1. Дужок і арифметики складнішої там немає.
 *
 * Ловить обидві маски одного файла — ролей і делегації: імена не перетинаються,
 * а зайвий запис у мапі нікому не заважає.
 */
function rustRoleBits(source: string): Record<string, number> {
  const bits: Record<string, number> = {}
  for (const m of source.matchAll(/pub const (?<name>[A-Z_]+): u8 = 1 << (?<shift>\d+);/g)) {
    const { name, shift } = m.groups ?? {}
    if (name !== undefined && shift !== undefined) bits[name] = 1 << Number(shift)
  }
  return bits
}

describe('маска ролей', () => {
  // Це той самий дубль, що й у `CHECK` бази: маска їде ланцюг → база → екран
  // без перекодування, тож розійтись їй нема де — але саме тому розходження
  // було б тихим. Тест читає Rust, а не копію числа.
  it('збігається з `role` у програмі', () => {
    const rust = rustRoleBits(readFileSync(ISSUER_RS, 'utf8'))

    expect(rust.ADMIN).toBe(ROLE.ADMIN)
    expect(rust.COMPLIANCE).toBe(ROLE.COMPLIANCE)
    expect(rust.ATTESTOR).toBe(ROLE.ATTESTOR)
    expect(rust.OBSERVER).toBe(ROLE.OBSERVER)
  })

  it('ALL накриває чотири біти, AUTHORISING — дві ролі кворуму', () => {
    expect(ROLE_ALL).toBe(15)
    expect(ROLE_AUTHORISING).toBe(ROLE.ADMIN | ROLE.COMPLIANCE)
    // Атестатор не підписує кворум (FR-024), спостерігач не діє (FR-033).
    expect(hasRole(ROLE_AUTHORISING, ROLE.ATTESTOR)).toBe(false)
    expect(hasRole(ROLE_AUTHORISING, ROLE.OBSERVER)).toBe(false)
  })

  it('розкладається на імена в порядку бітів', () => {
    expect(roleNames(ROLE.ADMIN | ROLE.COMPLIANCE)).toEqual(['ADMIN', 'COMPLIANCE'])
    expect(roleNames(ROLE.OBSERVER)).toEqual(['OBSERVER'])
  })
})

describe('маска делегації', () => {
  // Той самий дубль, що й у ролей, і з тієї ж причини: маска їде з
  // `IssuerConfig.delegation_mask` просто числом, тож розходження було б тихим.
  it('збігається з `delegation` у програмі', () => {
    const rust = rustRoleBits(readFileSync(ISSUER_RS, 'utf8'))

    expect(rust.THAW_HOLDER).toBe(DELEGATION.THAW_HOLDER)
    expect(rust.SET_HOLDER_STATUS).toBe(DELEGATION.SET_HOLDER_STATUS)
    expect(rust.SETTLE_REDEMPTION).toBe(DELEGATION.SETTLE_REDEMPTION)
  })

  /**
   * Перелік закритий у програмі: у масці немає й не може бути повноваження, що
   * рухає кошти (FR-035a). Тест тримає саме це — не «три біти», а те, що навіть
   * **повна** делегація не накриває нічого, крім трьох рутинних дій.
   */
  it('повна делегація накриває рівно три рутинні дії', () => {
    expect(DELEGATION_ALL).toBe(7)
    expect(powerNames(DELEGATION_ALL)).toEqual([
      'THAW_HOLDER',
      'SET_HOLDER_STATUS',
      'SETTLE_REDEMPTION',
    ])
  })

  it('порожня маска не дає нічого', () => {
    expect(hasPower(0, DELEGATION.THAW_HOLDER)).toBe(false)
    expect(powerNames(0)).toEqual([])
  })

  // Біти двох масок збігаються числами, і саме тому імена функцій різні:
  // `hasRole` над маскою делегації мовчки відповів би «так».
  it('розморожування без права на статус — це різні біти', () => {
    expect(hasPower(DELEGATION.THAW_HOLDER, DELEGATION.SET_HOLDER_STATUS)).toBe(false)
    expect(powerNames(DELEGATION.THAW_HOLDER)).toEqual(['THAW_HOLDER'])
  })
})

describe('схема членства', () => {
  const valid = {
    issuerId: '11111111111111111111111111111112',
    roles: ROLE.ADMIN,
    wallets: ['11111111111111111111111111111112'],
    syncedAt: new Date().toISOString(),
  }

  it('приймає повне членство', () => {
    expect(membershipSchema.safeParse(valid).success).toBe(true)
  })

  // Порожня маска — вільний слот складу, а не учасник без прав: у дзеркалі
  // такого рядка немає, і в сесії він не має з'явитись поготів.
  it('відхиляє порожню маску ролей', () => {
    expect(membershipSchema.safeParse({ ...valid, roles: 0 }).success).toBe(false)
  })

  it('відхиляє невідомий біт', () => {
    expect(membershipSchema.safeParse({ ...valid, roles: 1 << 6 }).success).toBe(false)
  })

  it('відхиляє членство без жодної адреси', () => {
    expect(membershipSchema.safeParse({ ...valid, wallets: [] }).success).toBe(false)
  })
})

describe('схема сесії', () => {
  it('вимагає щонайменше одне членство', () => {
    const result = sessionSchema.safeParse({
      userId: 'did:privy:test',
      wallets: [],
      issuerId: '11111111111111111111111111111112',
      roles: ROLE.ADMIN,
      memberships: [],
    })
    expect(result.success).toBe(false)
  })
})
