// The reconciliation itself: the file against the chain, in both directions.
//
// File → chain is SC-006 as written: every line must be an event the chain
// shows, with the same fields. Chain → file is what keeps the first direction
// honest — a journal with an inconvenient line removed and the manifest's
// count lowered to match confirms perfectly line by line. So the verifier
// lists the program's transactions in the window itself and reports every
// event of the mint the file does not hold.
import { issuerConfigPda } from '@forge/chain'
import type { IndexedEvent } from '@forge/shared/events'
import type { JournalManifest } from '@forge/shared/journal'
import { PublicKey } from '@solana/web3.js'
import { type Chain, tokenConfigAddress } from './chain.ts'
import { type ChainReading, readTransaction, type UnjournalledInstruction } from './decode.ts'
import { eventKeyOf, readJournal } from './file.ts'

export interface FieldDifference {
  readonly field: string
  readonly journal: unknown
  readonly chain: unknown
}

export interface Report {
  readonly manifest: JournalManifest | null
  /** Event lines in the file. */
  readonly lines: number
  readonly confirmed: number
  /** Lines the chain does not show at all. */
  readonly unconfirmed: readonly { line: number; key: string; why: string }[]
  /** Lines the chain shows differently. */
  readonly mismatched: readonly { line: number; key: string; fields: FieldDifference[] }[]
  /** Events of the mint in the window that the file does not hold. */
  readonly missing: readonly IndexedEvent[]
  /** Transactions in the window the verifier could not read, so cannot vouch for. */
  readonly unreadable: readonly { signature: string; why: string }[]
  /** Instructions on this token or its issuer that format v1 has no line for. */
  readonly unjournalled: readonly UnjournalledInstruction[]
  /** What is wrong with the file or its claims as a whole. */
  readonly problems: readonly string[]
  readonly passed: boolean
}

/** SC-006: the share of lines the chain does not confirm as written. */
export function unconfirmedShare(report: Report): number {
  if (report.lines === 0) return 0
  return (report.unconfirmed.length + report.mismatched.length) / report.lines
}

export interface VerifyOptions {
  readonly text: string
  readonly chain: Chain
  /** The program the verifier trusts — its own setting, not the file's word. */
  readonly programId: string
  /** Transactions fetched at once; public endpoints throttle bursts. */
  readonly concurrency?: number
}

type Reading = ChainReading | { readonly failure: string }

function differences(journal: IndexedEvent, chain: IndexedEvent): FieldDifference[] {
  const a = journal as Record<string, unknown>
  const b = chain as Record<string, unknown>
  const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])]
  return fields
    .filter((field) => JSON.stringify(a[field]) !== JSON.stringify(b[field]))
    .map((field) => ({ field, journal: a[field], chain: b[field] }))
}

async function inPool<T>(
  items: readonly T[],
  size: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next] as T
      next += 1
      await work(item)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, lane))
}

function failed(manifest: JournalManifest | null, lines: number, problems: string[]): Report {
  return {
    manifest,
    lines,
    confirmed: 0,
    unconfirmed: [],
    mismatched: [],
    missing: [],
    unreadable: [],
    unjournalled: [],
    problems,
    passed: false,
  }
}

