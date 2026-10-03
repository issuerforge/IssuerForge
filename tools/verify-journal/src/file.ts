// Reading the exported file, before any network is asked anything.
//
// Everything here is decided by the file alone: does it parse, does it start
// with a manifest, does it say what it claims to say. None of it confirms a
// single event — a perfectly formed file can be entirely invented — but a
// file that fails here cannot be reconciled honestly, because the window and
// the mint the reconciliation needs come from the manifest.
import type { IndexedEvent } from '@forge/shared/events'
import { type JournalManifest, journalLineSchema } from '@forge/shared/journal'

/** An event together with where it sat in the file — the line a person opens to look. */
export interface JournalEntry {
  readonly line: number
  readonly event: IndexedEvent
}

export interface JournalFile {
  readonly manifest: JournalManifest | null
  readonly entries: readonly JournalEntry[]
  /** What is wrong with the file as a file. Any one of them fails the verification. */
  readonly problems: readonly string[]
}

export function eventKeyOf(event: Pick<IndexedEvent, 'signature' | 'eventIndex'>): string {
  return `${event.signature}:${event.eventIndex}`
}

/** The order the export promises: `(slot, signature, event_index)`, the same the api reads by. */
function compareEvents(a: IndexedEvent, b: IndexedEvent): number {
  if (a.slot !== b.slot) return a.slot - b.slot
  if (a.signature !== b.signature) return a.signature < b.signature ? -1 : 1
  return a.eventIndex - b.eventIndex
}

export function readJournal(text: string): JournalFile {
  const problems: string[] = []
  const entries: JournalEntry[] = []
  let manifest: JournalManifest | null = null

  const lines = text.split('\n')
  // A file ends with a newline, so the last element is empty; an empty line
  // anywhere else is not something the writer produces.
  if (lines.at(-1) === '') lines.pop()

  lines.forEach((raw, index) => {
    const line = index + 1
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      problems.push(`line ${line}: not JSON`)
      return
    }
    const parsed = journalLineSchema.safeParse(json)
    if (!parsed.success) {
      problems.push(`line ${line}: not a journal line (${parsed.error.issues[0]?.message})`)
      return
    }
    if (parsed.data.kind === 'manifest') {
      if (line !== 1) problems.push(`line ${line}: a manifest after the first line`)
      else manifest = parsed.data
      return
    }
    entries.push({ line, event: parsed.data })
  })

  if (manifest === null) {
    problems.push('the file does not start with a manifest')
    return { manifest, entries, problems }
  }
  const claimed: JournalManifest = manifest

  // The count is what makes a truncated file visible without any RPC.
  if (claimed.count !== entries.length) {
    problems.push(`the manifest counts ${claimed.count} events, the file holds ${entries.length}`)
  }
  if (claimed.toSlot > claimed.indexedThroughSlot) {
    problems.push(
      `the window ends at slot ${claimed.toSlot}, past what was indexed (${claimed.indexedThroughSlot})`,
    )
  }

  const seen = new Set<string>()
  let previous: IndexedEvent | undefined
  for (const { line, event } of entries) {
    if (event.mint !== claimed.mint) {
      problems.push(`line ${line}: an event of mint ${event.mint}, not ${claimed.mint}`)
    }
    if (event.slot < claimed.fromSlot || event.slot > claimed.toSlot) {
      problems.push(
        `line ${line}: slot ${event.slot} is outside the window ${claimed.fromSlot}…${claimed.toSlot}`,
      )
    }
    const key = eventKeyOf(event)
    if (seen.has(key)) problems.push(`line ${line}: event ${key} appears twice`)
    seen.add(key)
    if (previous !== undefined && compareEvents(previous, event) > 0) {
      problems.push(`line ${line}: out of order`)
    }
    previous = event
  }

  return { manifest: claimed, entries, problems }
}
