import { z } from 'zod'

/**
 * Transfer refusal codes (FR-011). Source of truth for three consumers: the
 * TS evaluator in the wizard (`packages/policy`), the log indexer
 * (`apps/worker`) and the independent journal verifier
 * (`tools/verify-journal`, SC-006). The Rust hook keeps a mirror — see
 * `REFUSAL_TABLE` below.
 *
 * The enumeration order repeats the order of checks in the hook
 * (`docs/PLAN.md` → "Order of checks in the hook"): a refusal is the **first**
 * check that failed, not the set of all that failed. So the order here is
 * significant, and the differential tests (SC-008) compare exactly that: two
 * implementations that reject the same transfer for different reasons have
 * diverged, even if both said "no".
 */
export const REFUSAL_CODES = [
  'POLICY_VERSION_MISMATCH',
  'SENDER_STATUS_MISSING',
  'RECIPIENT_STATUS_MISSING',
  'STATUS_SOURCE_NOT_ACCEPTED',
  'STATUS_SOURCE_UNAVAILABLE',
  'SENDER_DENIED',
  'RECIPIENT_DENIED',
  'RECIPIENT_TIER_TOO_LOW',
  'RECIPIENT_JURISDICTION_NOT_ALLOWED',
  'TRANSFER_LIMIT_EXCEEDED',
  'VELOCITY_COUNTER_MISSING',
  'PERIOD_LIMIT_EXCEEDED',
  'UNKNOWN_RULE_KIND',
  'TRANSFERS_PAUSED',
  'ACCOUNT_FROZEN',
] as const

export type RefusalCode = (typeof REFUSAL_CODES)[number]

export const refusalCodeSchema = z.enum(REFUSAL_CODES)

/**
 * Who exactly refused the transfer.
 *
 * `token-program` is not an implementation detail but a boundary of
 * responsibility: pause and account freeze are performed by Token-2022
 * extensions (`Pausable`, `DefaultAccountState`), and such a transfer fails
 * **before** the token program ever calls our hook. Our code never returns
 * these two codes; the indexer learns about them from the token program's
 * error.
 */
export type RefusalSource = 'hook' | 'token-program'

type RefusalMeta = {
  /**
   * Position in the Rust enum of hook errors, or `null` if the hook never
   * returns this code. Anchor numbers its own errors from
   * `ANCHOR_ERROR_OFFSET`, so it is this position, not the name, that arrives
   * in the transaction logs.
   */
  hookIndex: number | null
  source: RefusalSource
}

/**
 * The table mirrored by `ForgeError` in `programs/issuer-forge/src/error.rs`:
 * there these same codes come **first** in the enum, so `hookIndex` matches
 * the variant's ordinal and `6000 + hookIndex` matches the code that arrives
 * in the logs. The two enums cannot be separated by an offset:
 * `#[error_code(offset = …)]` only acts at runtime, while the IDL generator
 * hardcodes `6000 + index`.
 *
 * The mirror is unavoidable: Anchor requires the error enum in Rust, while
 * the indexer and the verifier live in TS. So it is made explicit and
 * numeric — a test checks that the indices are dense and unique, and
 * `refusal_codes_match_the_shared_table` in the program checks that the Rust
 * enum yields the same numbers. A silent divergence here would cost a wrong
 * refusal reason in the journal, i.e. a wrong answer to the regulator.
 */
