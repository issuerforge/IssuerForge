// From decoded facts to rows.
//
// The mirror tables were designed before the indexer existed
// (`packages/db/src/schema.ts`), and each of them already has a writer of
// its own in the api: the wizard reserves the `tokens` row, the queue route
// writes `holders`. This file does not replace those writers; it is the one
// that is allowed to say a row is **confirmed** — `source_slot` and
// `synced_at` are set here and nowhere else, because only this process has
// read the transaction that makes them true.
//
// Every write is idempotent by key. The queue re-delivers after a dropped
// connection, the backfill re-reads the slot of the cursor, and a second
// application of the same transaction must change nothing.
import {
  type Database,
  events,
  holders,
  indexerState,
  issuers,
  roleAssignments,
  tokens,
} from '@forge/db'
import { and, eq, sql } from 'drizzle-orm'
import type { Cursor, CursorStore } from './cursor.ts'
import type { Decoded, EventRecord, MirrorChange } from './decode.ts'
import type { TransactionView } from './transaction.ts'

/** When a fact became true: the slot of its transaction, and when this process read it. */
export interface Stamp {
  readonly slot: number
  /** The block's time, or the moment of reading where the node reported none. */
  readonly at: Date
  readonly syncedAt: Date
}

/**
 * The writes, one per fact. An interface, not the database itself, so that
 * the applier's ordering is tested against a recording fake; the Drizzle
 * implementation below is straight-line SQL with nothing to test but the
 * database it needs.
 */
export interface Writer {
  applyChange(change: MirrorChange, stamp: Stamp): Promise<void>
  insertEvents(records: readonly EventRecord[]): Promise<void>
}

export type Applier = (tx: TransactionView, decoded: Decoded) => Promise<void>

/**
 * Mirror changes before events, in the order they were decoded: the
 * `events` row of a token needs nothing, but a `holders` row needs its
 * `tokens` row, and the `tokens` row its `issuers` row — and the decoder
 * emitted them in the order the instructions ran, which is that order.
 */
export function createApplier(writer: Writer, now: () => Date = () => new Date()): Applier {
  return async (tx, decoded) => {
    const syncedAt = now()
    const stamp: Stamp = {
      slot: tx.slot,
      at: tx.blockTime === null ? syncedAt : new Date(tx.blockTime * 1000),
      syncedAt,
    }
    for (const change of decoded.changes) await writer.applyChange(change, stamp)
    if (decoded.events.length > 0) await writer.insertEvents(decoded.events)
  }
}

// ─── Drizzle ─────────────────────────────────────────────────────────────────

function toDate(seconds: number | null): Date | null {
  return seconds === null ? null : new Date(seconds * 1000)
}

