// The history of an issuer's delegation (FR-035b), from the indexer's
// `delegation_changes`.
//
// **The current delegation is not read here.** What the operational key may
// do right now decides whether our key signs, and the api reads that from the
// chain (`ChainReader.issuerConfig`) — a revocation is in force from its
// confirmation, not from the moment the indexer learns of it. This store
// answers only "who changed it, when and how", and every row carries the
// signature anyone can check against the network.
import { type Database, delegationChanges } from '@forge/db'
import { desc, eq } from 'drizzle-orm'

export interface DelegationChangeRow {
  readonly signature: string
  readonly slot: number
  readonly blockTime: number | null
  readonly previousKey: string | null
  readonly previousMask: number
  readonly operationalKey: string
  readonly mask: number
  readonly path: 'immediate' | 'proposal'
  readonly proposal: string | null
  readonly signers: readonly string[]
}

export interface DelegationStore {
  /** Newest first. */
  history(issuerId: string, limit: number): Promise<DelegationChangeRow[]>
}

/** How many changes the screen shows. A key is rotated rarely; fifty is years of them. */
export const HISTORY_LIMIT = 50

export function createDelegationStore(db: Database): DelegationStore {
  return {
    async history(issuerId, limit) {
      const rows = await db
        .select()
        .from(delegationChanges)
        .where(eq(delegationChanges.issuerId, issuerId))
        .orderBy(desc(delegationChanges.slot), desc(delegationChanges.changeIndex))
        .limit(limit)
      return rows.map((row) => ({
        signature: row.signature,
        slot: row.slot,
        blockTime: row.blockTime,
        previousKey: row.previousKey,
        previousMask: row.previousMask,
        operationalKey: row.operationalKey,
        mask: row.mask,
        path: row.path,
        proposal: row.proposal,
        signers: row.signers,
      }))
    },
  }
}
