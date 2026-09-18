// Choosing the tenant when a person is in several issuers' memberships.
//
// This is client state, not a right: the api checks `X-Issuer-Id` against
// memberships already proven and can only narrow the choice
// (`apps/api/src/session.ts`). So a forged value in browser storage gives
// nothing — it is either among the memberships or rejected.
//
// Only one thing is hard here: the stored issuer may vanish from the
// membership between sessions (the role was revoked by quorum). The console
// must notice that and say so out loud, rather than show a blank screen with a
// header the api answers 400 to.

/** The storage key. One per app; the prefix is there to avoid colliding with someone else's. */
export const TENANT_STORAGE_KEY = 'issuerforge.issuerId'

export interface TenantChoice {
  /** The issuer on whose behalf requests go. `undefined` — a choice is needed. */
  issuerId: string | undefined
  /**
   * The stored choice is no longer among the memberships: the role was
   * revoked or the storage entry is someone else's. The console shows this
   * once and clears the storage.
   */
  dropped: string | undefined
}

/**
 * Reconciles the stored choice with the set of memberships.
 *
 * A single membership overrides the stored value rather than being checked
 * against it: a person left with one issuer must not be stopped by a record
 * of one that is gone.
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
 * Storage reads and writes are wrapped because `localStorage` throws in
 * private mode and with site data disabled. Failing on that would mean
 * keeping someone out of the console over a browser setting that has nothing
 * to do with roles.
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
    // The choice stays in the tab's memory — enough to work with.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}
