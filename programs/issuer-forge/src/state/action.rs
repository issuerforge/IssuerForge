use anchor_lang::prelude::*;

use crate::error::ForgeError;

/// How many bytes are reserved for a case reference.
///
/// Thirty-two fits the identifiers regulators and case systems actually hand
/// out ("FIU-NG/2026/004117" is eighteen) with room to spare, and keeps the
/// field fixed-size: a `String` would make every account that stores a reason
/// pay for its longest possible value anyway, and give the indexer a length
/// prefix to trust.
pub const CASE_REF_BYTES: usize = 32;

/// Why a compliance action was taken (FR-017): a reason code and the case it
/// belongs to.
///
/// **Introduced by the freeze (T026), meant for all four actions.** Seizure
/// and pause (T027, T028) take the same type, and T029 adds what is left of
/// FR-017 and FR-019c — the event with the named signers — on top of it
/// rather than beside it. One type is what keeps "an action without a reason
/// is not executed" one rule instead of four.
///
/// The catalogue of codes is not here. The program cannot tell a real reason
/// from an invented one; what it can do is refuse an action whose reason was
/// left empty, which is the acceptance scenario the specification states.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub struct ComplianceReason {
    /// The issuer's reason code. Zero is "not stated".
    pub code: u16,
    /// Printable ASCII, then zeros.
    pub case_ref: [u8; CASE_REF_BYTES],
}

impl ComplianceReason {
    pub fn validate(&self) -> Result<()> {
        // Zero is what a client that forgot the field sends — Anchor's
        // encoder writes a missing number as zero without complaint.
        require!(self.code != 0, ForgeError::ReasonCodeMissing);

        let length = self
            .case_ref
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(CASE_REF_BYTES);
        require!(length > 0, ForgeError::CaseReferenceInvalid);
        // Printable only: the reference is shown to a regulator and typed back
        // into a case system, and a control byte in it would make two
        // references that look the same compare as different.
        require!(
            self.case_ref[..length]
                .iter()
                .all(|byte| (0x20..=0x7e).contains(byte)),
            ForgeError::CaseReferenceInvalid
        );
        // The tail must be entirely zero, for the same reason as a currency
        // code: "CASE-1\0X" and "CASE-1" would be two values a person calls
        // one.
        require!(
            self.case_ref[length..].iter().all(|byte| *byte == 0),
            ForgeError::CaseReferenceInvalid
        );
        Ok(())
    }
}

/// A case reference as bytes, with no NUL literals in the source.
pub const fn case_ref_bytes(reference: &[u8]) -> [u8; CASE_REF_BYTES] {
    let mut bytes = [0u8; CASE_REF_BYTES];
    let mut index = 0;
    while index < reference.len() && index < CASE_REF_BYTES {
        bytes[index] = reference[index];
        index += 1;
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reason(code: u16, reference: &[u8]) -> ComplianceReason {
        ComplianceReason {
            code,
            case_ref: case_ref_bytes(reference),
        }
    }

    fn err(result: Result<()>) -> u32 {
        match result.expect_err("expected a refusal") {
            anchor_lang::error::Error::AnchorError(e) => e.error_code_number,
            other => panic!("unexpected error: {other:?}"),
        }
    }

    fn code(error: ForgeError) -> u32 {
        u32::from(error)
    }

    #[test]
    fn accepts_a_code_with_a_case() {
        assert!(reason(7, b"FIU-NG/2026/004117").validate().is_ok());
    }

    #[test]
    fn accepts_a_reference_that_fills_every_byte() {
        assert!(reason(1, &[b'A'; CASE_REF_BYTES]).validate().is_ok());
    }

    #[test]
    fn refuses_an_action_without_a_reason_code() {
        // The acceptance scenario of US2: no code, no action.
        assert_eq!(
            err(reason(0, b"FIU-NG/2026/004117").validate()),
            code(ForgeError::ReasonCodeMissing)
        );
    }

    #[test]
    fn refuses_an_empty_case_reference() {
        assert_eq!(
            err(reason(7, b"").validate()),
            code(ForgeError::CaseReferenceInvalid)
        );
    }

    #[test]
    fn refuses_control_bytes_in_the_reference() {
        assert_eq!(
            err(reason(7, b"CASE\n1").validate()),
            code(ForgeError::CaseReferenceInvalid)
        );
        assert_eq!(
            err(reason(7, &[b'C', 0x7f]).validate()),
            code(ForgeError::CaseReferenceInvalid)
        );
    }

    #[test]
    fn refuses_anything_after_the_padding_starts() {
        let mut bytes = case_ref_bytes(b"CASE-1");
        bytes[10] = b'X';
        let smuggled = ComplianceReason {
            code: 7,
            case_ref: bytes,
        };
        assert_eq!(
            err(smuggled.validate()),
            code(ForgeError::CaseReferenceInvalid)
        );
    }
}
