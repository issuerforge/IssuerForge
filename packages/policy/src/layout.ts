// The deterministic binary layout of a policy and `rules_hash`.
//
// This is the second half of the pair "model ↔ bytes": `model.ts` says what a
// policy can say, and here it becomes the very 384 bytes that sit in
// `PolicyConfig.rules` and that the hook reads without allocations.
//
// **The encoding is canonical: a policy has exactly one representation in
// bytes.** Three properties follow, and they have to be kept together because
// each alone is worth nothing:
//
// 1. `encode` is deterministic — slots go in ascending `kind`, sets are
//    already ordered by the model, padding is zero;
// 2. `decode` rejects everything that could not have come out of `encode` —
//    non-zero padding, a non-zero `op`, an unknown `kind`, a non-ascending
//    order;
// 3. `encode(decode(bytes)) === bytes` for any accepted bytes.
//
// Without (2) two different byte arrays would mean the same policy and have
// different `rules_hash`es — i.e. the hash would stop being the name of the
// policy and become the name of one of its spellings.
//
// **`rules_hash` is computed over all 16 slots**, as they sit in the account.
// The independent verifier (SC-006) does not need to know how many slots are
// filled: it takes a slice of the account data, hashes it and compares. The
// hash proves the account contents byte for byte, not their interpretation.
import { fromU64, toU64 } from '@forge/shared/primitives'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  MAX_RULE_SLOTS,
  type PolicyRules,
  policyRulesSchema,
  RULE_KIND,
  RULE_PARAMS_BYTES,
  RULE_SLOT_BYTES,
  STATUS_SOURCE,
  STATUS_SOURCE_ALL,
  STATUS_SOURCES,
  statusSourceMask,
} from './model.ts'

/** Full size of the `rules` field in the account. */
export const RULES_BYTES = MAX_RULE_SLOTS * RULE_SLOT_BYTES

/**
 * The second byte of a slot.
 *
 * `PLAN.md` intended a comparison operator here, but with a named model the
 * rule kind already determines the operator, and a second way of saying the
 * same thing could diverge from it (`TRANSFER_LIMIT` with `gte` — what would
 * that mean?). The byte stays zero and **is checked**: otherwise it becomes a
 * silent channel into which something gets in and changes `rules_hash`
 * without changing anything in the content.
 *
 * A new parameter encoding is a new `kind`, not a new value here. One axis of
 * versions instead of two, and a signed policy never changes meaning.
 */
export const RULE_OP_RESERVED = 0

/** Offset of a slot in the array. */
const slotOffset = (index: number): number => index * RULE_SLOT_BYTES

/** Slot order — ascending `kind`. There is no other deterministic one. */
const SLOT_ORDER = [
  RULE_KIND.STATUS,
  RULE_KIND.JURISDICTIONS,
  RULE_KIND.TRANSFER_LIMIT,
  RULE_KIND.PERIOD_LIMIT,
] as const

export class PolicyLayoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PolicyLayoutError'
  }
}

// ─── Encoding ────────────────────────────────────────────────────────────────

function writeSlot(out: Uint8Array, index: number, kind: number, params: Uint8Array): void {
  if (params.length > RULE_PARAMS_BYTES) {
    throw new PolicyLayoutError(`rule ${kind} needs ${params.length} bytes, the slot holds 22`)
  }
  const at = slotOffset(index)
  out[at] = kind
  out[at + 1] = RULE_OP_RESERVED
  out.set(params, at + 2)
}

function statusParams(rules: PolicyRules): Uint8Array {
  const params = new Uint8Array(RULE_PARAMS_BYTES)
  params[0] = statusSourceMask(rules.status.sources)
  params[1] = rules.status.minTier
  // Zero means "no validity period": the model allows no value below an
  // hour, so zero is not a valid period and reads unambiguously.
  new DataView(params.buffer).setUint32(2, rules.status.maxAttestationAgeSeconds ?? 0, true)
  return params
}

function jurisdictionParams(codes: readonly string[]): Uint8Array {
  const params = new Uint8Array(RULE_PARAMS_BYTES)
  codes.forEach((code, i) => {
    params[i * 2] = code.charCodeAt(0)
    params[i * 2 + 1] = code.charCodeAt(1)
  })
  return params
}

function amountParams(amount: string, windowSeconds?: number): Uint8Array {
  const params = new Uint8Array(RULE_PARAMS_BYTES)
  const view = new DataView(params.buffer)
  view.setBigUint64(0, toU64(amount), true)
  if (windowSeconds !== undefined) view.setUint32(8, windowSeconds, true)
  return params
}

/**
 * Policy → the 384 bytes of the `rules` field.
 *
 * The input is run through the schema: encoding an unchecked policy means
 * writing into the account a value the model would have rejected — and
 * learning about it from a refused transfer a week later.
 */
export function encodeRules(rules: PolicyRules): Uint8Array {
  const checked = policyRulesSchema.parse(rules)
  const out = new Uint8Array(RULES_BYTES)
  let index = 0

  for (const kind of SLOT_ORDER) {
    switch (kind) {
      case RULE_KIND.STATUS:
        writeSlot(out, index++, kind, statusParams(checked))
        break
      case RULE_KIND.JURISDICTIONS:
        if (checked.jurisdictions !== undefined) {
          writeSlot(out, index++, kind, jurisdictionParams(checked.jurisdictions))
        }
        break
      case RULE_KIND.TRANSFER_LIMIT:
        if (checked.transferLimit !== undefined) {
          writeSlot(out, index++, kind, amountParams(checked.transferLimit))
        }
        break
      case RULE_KIND.PERIOD_LIMIT:
        if (checked.periodLimit !== undefined) {
          const { amount, windowSeconds } = checked.periodLimit
          writeSlot(out, index++, kind, amountParams(amount, windowSeconds))
        }
        break
    }
  }

  return out
}

