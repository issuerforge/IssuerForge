import { z } from 'zod'
import {
  addressSchema,
  blockTimeSchema,
  signatureSchema,
  slotSchema,
  u64Schema,
  unixSecondsSchema,
} from '../primitives.ts'
import { refusalCodeSchema } from '../refusal.ts'

/**
 * Indexed events: what `apps/worker` pulls out of the program's and the token
 * program's logs, and what then lives three lives — as the feed in the console
 * (FR-037), as journal lines (FR-018) and as the mirror in Postgres
 * (`docs/PLAN.md` → "Data model").
 *
 * One union for all three consumers, not three similar types. The reason is
 * SC-006: the independent verifier reads the exported NDJSON and reconciles it
 * against the network without talking to the API. If the journal had its own
 * shape, the reconciliation would prove that the journal matches the network
 * but say nothing about what the issuer saw in the console.
 *
 * On-chain remains the source of truth; every event carries `signature` and
 * `slot`, i.e. exactly what is needed to verify it with nothing but an RPC.
 */

/**
 * Shared fields. The identity of an event is the pair `signature` +
 * `eventIndex`: one transaction legitimately contains several transfers
 * (splitting is a scenario from SC-002), so the signature alone is not a key.
 */
const envelope = {
  signature: signatureSchema,
  slot: slotSchema,
  blockTime: blockTimeSchema,
  /** Ordinal of the event inside the transaction, from zero. */
  eventIndex: z.number().int().nonnegative(),
  mint: addressSchema,
}

/**
 * An executed transfer (FR-037).
 *
 * Carries both the token accounts and the owners' wallets: the former are
 * needed to match the event against the instruction in the transaction, the
 * latter to show a party to a person. The hook reads `owner` from the token
 * account data, so it has both pairs in hand without extra RPC requests.
 */
export const transferEventSchema = z.object({
  kind: z.literal('transfer'),
  ...envelope,
  source: addressSchema,
  destination: addressSchema,
  sender: addressSchema,
  recipient: addressSchema,
  amount: u64Schema,
})

/**
 * A refused transfer (FR-011).
 *
 * `code` is the parsed name of the reason, `programError` the raw number from
 * the network. Both are kept: a worker older than the program sees an
 * unfamiliar number, and an event with `code: null` stays verifiable and does
 * not vanish from the feed.
 *
 * `ruleSlot` is the slot number in `PolicyConfig.rules` (0…15) that fired, or
 * `null` for refusals that do not originate from a rule (policy version
 * mismatch, pause, freeze). It is what links the refusal to the item of the
 * rulebook the issuer saw in the wizard.
 */
export const refusalEventSchema = z.object({
  kind: z.literal('refusal'),
  ...envelope,
  source: addressSchema,
  destination: addressSchema,
  sender: addressSchema,
  recipient: addressSchema,
  amount: u64Schema,
  code: refusalCodeSchema.nullable(),
  programError: z.number().int().nullable(),
  ruleSlot: z.number().int().min(0).max(15).nullable(),
})

/**
 * Actions that require a reason code and a case reference (FR-017).
 *
 * Thawing an account during onboarding is **not** among them: it has no case,
 * is signed by the operational key within its delegation (FR-035) and is a
 * change of the status registry, not a compliance action. Its place is the
 * thaw queue (FR-008b2), tasks T022 and T031.
 */
export const COMPLIANCE_ACTIONS = [
  'freeze',
  'unfreeze',
  'seize',
  'pause',
  'unpause',
  'set_policy',
  'set_roles',
  'set_attestor',
] as const

export type ComplianceAction = (typeof COMPLIANCE_ACTIONS)[number]

export const complianceActionSchema = z.enum(COMPLIANCE_ACTIONS)

/**
 * A compliance action (FR-017, FR-018, FR-019c).
 *
 * `signers` is a named list, not a counter: FR-019c requires showing **who**
 * authorised an action with funds, and "quorum reached" does not satisfy that
 * requirement. At least one signature: freezing an individual account is done
 * by an officer alone (FR-014), a quorum is only needed for actions with funds
 * (FR-019).
 *
 * `target` and `amount` are null where they have no meaning: a pause has no
 * target, a policy change has no amount. An empty string or a zero in those
 * places would read as values.
 */
export const complianceEventSchema = z.object({
  kind: z.literal('compliance'),
  ...envelope,
  action: complianceActionSchema,
  target: addressSchema.nullable(),
  amount: u64Schema.nullable(),
  reasonCode: z.string().min(1),
  caseRef: z.string().min(1),
  signers: z.array(addressSchema).min(1),
})

/**
 * A published reserve attestation (FR-021, FR-026).
 *
 * `index` is the position in the append-only sequence `["reserve", mint,
 * index]`: a record is neither edited nor deleted, so the index is the
 * history.
 *
 * `currency` is the currency of the reserve, not of the token, and it does not
 * necessarily match the currency in circulation. `amount` is in the smallest
 * unit of that currency.
 */
export const attestationEventSchema = z.object({
  kind: z.literal('attestation'),
  ...envelope,
  index: z.number().int().nonnegative(),
  amount: u64Schema,
  currency: z.string().min(3).max(8),
  attestor: addressSchema,
  attestedAt: unixSecondsSchema,
  expiresAt: unixSecondsSchema,
})

/**
 * The union of everything indexed up to and including M2.
 *
 * Action proposals (FR-019b) and redemptions (US4) are not in it yet — they
 * arrive with their own tasks (T031/T032 and T048). The `kind` discriminator
 * makes extension a matter of adding a member: existing consumers do not
 * break on a new one.
 */
export const indexedEventSchema = z.discriminatedUnion('kind', [
  transferEventSchema,
  refusalEventSchema,
  complianceEventSchema,
  attestationEventSchema,
])

export type TransferEvent = z.infer<typeof transferEventSchema>
export type RefusalEvent = z.infer<typeof refusalEventSchema>
export type ComplianceEvent = z.infer<typeof complianceEventSchema>
export type AttestationEvent = z.infer<typeof attestationEventSchema>
export type IndexedEvent = z.infer<typeof indexedEventSchema>

export type IndexedEventKind = IndexedEvent['kind']

/**
 * Event key for deduplication.
 *
 * The indexer re-reads the logs after a connection drop, so the same event
 * arrives twice; the key has to be derived from the network, not from the
 * insertion time.
 */
export function eventKey(event: IndexedEvent): string {
  return `${event.signature}:${event.eventIndex}`
}
