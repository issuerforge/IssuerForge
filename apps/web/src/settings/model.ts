// The delegation screen without React: what each power means, masks to and
// from names, and how a change reads in the history.
//
// Names, not bits, everywhere a person reads: "THAW_HOLDER → nothing" is a
// sentence an admin can check, "3 → 0" is a sum.
import { DELEGATION, POWER_NAMES, type PowerName, powerNames } from '@forge/shared/api'

/** What the platform does with each power — the line under its name on the screen. */
export const POWER_TEXT: Record<PowerName, { label: string; does: string }> = {
  THAW_HOLDER: {
    label: 'Let holders in',
    does: 'Thaw a queued holder’s account and write its first status — onboarding without an issuer signature.',
  },
  SET_HOLDER_STATUS: {
    label: 'Keep the status register',
    does: 'Change a holder’s tier, jurisdiction, expiry or denial in the issuer’s own register.',
  },
  SETTLE_REDEMPTION: {
    label: 'Settle redemptions',
    does: 'Close a redemption once its payout is confirmed. Arrives with redemptions; nothing uses it yet.',
  },
}

export function maskOf(powers: readonly PowerName[]): number {
  return powers.reduce((mask, power) => mask | DELEGATION[power], 0)
}

/** A mask as words: the labels of its powers, or "nothing". */
export function describeMask(mask: number): string {
  const names = powerNames(mask)
  return names.length === 0 ? 'nothing' : names.map((name) => POWER_TEXT[name].label).join(', ')
}

export interface ChangeLike {
  readonly previousKey: string | null
  readonly previousMask: number
  readonly operationalKey: string
  readonly mask: number
}

export type ChangeKind = 'revocation' | 'grant' | 'rotation' | 'regrant'

/**
 * What a change was, in the program's own terms: only a narrowing of the same
 * key is a revocation (one admin may sign it); a new key is a rotation; any
 * new bit on the same key is a grant. A change that both adds and removes is
 * a grant — it hands the platform something, so it took the quorum.
 */
export function changeKind(change: ChangeLike): ChangeKind {
  if (change.previousKey !== null && change.previousKey !== change.operationalKey) return 'rotation'
  const added = change.mask & ~change.previousMask
  if (added === 0) return 'revocation'
  return change.previousMask === 0 ? 'grant' : 'regrant'
}

export const CHANGE_LABEL: Record<ChangeKind, string> = {
  revocation: 'Revoked',
  grant: 'Granted',
  regrant: 'Changed',
  rotation: 'Key rotated',
}

/** The powers the form starts from: what the key holds now. */
export const ALL_POWERS: readonly PowerName[] = POWER_NAMES