export async function verifyJournal(options: VerifyOptions): Promise<Report> {
  const { chain, programId } = options
  const file = readJournal(options.text)
  const problems = [...file.problems]
  const { manifest } = file
  if (manifest === null) return failed(null, file.entries.length, problems)

  if (manifest.programId !== programId) {
    problems.push(`the file names program ${manifest.programId}; verified against ${programId}`)
  }

  // Whose token this is, by the chain: the file's issuer is a claim like any other.
  const tokenConfig = tokenConfigAddress(manifest.mint, programId)
  const token = await chain.state.tokenAt(tokenConfig)
  if (token === undefined) {
    problems.push(`${manifest.mint} is not a token of program ${programId}`)
  } else if (token.issuerId !== manifest.issuerId) {
    problems.push(
      `the token belongs to issuer ${token.issuerId}, the file says ${manifest.issuerId}`,
    )
  }

  const finalized = await chain.finalizedSlot()
  if (manifest.toSlot > finalized) {
    problems.push(
      `the window ends at slot ${manifest.toSlot}, the chain has finalized ${finalized} — run again later`,
    )
  }

  const inWindow = (slot: number): boolean => slot >= manifest.fromSlot && slot <= manifest.toSlot
  const mentions =
    manifest.fromSlot <= manifest.toSlot
      ? await chain.mentions(programId, manifest.fromSlot, manifest.toSlot)
      : []
  // The file's own signatures are read too: a line outside the scan must
  // still be confirmed or refuted, not skipped.
  const signatures = [
    ...new Set([
      ...mentions.map((mention) => mention.signature),
      ...file.entries.map(({ event }) => event.signature),
    ]),
  ]

  const readings = new Map<string, Reading>()
  await inPool(signatures, options.concurrency ?? 4, async (signature) => {
    try {
      const response = await chain.transaction(signature)
      readings.set(
        signature,
        response === null
          ? { failure: 'the chain has no finalized transaction with this signature' }
          : await readTransaction(signature, response, programId, chain.state),
      )
    } catch (error) {
      readings.set(signature, { failure: error instanceof Error ? error.message : String(error) })
    }
  })

  const onChain = new Map<string, IndexedEvent>()
  const unreadable: { signature: string; why: string }[] = []
  const unjournalled: UnjournalledInstruction[] = []
  const issuerConfig = issuerConfigPda(
    new PublicKey(manifest.issuerId),
    new PublicKey(programId),
  ).toBase58()
  const ours = new Set([manifest.mint, tokenConfig, issuerConfig])

  for (const mention of mentions) {
    const reading = readings.get(mention.signature)
    if (reading !== undefined && 'failure' in reading) {
      unreadable.push({ signature: mention.signature, why: reading.failure })
    }
  }
  for (const reading of readings.values()) {
    if ('failure' in reading) continue
    for (const event of reading.events) {
      if (event.mint === manifest.mint) onChain.set(eventKeyOf(event), event)
    }
    for (const instruction of reading.unjournalled) {
      if (inWindow(instruction.slot) && instruction.accounts.some((a) => ours.has(a))) {
        unjournalled.push(instruction)
      }
    }
  }

  const unconfirmed: Report['unconfirmed'][number][] = []
  const mismatched: Report['mismatched'][number][] = []
  let confirmed = 0
  const inFile = new Set<string>()
  for (const { line, event } of file.entries) {
    const key = eventKeyOf(event)
    inFile.add(key)
    const reading = readings.get(event.signature)
    const chainEvent = onChain.get(key)
    if (reading !== undefined && 'failure' in reading) {
      unconfirmed.push({ line, key, why: reading.failure })
    } else if (chainEvent === undefined) {
      unconfirmed.push({ line, key, why: 'the transaction holds no such event of this mint' })
    } else {
      const fields = differences(event, chainEvent)
      if (fields.length === 0) confirmed += 1
      else mismatched.push({ line, key, fields })
    }
  }

  const missing = [...onChain.values()]
    .filter((event) => inWindow(event.slot) && !inFile.has(eventKeyOf(event)))
    .sort((a, b) => a.slot - b.slot || a.eventIndex - b.eventIndex)

  return {
    manifest,
    lines: file.entries.length,
    confirmed,
    unconfirmed,
    mismatched,
    missing,
    unreadable,
    unjournalled: unjournalled.sort((a, b) => a.slot - b.slot),
    problems,
    passed:
      problems.length === 0 &&
      unconfirmed.length === 0 &&
      mismatched.length === 0 &&
      missing.length === 0 &&
      unreadable.length === 0,
  }
}
