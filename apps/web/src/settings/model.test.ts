import { DELEGATION, DELEGATION_ALL, POWER_NAMES } from '@forge/shared/api'
import { describe, expect, it } from 'vitest'
import { changeKind, describeMask, maskOf, POWER_TEXT } from './model.ts'

const KEY = 'SysvarRecentB1ockHashes11111111111111111111'
const NEXT = 'SysvarS1otHistory11111111111111111111111111'
const BOTH = DELEGATION.THAW_HOLDER | DELEGATION.SET_HOLDER_STATUS

describe('powers as words', () => {
  it('describes every power the closed list has', () => {
    // A power added to `DELEGATION` without a line here would show as a bare
    // constant on the screen an admin revokes from.
    expect(Object.keys(POWER_TEXT).sort()).toEqual([...POWER_NAMES].sort())
  })

  it('turns names into the mask and back into words', () => {
    expect(maskOf(['THAW_HOLDER', 'SET_HOLDER_STATUS'])).toBe(BOTH)
    expect(maskOf([...POWER_NAMES])).toBe(DELEGATION_ALL)
    expect(describeMask(BOTH)).toBe('Let holders in, Keep the status register')
    expect(describeMask(0)).toBe('nothing')
  })
})

describe('what a change was', () => {
  it('a narrowing of the same key is a revocation, down to nothing', () => {
    const change = { previousKey: KEY, operationalKey: KEY }
    expect(changeKind({ ...change, previousMask: BOTH, mask: DELEGATION.THAW_HOLDER })).toBe(
      'revocation',
    )
    expect(changeKind({ ...change, previousMask: BOTH, mask: 0 })).toBe('revocation')
  })

  it('a new bit is a grant, even when another goes', () => {
    const change = { previousKey: KEY, operationalKey: KEY }
    expect(changeKind({ ...change, previousMask: 0, mask: BOTH })).toBe('grant')
    expect(
      changeKind({
        ...change,
        previousMask: DELEGATION.THAW_HOLDER,
        mask: DELEGATION.SET_HOLDER_STATUS,
      }),
    ).toBe('regrant')
  })

  it('a new key is a rotation, whatever the mask does', () => {
    expect(
      changeKind({ previousKey: KEY, previousMask: BOTH, operationalKey: NEXT, mask: 0 }),
    ).toBe('rotation')
  })
})
