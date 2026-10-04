// Names for compliance reason codes (FR-017).
//
// **The program stores a number, and that does not change here.**
// `ComplianceReason.code` is any non-zero `u16`, and the chain refuses only
// zero. This catalog is a caption under the number, read by the officer's
// screen and the journal so that "4" means the same thing to the person who
// typed it and to the auditor who reads it a year later.
//
// **A code outside the catalog is valid, not an error.** An issuer with its
// own internal scheme types its own numbers, and both sides show them as
// "code N" rather than refusing them; the catalog only answers "what do we call
// this one".
//
// **Codes are never renumbered.** A journal exported today carries the number,
// not the name; renumbering would change what yesterday's actions mean. New
// entries go at the end.

export interface ReasonCodeEntry {
  readonly code: number
  /** A short noun phrase, as the journal shows it. */
  readonly label: string
  /** When an officer picks it — one sentence, for the form's hint. */
  readonly use: string
}

export const REASON_CODES: readonly ReasonCodeEntry[] = [
  { code: 1, label: 'Sanctions match', use: 'The holder matched a sanctions list.' },
  { code: 2, label: 'Court order', use: 'A court ordered the action.' },
  { code: 3, label: 'Regulator instruction', use: 'A supervisor instructed the issuer directly.' },
  {
    code: 4,
    label: 'Financial intelligence request',
    use: 'A financial intelligence unit asked for the funds to be held.',
  },
  { code: 5, label: 'Suspected fraud', use: 'The account is tied to a fraud report.' },
  { code: 6, label: 'AML investigation', use: 'An internal anti-money-laundering case is open.' },
  {
    code: 7,
    label: 'Holder recovery',
    use: 'The holder lost access, and the funds are moved under a verified claim.',
  },
  {
    code: 8,
    label: 'Security incident',
    use: 'Circulation is stopped while an incident is contained.',
  },
  { code: 9, label: 'Order lifted', use: 'The order behind an earlier action was withdrawn.' },
  { code: 10, label: 'Correction', use: 'An earlier action was taken in error.' },
  { code: 11, label: 'Holder request', use: 'The holder asked for the action in writing.' },
  { code: 12, label: 'Policy review', use: 'A scheduled or regulator-led review of the rules.' },
]

/** The catalog entry for a code; `undefined` for a number the catalog does not name. */
export function reasonCodeEntry(code: number): ReasonCodeEntry | undefined {
  return REASON_CODES.find((entry) => entry.code === code)
}

/**
 * How a code reads on a screen: the name with the number, or the number alone.
 *
 * The number is always there. The journal carries only the number, and an
 * auditor holding the export next to the screen must find the same figure on
 * both.
 */
export function reasonCodeLabel(code: number): string {
  const entry = reasonCodeEntry(code)
  return entry === undefined ? `code ${code}` : `${entry.label} (${code})`
}
