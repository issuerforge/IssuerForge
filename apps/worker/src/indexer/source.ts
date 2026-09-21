// Where signatures come from: the backfill and the subscription.
//
// The subscription is the fast path, the backfill the complete one. A
// dropped socket therefore costs latency, never records — and a transaction
// that failed to apply is met again by the next backfill pass, which starts
// from the cursor rather than from where the subscription got to.
//
// Both mention the program's address. That covers more than the program's
// own instructions: the hook program sits in the account list of every
// transfer of a mint with the hook, refused or not, so transfers and
// refusals come through the same door as everything else.
import type { Connection, PublicKey } from '@solana/web3.js'
import type { Seen } from './cursor.ts'

/** The most signatures one `getSignaturesForAddress` answers with. */
const PAGE = 1_000

/**
 * Every signature newer than `since`, oldest first — the order they must
 * be applied in. The node answers newest first and one page at a time, so
 * pages are walked backwards from the tip until `since` (or the program's
 * first transaction) and then reversed.
 *
 * Without a cursor this is the program's whole history, and that is
 * intended: the first run of an empty database builds the whole mirror.
 */
export async function signaturesSince(
  connection: Connection,
  programId: PublicKey,
  since: string | undefined,
): Promise<Seen[]> {
  const collected: Seen[] = []
  let before: string | undefined

  for (;;) {
    const page = await connection.getSignaturesForAddress(
      programId,
      {
        limit: PAGE,
        ...(before === undefined ? {} : { before }),
        ...(since === undefined ? {} : { until: since }),
      },
      'confirmed',
    )
    for (const entry of page) collected.push({ signature: entry.signature, slot: entry.slot })
    const last = page.at(-1)
    if (page.length < PAGE || last === undefined) break
    before = last.signature
  }

  return collected.reverse()
}

export interface Subscription {
  stop(): Promise<void>
}

/**
 * The log subscription for everything that mentions the program. Only
 * `confirmed`: `processed` can be rolled back, and a rolled-back transfer in
 * the feed would be a lie.
 *
 * The notification carries the signature and the slot, which is all the
 * indexer takes from it — the transaction itself is fetched in full when it
 * is applied. `Connection` reconnects the socket by itself.
 */
export function subscribeSignatures(
  connection: Connection,
  programId: PublicKey,
  onSeen: (seen: Seen) => void,
): Subscription {
  const id = connection.onLogs(
    programId,
    (logs, context) => onSeen({ signature: logs.signature, slot: context.slot }),
    'confirmed',
  )
  return {
    stop: () => connection.removeOnLogsListener(id),
  }
}
