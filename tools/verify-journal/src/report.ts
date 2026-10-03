// The report a person reads. The verdict comes first and the evidence after
// it, each finding with the line number or signature to look it up by.
import { type Report, unconfirmedShare } from './verify.ts'

const LIST_LIMIT = 50

function section<T>(title: string, items: readonly T[], show: (item: T) => string): string[] {
  if (items.length === 0) return []
  const shown = items.slice(0, LIST_LIMIT).map((item) => `  ${show(item)}`)
  const more = items.length > LIST_LIMIT ? [`  … and ${items.length - LIST_LIMIT} more`] : []
  return ['', `${title} (${items.length}):`, ...shown, ...more]
}

const value = (v: unknown): string => JSON.stringify(v) ?? 'undefined'

export function formatReport(report: Report, rpc: string): string {
  const { manifest } = report
  const share = unconfirmedShare(report)
  const head = [
    `${report.passed ? 'PASS' : 'FAIL'} — ${report.confirmed} of ${report.lines} lines confirmed on chain; unconfirmed share ${share.toFixed(4)} (SC-006 budget 0)`,
    '',
  ]
  if (manifest !== null) {
    head.push(
      `mint     ${manifest.mint}`,
      `issuer   ${manifest.issuerId}`,
      `program  ${manifest.programId}`,
      `window   slots ${manifest.fromSlot}…${manifest.toSlot} (indexed through ${manifest.indexedThroughSlot})`,
      `exported ${manifest.exportedAt}`,
    )
  }
  head.push(`rpc      ${rpc}`)

  return [
    ...head,
    ...section('File problems', report.problems, (p) => p),
    ...section('Unconfirmed lines', report.unconfirmed, (u) => `line ${u.line} ${u.key}: ${u.why}`),
    ...section(
      'Lines the chain shows differently',
      report.mismatched,
      (m) =>
        `line ${m.line} ${m.key}: ${m.fields
          .map((f) => `${f.field} file=${value(f.journal)} chain=${value(f.chain)}`)
          .join('; ')}`,
    ),
    ...section(
      'On chain, missing from the file',
      report.missing,
      (e) => `${e.signature}:${e.eventIndex} slot ${e.slot} ${e.kind}`,
    ),
    ...section(
      'Transactions that could not be read',
      report.unreadable,
      (u) => `${u.signature}: ${u.why}`,
    ),
    ...section(
      'On chain, outside the journal format (not counted)',
      report.unjournalled,
      (i) => `${i.signature} slot ${i.slot} ${i.instruction} — ${i.why}`,
    ),
    '',
  ].join('\n')
}
