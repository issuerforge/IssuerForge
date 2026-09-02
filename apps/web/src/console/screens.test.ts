import { ROLE, ROLE_ALL, roleMaskSchema } from '@forge/shared/api'
import { describe, expect, it } from 'vitest'
import { landingFor, permits, SCREENS, screenAt, screensFor } from './screens'

describe('the screen registry', () => {
  it('has no two screens on one path', () => {
    const paths = SCREENS.map((s) => s.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('names only roles the session can actually carry', () => {
    for (const screen of SCREENS) {
      expect(() => roleMaskSchema.parse(screen.requires)).not.toThrow()
    }
  })

  it('opens every screen to the full mask', () => {
    expect(screensFor(ROLE_ALL)).toHaveLength(SCREENS.length)
  })

  it('leaves an observer with something to open', () => {
    // OBSERVER не має жодного повноваження, крім читання, і саме тому це
    // найгостріший випадок: роль, яка нікуди не веде, — це білий екран.
    const open = screensFor(ROLE.OBSERVER)
    expect(open.length).toBeGreaterThan(0)
    expect(open.every((s) => permits(ROLE.OBSERVER, s))).toBe(true)
  })

  it('keeps the operational key screen to admins', () => {
    const delegation = screenAt('/settings/delegation')
    expect(delegation).toBeDefined()
    expect(permits(ROLE.ADMIN, delegation as (typeof SCREENS)[number])).toBe(true)
    expect(permits(ROLE.OBSERVER, delegation as (typeof SCREENS)[number])).toBe(false)
    expect(permits(ROLE.ATTESTOR, delegation as (typeof SCREENS)[number])).toBe(false)
  })

  it('lets an attestor open attestation and nothing an admin owns', () => {
    const paths = screensFor(ROLE.ATTESTOR).map((s) => s.path)
    expect(paths).toContain('/attest')
    expect(paths).not.toContain('/issue')
    expect(paths).not.toContain('/settings/delegation')
  })

  it('gives compliance the holders queue and the case screen', () => {
    const paths = screensFor(ROLE.COMPLIANCE).map((s) => s.path)
    expect(paths).toEqual(expect.arrayContaining(['/console/holders', '/console/actions']))
  })

  it('adds up: a mask of two roles opens the union of both', () => {
    const union = screensFor(ROLE.ATTESTOR | ROLE.COMPLIANCE).map((s) => s.path)
    const apart = new Set([
      ...screensFor(ROLE.ATTESTOR).map((s) => s.path),
      ...screensFor(ROLE.COMPLIANCE).map((s) => s.path),
    ])
    expect(new Set(union)).toEqual(apart)
  })

  it('matches a path exactly, so an unknown path is a 404 and not a guess', () => {
    expect(screenAt('/console')?.path).toBe('/console')
    expect(screenAt('/console/')).toBeUndefined()
    expect(screenAt('/console/holders/7xKX')).toBeUndefined()
  })

  it('lands every single role somewhere', () => {
    for (const role of Object.values(ROLE)) {
      expect(landingFor(role)).toBeDefined()
    }
  })
})
