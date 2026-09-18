// The mirror of the issuer's membership in the database — what the indexer
// writes in the product.
//
// **This is the largest part of the `--api` path, and it is not visible from
// the task description.** Powers in the api come not from the login token
// but from a row in `role_assignments` (`apps/api/src/directory.ts`): the
// session takes `issuer_id` and the roles from there. Those rows mirror the
// on-chain `IssuerConfig.members`, and they are filled by **T031**, which
// does not exist yet: it is in M2. So the demo writes them itself, and does
// so exactly as the indexer would — from the same values and with the same
// slot.
//
// The `issuers` row is needed not by the api (it does not read it at all)
// but by the foreign key from `tokens`: without the issuer the number
// reservation would fail on the FK.
//
// **When T031 arrives, this file must disappear**, not stay as "a quick path
// for the demo": two sources of the mirror would diverge silently.
import { createDatabase, type Database, issuers, roleAssignments } from '@forge/db'
import { ROLE } from '@forge/shared/api'
import type { PublicKey } from '@solana/web3.js'
import type { DemoKeys } from './context.ts'

export interface SeedInput {
  readonly issuerId: PublicKey
  readonly keys: DemoKeys
  readonly quorumN: number
  readonly delegationMask: number
  /** The slot at which the membership became this. The indexer writes the one it read. */
  readonly slot: number
}

/**
 * The demo membership in the database: three rows in the same order as in
 * `initialize_issuer`.
 *
 * `member_index` is not the row's ordinal but the **membership slot**: the
 * quorum reads the signature bitmap by it (T025). It cannot diverge from the
 * chain, so it is taken from the same list the instruction was built from.
 */
export async function seedIssuer(db: Database, input: SeedInput): Promise<void> {
  const { keys, issuerId } = input
  const id = issuerId.toBase58()
  const syncedAt = new Date()

  await db
    .insert(issuers)
    .values({
      issuerId: id,
      legalName: 'Vantara Microfinance PLC',
      jurisdiction: 'NG',
      founderWallet: keys.founder.publicKey.toBase58(),
      quorumN: input.quorumN,
      operationalKey: keys.operational.publicKey.toBase58(),
      delegationMask: input.delegationMask,
      sourceSlot: input.slot,
      syncedAt,
    })
    .onConflictDoNothing()

  const members = [
    { wallet: keys.founder.publicKey.toBase58(), roles: ROLE.ADMIN },
    { wallet: keys.officer.publicKey.toBase58(), roles: ROLE.COMPLIANCE },
    { wallet: keys.attestor.publicKey.toBase58(), roles: ROLE.ATTESTOR },
  ]

  await db
    .insert(roleAssignments)
    .values(
      members.map((member, memberIndex) => ({
        issuerId: id,
        memberIndex,
        wallet: member.wallet,
        roles: member.roles,
        sourceSlot: input.slot,
        syncedAt,
      })),
    )
    .onConflictDoNothing()
}

export function openDatabase(url: string): Database {
  return createDatabase(url)
}

/**
 * Closes the connection pool.
 *
 * Without this the demo process does not exit **after a successful run**:
 * `postgres` keeps the socket open, and the event loop never drains. The
 * symptom is insidious because all the numbers are already printed — the run
 * looks done and simply hangs.
 */
export async function closeDatabase(db: Database): Promise<void> {
  await db.$client.end({ timeout: 5 })
}
