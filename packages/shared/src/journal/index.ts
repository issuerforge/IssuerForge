// The journal's wire format: what `GET /api/tokens/:mint/journal` writes and
// what `tools/verify-journal` (T033) reads (FR-018, SC-006).
//
// It lives in `shared` because it has **two** implementations that must not
// drift: the api produces the file, the verifier consumes it, and the verifier
// deliberately never imports the api — that is the whole point of SC-006. A
// format described only on the producing side would be verified against
// itself.
//
// One line — one JSON object, newline-separated (NDJSON). The events are
// exactly `IndexedEvent` as `../events` defines them, with no re-shaping: the
// verifier compares a line's fields against what `getTransaction` returned, and
// every conversion along that path would be a place where reconciliation
// diverges on format instead of on substance.
import { z } from 'zod'
import { indexedEventSchema } from '../events/index.ts'
import { addressSchema, slotSchema } from '../primitives.ts'

/**
 * The format version. Bumped when a line stops meaning what it meant — not
 * when a new event kind appears, because the `kind` discriminator already
 * makes that additive.
 *
 * It is in the file rather than only in the HTTP headers: an exported journal
 * is read from disk months later, by a script that never saw the response.
 */
export const JOURNAL_FORMAT_VERSION = 1

/** NDJSON. `application/json` would promise the whole file parses as one value. */
export const JOURNAL_CONTENT_TYPE = 'application/x-ndjson'

/**
 * The first line of the file: what this export claims to be.
 *
 * It exists for one reason — **a truncated file must be visible without an
 * RPC**. A journal that lost its last two hundred lines to a dropped
 * connection reconciles perfectly against the network: every line it still has
 * is real. `count` is what turns that silence into a mismatch.
 *
 * The manifest is **not trusted data**. It is produced by the same side that
 * produced the lines, so the verifier re-derives the window from the chain and
 * compares; the manifest only says *which* window to look at, which is
 * something the verifier otherwise has to be told by hand.
 *
 * The bounds are slots, never dates, even when the export was requested by
 * date: a slot is what the network orders by, and it is the only bound a
 * verifier can turn back into a set of transactions.
 */
export const journalManifestSchema = z.object({
  kind: z.literal('manifest'),
  version: z.literal(JOURNAL_FORMAT_VERSION),
  issuerId: addressSchema,
  mint: addressSchema,
  /** The program the events came from; the verifier scans its signatures. */
  programId: addressSchema,
  /** Inclusive. An empty export legitimately has `fromSlot > toSlot`. */
  fromSlot: slotSchema,
  toSlot: slotSchema,
  /** Event lines in this file, not counting this one. */
  count: z.number().int().nonnegative(),
  /**
   * How far the indexer had got when the file was written.
   *
   * `toSlot` never goes past it, and the difference between the two is the
   * honest answer to "is the journal short because nothing happened, or
   * because we have not read that far yet". Without this field a lagging
   * mirror and an empty period look identical — and in a compliance product
   * those are opposite answers.
   */
  indexedThroughSlot: slotSchema,
  /** When the file was produced. Metadata about the export, not about the chain. */
  exportedAt: z.iso.datetime(),
})

export type JournalManifest = z.infer<typeof journalManifestSchema>

/**
 * Any line of the file.
 *
 * A union discriminated by the same `kind` the events already carry, so
 * `manifest` simply takes its place among them: a reader switches once
 * instead of special-casing the first line by position.
 */
export const journalLineSchema = z.discriminatedUnion('kind', [
  journalManifestSchema,
  indexedEventSchema,
])

export type JournalLine = z.infer<typeof journalLineSchema>

/** One NDJSON line, terminator included. Every writer goes through here. */
export function journalLine(line: JournalLine): string {
  return `${JSON.stringify(line)}\n`
}