// ─── Decoding ────────────────────────────────────────────────────────────────

/** Reads numbers from a slot's parameters. Offsets are from the start of `params`. */
const paramsView = (params: Uint8Array): DataView =>
  new DataView(params.buffer, params.byteOffset, params.byteLength)

function readStatus(params: Uint8Array): PolicyRules['status'] {
  const mask = params[0] ?? 0
  // An unknown source bit is the same refusal as an unknown rule kind: a
  // source the reader does not know can be neither executed nor skipped.
  if (mask === 0 || (mask & ~STATUS_SOURCE_ALL) !== 0) {
    throw new PolicyLayoutError(`status rule names no known source (mask ${mask})`)
  }

  const maxAge = paramsView(params).getUint32(2, true)
  const status: PolicyRules['status'] = {
    sources: STATUS_SOURCES.filter((source) => (mask & STATUS_SOURCE[source]) !== 0),
    minTier: params[1] ?? 0,
  }
  return maxAge === 0 ? status : { ...status, maxAttestationAgeSeconds: maxAge }
}

function readJurisdictions(params: Uint8Array): string[] {
  const codes: string[] = []
  for (let i = 0; i * 2 < RULE_PARAMS_BYTES; i++) {
    const high = params[i * 2] ?? 0
    const low = params[i * 2 + 1] ?? 0
    if (high === 0 && low === 0) break
    codes.push(String.fromCharCode(high, low))
  }
  return codes
}

/**
 * 384 bytes → policy.
 *
 * Rejects everything that could not have come out of `encode`. This is not
 * pedantry: `rules_hash` names the policy, and two different arrays with the
 * same content would make that name ambiguous at the very moment a journal
 * record refers to it.
 */
export function decodeRules(bytes: Uint8Array): PolicyRules {
  if (bytes.length !== RULES_BYTES) {
    throw new PolicyLayoutError(`expected ${RULES_BYTES} bytes of rules, got ${bytes.length}`)
  }

  const draft: Record<string, unknown> = {}
  const seen = new Set<number>()
  let previousKind = 0
  let ended = false

  for (let index = 0; index < MAX_RULE_SLOTS; index++) {
    const at = slotOffset(index)
    const slot = bytes.subarray(at, at + RULE_SLOT_BYTES)
    const kind = slot[0] ?? 0
    const op = slot[1] ?? 0
    const params = slot.subarray(2)

    if (kind === 0) {
      // An empty slot must be entirely empty: a non-zero tail does not change
      // the content of the policy, but it changes its hash.
      if (slot.some((byte) => byte !== 0)) {
        throw new PolicyLayoutError(`slot ${index} is empty but not zeroed`)
      }
      ended = true
      continue
    }

    // A gap between rules would give two encodings of one policy.
    if (ended) throw new PolicyLayoutError(`slot ${index} follows an empty slot`)
    if (op !== RULE_OP_RESERVED) {
      throw new PolicyLayoutError(`slot ${index} sets the reserved byte to ${op}`)
    }
    if (seen.has(kind)) throw new PolicyLayoutError(`rule kind ${kind} appears twice`)
    if (kind <= previousKind) {
      throw new PolicyLayoutError(`slot ${index} breaks the ascending order of rule kinds`)
    }
    seen.add(kind)
    previousKind = kind

    switch (kind) {
      case RULE_KIND.STATUS:
        draft.status = readStatus(params)
        break
      case RULE_KIND.JURISDICTIONS:
        draft.jurisdictions = readJurisdictions(params)
        break
      case RULE_KIND.TRANSFER_LIMIT:
        draft.transferLimit = fromU64(paramsView(params).getBigUint64(0, true))
        break
      case RULE_KIND.PERIOD_LIMIT: {
        const view = paramsView(params)
        draft.periodLimit = {
          amount: fromU64(view.getBigUint64(0, true)),
          windowSeconds: view.getUint32(8, true),
        }
        break
      }
      // An unknown rule kind is a refusal, not a skip. A policy the reader does
      // not fully understand does not get weaker silently: the same principle
      // as FR-013 about an unavailable status source. `set_policy` will not let
      // this through on write (T014), and the hook refuses it anyway (T015).
      default:
        throw new PolicyLayoutError(`slot ${index} carries an unknown rule kind ${kind}`)
    }
  }

  // The schema catches the rest: padding that is not a valid value, a zero
  // amount, a missing mandatory status rule.
  const parsed = policyRulesSchema.safeParse(draft)
  if (!parsed.success) {
    throw new PolicyLayoutError(
      `rules do not form a valid policy: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    )
  }
  return parsed.data
}

// ─── Hash ────────────────────────────────────────────────────────────────────

/**
 * sha256 over the whole `rules` field.
 *
 * sha256 and not something else, because the program itself computes it: on
 * Solana it is a native syscall, i.e. one cheap call on a policy change — and
 * none on a transfer. A hash the on-chain code cannot recompute would prove
 * only that the client knows how to compute hashes.
 */
export function hashEncodedRules(bytes: Uint8Array): Uint8Array {
  if (bytes.length !== RULES_BYTES) {
    throw new PolicyLayoutError(`expected ${RULES_BYTES} bytes of rules, got ${bytes.length}`)
  }
  return sha256(bytes)
}

/** The policy's `rules_hash`. The same as `hashEncodedRules(encodeRules(rules))`. */
export function rulesHash(rules: PolicyRules): Uint8Array {
  return hashEncodedRules(encodeRules(rules))
}

/** Hex string — what the wizard shows and what sits in `policy_versions`. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