export const REFUSAL_TABLE = {
  /** The policy the mint is configured with is not the one passed in the transfer. */
  POLICY_VERSION_MISMATCH: { hookIndex: 0, source: 'hook' },
  /**
   * The status account does not exist. The hook creates no accounts — it has
   * neither a payer nor a system program signature — so a missing account
   * means a refusal, not a skipped check (FR-013).
   */
  SENDER_STATUS_MISSING: { hookIndex: 1, source: 'hook' },
  RECIPIENT_STATUS_MISSING: { hookIndex: 2, source: 'hook' },
  /** The status exists, but from a source this rule does not accept (FR-008a). */
  STATUS_SOURCE_NOT_ACCEPTED: { hookIndex: 3, source: 'hook' },
  /**
   * The status source is unavailable at the moment of transfer: the
   * attestation account was not passed, or the wrong one was. Source
   * unavailability does not weaken the policy (FR-013).
   *
   * An expired attestation does **not** belong here: under FR-008a2 it is
   * treated as absent, after which the decision is made by the rule that
   * referenced it — so the outcome is `*_STATUS_MISSING` or an allow. A
   * separate code would make "expired" a refusal reason of its own, which is
   * different behaviour from what the requirement says.
   */
  STATUS_SOURCE_UNAVAILABLE: { hookIndex: 4, source: 'hook' },
  /** The issuer's deny registry: the address can neither send nor receive. */
  SENDER_DENIED: { hookIndex: 5, source: 'hook' },
  RECIPIENT_DENIED: { hookIndex: 6, source: 'hook' },
  RECIPIENT_TIER_TOO_LOW: { hookIndex: 7, source: 'hook' },
  RECIPIENT_JURISDICTION_NOT_ALLOWED: { hookIndex: 8, source: 'hook' },
  TRANSFER_LIMIT_EXCEEDED: { hookIndex: 9, source: 'hook' },
  /** The window counter is created at `thaw_holder`; its absence is a refusal. */
  VELOCITY_COUNTER_MISSING: { hookIndex: 10, source: 'hook' },
  PERIOD_LIMIT_EXCEEDED: { hookIndex: 11, source: 'hook' },
  /**
   * The policy contains a rule kind this version of the program does not know.
   *
   * It comes **last** among the hook's checks, and that is not a concession to
   * declaration order: a rule the reader does not understand makes "yes"
   * itself impossible. If one of the understood rules has already refused,
   * that rule is the reason, and it is more precise. If all the understood
   * rules passed, "yes" still cannot be said: the unknown rule might have said
   * "no". The same principle as FR-013 — a policy that is not fully understood
   * does not get weaker silently.
   *
   * Reachable only after rolling the program back to a version older than the
   * policy: `set_policy` rejects writing an unknown kind (T014).
   */
  UNKNOWN_RULE_KIND: { hookIndex: 12, source: 'hook' },
  /** The `Pausable` extension on the mint (FR-016). The hook is not called at all. */
  TRANSFERS_PAUSED: { hookIndex: null, source: 'token-program' },
  /** `freeze_account` or `DefaultAccountState = Frozen` (FR-014, FR-008b). */
  ACCOUNT_FROZEN: { hookIndex: null, source: 'token-program' },
} as const satisfies Record<RefusalCode, RefusalMeta>

/** Anchor numbers program errors from 6000; below that are its own codes. */
export const ANCHOR_ERROR_OFFSET = 6000

/** The Anchor error number for a code, or `null` if the code does not come from the hook. */
export function anchorErrorFor(code: RefusalCode): number | null {
  const { hookIndex } = REFUSAL_TABLE[code]
  return hookIndex === null ? null : ANCHOR_ERROR_OFFSET + hookIndex
}

/**
 * The reverse direction: the indexer sees a number in the logs, not a name.
 *
 * An unknown number returns `null` rather than throwing: logs are read from
 * the network, and a program newer than this worker is an expected state,
 * not a failure. The event is then recorded with an unrecognised code instead
 * of being lost.
 */
export function refusalCodeFromAnchorError(anchorError: number): RefusalCode | null {
  const index = anchorError - ANCHOR_ERROR_OFFSET
  return REFUSAL_CODES.find((code) => REFUSAL_TABLE[code].hookIndex === index) ?? null
}

/** Codes returned by our hook itself — i.e. those that have a mirror in Rust. */
export function hookRefusalCodes(): RefusalCode[] {
  return REFUSAL_CODES.filter((code) => REFUSAL_TABLE[code].source === 'hook')
}
