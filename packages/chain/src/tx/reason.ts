// Why a compliance action was taken (FR-017) — the TS side of
// `ComplianceReason` in `state/action.rs`.
//
// Shared by every instruction that states one: the freeze and its lifting
// carry it as an argument, a seizure carries it in its proposal and again in
// `seize`. One conversion in each direction, so the check a reference passes
// here is the one the program applies.

/** The width of `ComplianceReason.case_ref` in `state/action.rs`. */
export const CASE_REF_BYTES = 32

/** A reason code is a `u16`, and zero is "not stated" — the program refuses it. */
export const REASON_CODE_MAX = 0xffff

/** Why a compliance action was taken (FR-017). */
export type ComplianceReasonInput = {
  readonly code: number
  /** Printable ASCII, 1…32 characters. */
  readonly caseRef: string
}

/**
 * The case reference as the program stores it: the bytes, then zeros.
 *
 * Checked here with the same rule the program applies, so a reference the
 * program would refuse fails at assembly rather than after a signature.
 */
export function caseRefBytes(caseRef: string): number[] {
  if (caseRef.length === 0 || caseRef.length > CASE_REF_BYTES) {
    throw new RangeError(`case reference must be 1…${CASE_REF_BYTES} characters`)
  }
  const bytes: number[] = []
  for (const char of caseRef) {
    const byte = char.charCodeAt(0)
    if (byte < 0x20 || byte > 0x7e) {
      throw new RangeError(`case reference must be printable ASCII: ${JSON.stringify(caseRef)}`)
    }
    bytes.push(byte)
  }
  return [...bytes, ...new Array<number>(CASE_REF_BYTES - bytes.length).fill(0)]
}

export function toReason(reason: ComplianceReasonInput) {
  if (!Number.isInteger(reason.code) || reason.code < 1 || reason.code > REASON_CODE_MAX) {
    throw new RangeError(`reason code must be 1…${REASON_CODE_MAX}: ${reason.code}`)
  }
  return { code: reason.code, caseRef: caseRefBytes(reason.caseRef) }
}

/**
 * The reverse of `toReason`: a reason as Anchor decodes it back to the input
 * shape. The case reference ends at the first zero — the program refuses
 * anything after it, so there is nothing there to lose.
 */
export function fromReason(raw: {
  readonly code: number
  readonly caseRef: ArrayLike<number>
}): ComplianceReasonInput {
  const bytes = Array.from(raw.caseRef)
  const end = bytes.indexOf(0)
  return {
    code: raw.code,
    caseRef: String.fromCharCode(...(end === -1 ? bytes : bytes.slice(0, end))),
  }
}