export function drizzleWriter(db: Database): Writer {
  return {
    async applyChange(change, stamp) {
      switch (change.kind) {
        case 'issuer_initialized': {
          // The name and the jurisdiction are not on chain; they stay as they
          // are (or as null) and belong to whoever writes them later.
          await db
            .insert(issuers)
            .values({
              issuerId: change.issuerId,
              founderWallet: change.founderWallet,
              quorumN: change.quorumN,
              operationalKey: change.operationalKey,
              delegationMask: change.delegationMask,
              sourceSlot: stamp.slot,
              syncedAt: stamp.syncedAt,
            })
            .onConflictDoUpdate({
              target: issuers.issuerId,
              set: {
                founderWallet: change.founderWallet,
                quorumN: change.quorumN,
                operationalKey: change.operationalKey,
                delegationMask: change.delegationMask,
                sourceSlot: stamp.slot,
                syncedAt: stamp.syncedAt,
              },
            })
          if (change.members.length === 0) return
          await db
            .insert(roleAssignments)
            .values(
              change.members.map((member) => ({
                issuerId: change.issuerId,
                memberIndex: member.memberIndex,
                wallet: member.wallet,
                roles: member.roles,
                sourceSlot: stamp.slot,
                syncedAt: stamp.syncedAt,
              })),
            )
            .onConflictDoUpdate({
              target: [roleAssignments.issuerId, roleAssignments.memberIndex],
              set: {
                wallet: sql`excluded.wallet`,
                roles: sql`excluded.roles`,
                sourceSlot: stamp.slot,
                syncedAt: stamp.syncedAt,
              },
            })
          return
        }
        case 'token_created':
          // The wizard's reservation already holds the name and the symbol;
          // a token issued past the api (the demo's direct path) gets empty
          // ones here and its real ones from `set_token_metadata`, which
          // follows in the next transaction.
          await db
            .insert(tokens)
            .values({
              mint: change.mint,
              issuerId: change.issuerId,
              symbol: '',
              name: '',
              decimals: change.decimals,
              policyVersion: change.policyVersion,
              state: 'live',
              sourceSlot: stamp.slot,
              syncedAt: stamp.syncedAt,
            })
            .onConflictDoUpdate({
              target: tokens.mint,
              set: {
                decimals: change.decimals,
                policyVersion: change.policyVersion,
                state: 'live',
                sourceSlot: stamp.slot,
                syncedAt: stamp.syncedAt,
              },
            })
          return
        case 'token_metadata':
          await db
            .update(tokens)
            .set({ name: change.name, symbol: change.symbol, syncedAt: stamp.syncedAt })
            .where(eq(tokens.mint, change.mint))
          return
        case 'token_policy':
          await db
            .update(tokens)
            .set({
              policyVersion: change.policyVersion,
              sourceSlot: stamp.slot,
              syncedAt: stamp.syncedAt,
            })
            .where(eq(tokens.mint, change.mint))
          return
        case 'holder_thawed': {
          const status =
            change.status === null
              ? {}
              : {
                  tier: change.status.tier,
                  jurisdiction: change.status.jurisdiction,
                  denied: change.status.denied,
                  expiresAt: toDate(change.status.expiresAt),
                  statusSource: 'issuer' as const,
                }
          // `requested_at` is left to the queue route where it exists, and
          // defaults to the thaw itself where the account never queued.
          await db
            .insert(holders)
            .values({
              mint: change.mint,
              wallet: change.wallet,
              issuerId: change.issuerId,
              ...status,
              state: 'thawed',
              thawedAt: stamp.at,
              requestedAt: stamp.at,
              sourceSlot: stamp.slot,
              syncedAt: stamp.syncedAt,
            })
            .onConflictDoUpdate({
              target: [holders.mint, holders.wallet],
              set: {
                ...status,
                state: 'thawed',
                thawedAt: stamp.at,
                sourceSlot: stamp.slot,
                syncedAt: stamp.syncedAt,
              },
            })
          return
        }
        case 'holder_status':
          // The state is not touched (FR-008b1): a status change admits
          // nothing and freezes nothing — the transfer simply stops passing.
          await db
            .update(holders)
            .set({
              tier: change.status.tier,
              jurisdiction: change.status.jurisdiction,
              denied: change.status.denied,
              expiresAt: toDate(change.status.expiresAt),
              statusSource: 'issuer',
              sourceSlot: stamp.slot,
              syncedAt: stamp.syncedAt,
            })
            .where(and(eq(holders.mint, change.mint), eq(holders.wallet, change.wallet)))
          return
      }
    },

    async insertEvents(records) {
      await db
        .insert(events)
        .values(
          records.map(({ issuerId, event }) => ({
            signature: event.signature,
            eventIndex: event.eventIndex,
            kind: event.kind,
            issuerId,
            mint: event.mint,
            slot: event.slot,
            blockTime: event.blockTime,
            payload: event,
          })),
        )
        .onConflictDoNothing({ target: [events.signature, events.eventIndex] })
    },
  }
}

export function drizzleCursorStore(db: Database, programId: string): CursorStore {
  return {
    async load(): Promise<Cursor | undefined> {
      const [row] = await db
        .select({ signature: indexerState.lastSignature, slot: indexerState.lastSlot })
        .from(indexerState)
        .where(eq(indexerState.programId, programId))
      return row
    },
    async save(cursor) {
      const row = { lastSignature: cursor.signature, lastSlot: cursor.slot, updatedAt: new Date() }
      await db
        .insert(indexerState)
        .values({ programId, ...row })
        .onConflictDoUpdate({ target: indexerState.programId, set: row })
    },
  }
}
