use anchor_lang::prelude::*;

use crate::constants::MAX_MEMBERS;
use crate::error::ForgeError;
use crate::rules::layout::{self, RuleSlot, RULES_BYTES};
use crate::state::ComplianceReason;

/// What is proposed, as the proposer states it — **with the bodies**.
///
/// The argument type of `propose_action`, not a stored one. The difference
/// from `ActionKind` is exactly one thing: here an action carries whatever it
/// needs in full, there the same action carries a digest of it.
///
/// The body is not lost by that. The propose instruction lands on chain like
/// any other, and this project's indexer reconstructs everything from
/// instruction data rather than from logs (`apps/worker/src/indexer/decode.ts`
/// — the program writes neither `emit!` nor `msg!`). So the rules an approver
/// is asked to authorise are readable from the transaction that proposed
/// them, and the digest in the account is what binds the execution to exactly
/// those bytes.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum ProposedAction {
    /// The next policy version and its full rule layout (FR-009, FR-010).
    SetPolicy { version: u32, rules: Vec<u8> },
    /// Taking `amount` out of `token_account` under an order (FR-015). The
    /// body is small enough to store whole, so this one is its own stored
    /// form.
    Seize {
        token_account: Pubkey,
        amount: u64,
        reason: ComplianceReason,
    },
}

impl ProposedAction {
    /// The stored form of this action.
    ///
    /// **The single conversion point, and that is the reason there are two
    /// types instead of two enums.** A new action kind that forgets its
    /// stored form does not compile here; two parallel enums would have
    /// diverged quietly instead.
    pub fn stored(&self) -> Result<ActionKind> {
        match self {
            ProposedAction::SetPolicy { version, rules } => {
                ActionKind::set_policy(*version, rules)
            }
            ProposedAction::Seize {
                token_account,
                amount,
                reason,
            } => ActionKind::seize(*token_account, *amount, *reason),
        }
    }
}

/// What the proposal account stores: the action with its body reduced to a
/// digest.
///
/// **Variants are only ever appended at the end** — the same rule as in
/// `ForgeError`, and for a stronger reason: Borsh encodes the variant by its
/// position, so an insertion in the middle would re-read proposals already on
/// chain as a different action entirely.
///
/// The account is sized by the largest variant (`InitSpace` on an enum is
/// `1 + max`), so a variant that carries a lot makes every proposal pay for
/// it. That is why `SetPolicy` holds a hash and not its 384 bytes of rules —
/// and why `Seize` holds its 74 bytes in the clear: a digest would save 42
/// bytes of rent and cost every approver the ability to read, from the
/// account itself, whose funds and how much they are authorising.
///
/// The size grew with `Seize` and that breaks nothing already on chain:
/// Borsh writes a variant at its own length, so an older proposal reads the
/// same, and nothing looks proposals up by `dataSize`.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ActionKind {
    /// Writing the next policy version (FR-009, FR-010).
    ///
    /// **The first variant is also what an all-zero account reads as.** That
    /// is what `init` leaves behind for the instant between creating the
    /// account and the handler writing it, and it is why a variant that must
    /// never be reached by accident does not belong in position zero.
    SetPolicy { version: u32, rules_hash: [u8; 32] },
    /// A seizure (FR-015): whose account, how much, and why.
    ///
    /// An exact amount rather than "whatever the balance is at execution":
    /// the approvers authorise a number, and the journal can show it before
    /// the action runs. A balance that has shrunk by then makes the
    /// execution fail rather than take less — which is why an officer freezes
    /// the account first, alone and at once, and the quorum follows.
    Seize {
        token_account: Pubkey,
        amount: u64,
        reason: ComplianceReason,
    },
}

impl ActionKind {
    /// The stored form of a policy change, with the digest computed **here**.
    ///
    /// The hash is never accepted from the client — the same reason as in
    /// `PolicyConfig::write`: a hash brought by the party that brought the
    /// bytes proves only that the party knows how to compute hashes. And the
    /// layout is validated at proposal time, so a body that could not have
    /// come out of `encode` never reaches the point where approvers are asked
    /// to authorise it.
    pub fn set_policy(version: u32, rules: &[u8]) -> Result<Self> {
        require!(
            rules.len() == RULES_BYTES,
            ForgeError::PolicyRulesNotCanonical
        );
        let slots: &[RuleSlot] = bytemuck::cast_slice(rules);
        layout::validate(slots)?;
        Ok(ActionKind::SetPolicy {
            version,
            rules_hash: layout::rules_hash(slots),
        })
    }

    /// The stored form of a seizure, checked at proposal time for the same
    /// reason as the rules above: approvers are not asked for days to sign
    /// something the execution would refuse. The execution builds this again
    /// from its own arguments and compares.
    pub fn seize(token_account: Pubkey, amount: u64, reason: ComplianceReason) -> Result<Self> {
        require!(amount > 0, ForgeError::SeizureAmountZero);
        reason.validate()?;
        Ok(ActionKind::Seize {
            token_account,
            amount,
            reason,
        })
    }
}

/// A deferred action of the issuer's quorum. PDA: `["proposal", mint, nonce]`,
/// the nonce a `u64` LE.
///
/// **This account is what T025 brings; the quorum itself came with T014.**
/// `quorum::check` is called over `approvals()` exactly as `set_policy` calls
/// it over the signers of one transaction — the threshold rule does not know
/// which of the two it is serving. What is new here is only that the
/// signatures may arrive on different days (FR-019b).
///
/// **The approvals are addresses, not a bitmap over `IssuerConfig.members`.**
/// A bitmap indexes a slot, and a slot outlives its occupant: once membership
/// changes are implemented (FR-019a), a freed slot taken by another wallet
/// would silently inherit the approval stored against it. Addresses cost 256
/// bytes and make the check at execution time the same one that runs on the
/// immediate path — a member removed between `propose` and execution stops
/// counting, because `quorum::check` reads the membership as it is **now**.
#[account]
#[derive(InitSpace)]
pub struct ActionProposal {
    /// The token this action is about. Every kind that exists is per-token.
    ///
    /// Issuer-level actions — changing the membership and the threshold
    /// (FR-019a) — have no mint, and they are not here yet. When they arrive
    /// the choice is between a second seed family (`["issuer-proposal",
    /// issuer, nonce]`) and generalising this field to a scope; it is not
    /// made in advance, because either one is cheap while no such proposal
    /// exists and neither is guessable before the action is specified.
    pub mint: Pubkey,
    /// The `IssuerConfig` this proposal belongs to.
    ///
    /// Stored rather than derived: `approve_action` and the executing
    /// instruction both take an `IssuerConfig` account, and without this
    /// comparison either could be pointed at a different issuer's config —
    /// one whose membership happens to contain the signer.
    pub issuer: Pubkey,
    /// Who paid the rent, and who gets it back when the proposal is closed.
    pub payer: Pubkey,
    /// The client-chosen number in the seeds. Not a counter: two proposals
    /// raised at the same time must not compete for the next number, the same
    /// reason as `RedemptionEscrow.request_id`.
    pub nonce: u64,
    pub action: ActionKind,
    /// The wallets that have authorised it, in the order they signed.
    /// `approvals[0]` is the proposer.
    pub approvals: [Pubkey; MAX_MEMBERS],
    /// How many entries of `approvals` are in use. Never above `MAX_MEMBERS`.
    pub approval_count: u8,
    pub created_at: i64,
    /// After this moment the proposal is revoked (FR-019b): it can no longer
    /// gather signatures and can no longer be executed. Revocation is the
    /// passage of time, not an instruction someone has to remember to send.
    pub expires_at: i64,
    /// When it was executed, or zero. Zero is a safe sentinel: the Unix epoch
    /// is not a slot time any Solana cluster produces.
    pub executed_at: i64,
    pub bump: u8,
}

/// The narrowest and the widest term a proposal may be given, in seconds.
///
/// Bounds rather than a fixed constant: a pause proposed while an incident is
/// running and a policy change circulated among directors are legitimately
/// days apart. Bounds rather than none: FR-019b requires a term **after which
/// the proposal is revoked**, and a hundred-year term is not a term. The
/// lower bound exists so that a proposal is not dead before the second
/// signatory can read it.
pub const MIN_PROPOSAL_TERM: i64 = 60 * 60;
pub const MAX_PROPOSAL_TERM: i64 = 30 * 24 * 60 * 60;

impl ActionProposal {
    /// The authorisations collected so far, for `quorum::check`.
    pub fn approvals(&self) -> &[Pubkey] {
        &self.approvals[..self.approval_count as usize]
    }

    /// Whether the proposal may still gather signatures or be executed.
    ///
    /// Execution is checked separately from approval on purpose: an expired
    /// proposal that has already collected its quorum must not execute
    /// either, or the term would only mean "no new signatures".
    pub fn live(&self, now: i64) -> Result<()> {
        require!(
            self.executed_at == 0,
            ForgeError::ProposalAlreadyExecuted
        );
        require!(now <= self.expires_at, ForgeError::ProposalExpired);
        Ok(())
    }

    /// Records an authorisation.
    ///
    /// The duplicate is rejected here and again in `quorum::check`, and that
    /// is not redundant: without the check here one member could fill all
    /// eight slots with their own address and leave no room for anyone else,
    /// and the proposal would become unexecutable without ever being wrong.
    pub fn add_approval(&mut self, wallet: Pubkey) -> Result<()> {
        require!(
            !self.approvals().contains(&wallet),
            ForgeError::DuplicateApproval
        );
        let slot = self.approval_count as usize;
        require!(slot < MAX_MEMBERS, ForgeError::ProposalApprovalsFull);
        self.approvals[slot] = wallet;
        self.approval_count += 1;
        Ok(())
    }

    /// Whether the account may be closed and its rent returned.
    ///
    /// Only a finished proposal: executed, or past its term. A live one is
    /// still gathering signatures, and closing it would be a revocation that
    /// FR-019b gives to the clock, not to a single member.
    pub fn closable(&self, now: i64) -> Result<()> {
        require!(
            self.executed_at != 0 || now > self.expires_at,
            ForgeError::ProposalStillLive
        );
        Ok(())
    }
}

/// The term a proposer asked for, in seconds from now.
pub fn validate_term(term: i64) -> Result<()> {
    require!(
        (MIN_PROPOSAL_TERM..=MAX_PROPOSAL_TERM).contains(&term),
        ForgeError::ProposalTermOutOfRange
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::layout::{rule_kind, status_source, RULE_SLOT_BYTES};

    fn wallet(seed: u8) -> Pubkey {
        Pubkey::new_from_array([seed; 32])
    }

    fn err(result: Result<()>) -> u32 {
        match result.expect_err("expected a failure") {
            anchor_lang::error::Error::AnchorError(e) => e.error_code_number,
            other => panic!("unexpected error: {other:?}"),
        }
    }

    fn code(error: ForgeError) -> u32 {
        u32::from(error)
    }

    fn proposal() -> ActionProposal {
        ActionProposal {
            mint: wallet(50),
            issuer: wallet(51),
            payer: wallet(52),
            nonce: 7,
            action: ActionKind::SetPolicy {
                version: 2,
                rules_hash: [7u8; 32],
            },
            approvals: [Pubkey::default(); MAX_MEMBERS],
            approval_count: 0,
            created_at: 1_000,
            expires_at: 10_000,
            executed_at: 0,
            bump: 253,
        }
    }

    /// The minimum a policy must carry: the status rule in slot zero, the rest
    /// empty. `layout::validate` accepts exactly this.
    fn minimal_rules() -> Vec<u8> {
        let mut bytes = vec![0u8; RULES_BYTES];
        bytes[0] = rule_kind::STATUS;
        // Byte 2 is `params[0]`, the source mask: the issuer's own register
        // only. A policy that accepts provider attestations must also name
        // their validity period (FR-008a2), and this fixture needs none.
        bytes[2] = status_source::REGISTER;
        bytes
    }

    #[test]
    fn keeps_the_order_in_which_signatures_arrived() {
        let mut p = proposal();
        p.add_approval(wallet(1)).expect("first");
        p.add_approval(wallet(2)).expect("second");
        assert_eq!(p.approvals(), &[wallet(1), wallet(2)]);
    }

    #[test]
    fn refuses_the_same_wallet_twice() {
        // Otherwise one member would fill all eight slots alone and leave the
        // proposal unexecutable without ever being wrong.
        let mut p = proposal();
        p.add_approval(wallet(1)).expect("first");
        assert_eq!(
            err(p.add_approval(wallet(1))),
            code(ForgeError::DuplicateApproval)
        );
        assert_eq!(p.approval_count, 1);
    }

    #[test]
    fn refuses_a_ninth_signature() {
        let mut p = proposal();
        for seed in 1..=MAX_MEMBERS as u8 {
            p.add_approval(wallet(seed)).expect("within capacity");
        }
        assert_eq!(
            err(p.add_approval(wallet(99))),
            code(ForgeError::ProposalApprovalsFull)
        );
    }

    #[test]
    fn is_live_up_to_and_including_the_last_second_of_its_term() {
        let p = proposal();
        assert!(p.live(9_999).is_ok());
        assert!(p.live(10_000).is_ok());
        assert_eq!(err(p.live(10_001)), code(ForgeError::ProposalExpired));
    }

    #[test]
    fn an_executed_proposal_is_neither_live_nor_executable_again() {
        let mut p = proposal();
        p.executed_at = 5_000;
        assert_eq!(
            err(p.live(5_001)),
            code(ForgeError::ProposalAlreadyExecuted)
        );
    }

    #[test]
    fn an_expired_proposal_that_reached_its_quorum_still_cannot_execute() {
        // Otherwise the term would only mean "no new signatures", and a
        // proposal the issuer let lapse would stay executable forever.
        let mut p = proposal();
        p.add_approval(wallet(1)).expect("first");
        p.add_approval(wallet(2)).expect("second");
        assert_eq!(err(p.live(10_001)), code(ForgeError::ProposalExpired));
    }

    #[test]
    fn closes_only_when_executed_or_past_its_term() {
        let p = proposal();
        assert_eq!(err(p.closable(9_999)), code(ForgeError::ProposalStillLive));
        assert_eq!(
            err(p.closable(10_000)),
            code(ForgeError::ProposalStillLive)
        );
        assert!(p.closable(10_001).is_ok());

        let mut executed = proposal();
        executed.executed_at = 2_000;
        assert!(executed.closable(2_001).is_ok());
    }

    #[test]
    fn a_term_outside_the_bounds_is_refused() {
        assert!(validate_term(MIN_PROPOSAL_TERM).is_ok());
        assert!(validate_term(MAX_PROPOSAL_TERM).is_ok());
        for term in [0, -1, MIN_PROPOSAL_TERM - 1, MAX_PROPOSAL_TERM + 1] {
            assert_eq!(
                err(validate_term(term)),
                code(ForgeError::ProposalTermOutOfRange)
            );
        }
    }

    #[test]
    fn the_stored_form_carries_the_digest_the_program_computed() {
        let rules = minimal_rules();
        let stored = ProposedAction::SetPolicy {
            version: 4,
            rules: rules.clone(),
        }
        .stored()
        .expect("a canonical layout");

        let slots: &[RuleSlot] = bytemuck::cast_slice(&rules);
        assert_eq!(
            stored,
            ActionKind::SetPolicy {
                version: 4,
                rules_hash: layout::rules_hash(slots),
            }
        );
    }

    #[test]
    fn the_execution_path_recomputes_the_same_digest() {
        // This is what makes the hash binding: `set_policy` builds the stored
        // form from the bytes it was given and compares. The two calls below
        // are the proposal side and the execution side.
        let rules = minimal_rules();
        let proposed = ProposedAction::SetPolicy {
            version: 4,
            rules: rules.clone(),
        }
        .stored()
        .expect("a canonical layout");
        let executed = ActionKind::set_policy(4, &rules).expect("a canonical layout");
        assert_eq!(proposed, executed);
    }

    #[test]
    fn different_rules_do_not_share_a_digest() {
        let mut other = minimal_rules();
        other[RULE_SLOT_BYTES] = rule_kind::TRANSFER_LIMIT;
        other[RULE_SLOT_BYTES + 2] = 1; // a non-zero limit: zero is out of range.
        assert_ne!(
            ActionKind::set_policy(4, &minimal_rules()).expect("canonical"),
            ActionKind::set_policy(4, &other).expect("canonical")
        );
    }

    fn a_reason() -> ComplianceReason {
        ComplianceReason {
            code: 4,
            case_ref: crate::state::case_ref_bytes(b"FIU-NG/2026/004117"),
        }
    }

    #[test]
    fn a_seizure_is_stored_as_proposed() {
        let stored = ProposedAction::Seize {
            token_account: wallet(7),
            amount: 500,
            reason: a_reason(),
        }
        .stored()
        .expect("a valid seizure");
        assert_eq!(
            stored,
            ActionKind::Seize {
                token_account: wallet(7),
                amount: 500,
                reason: a_reason(),
            }
        );
    }

    #[test]
    fn a_seizure_of_nothing_or_without_a_reason_never_becomes_a_proposal() {
        assert_eq!(
            err(ActionKind::seize(wallet(7), 0, a_reason()).map(|_| ())),
            code(ForgeError::SeizureAmountZero)
        );
        let unstated = ComplianceReason {
            code: 0,
            ..a_reason()
        };
        assert_eq!(
            err(ActionKind::seize(wallet(7), 500, unstated).map(|_| ())),
            code(ForgeError::ReasonCodeMissing)
        );
    }

    #[test]
    fn every_field_of_a_seizure_is_part_of_what_was_approved() {
        // The execution compares the whole stored form: another account,
        // another amount or another case is another action.
        let approved = ActionKind::seize(wallet(7), 500, a_reason()).expect("valid");
        let other_case = ComplianceReason {
            case_ref: crate::state::case_ref_bytes(b"FIU-NG/2026/004118"),
            ..a_reason()
        };
        for different in [
            ActionKind::seize(wallet(8), 500, a_reason()),
            ActionKind::seize(wallet(7), 499, a_reason()),
            ActionKind::seize(wallet(7), 500, other_case),
        ] {
            assert_ne!(different.expect("valid"), approved);
        }
    }

    #[test]
    fn the_stored_variants_keep_their_positions() {
        // Borsh encodes a variant by its position. `SetPolicy` must stay at
        // zero and `Seize` at one, or proposals already on chain re-read as
        // a different action.
        let mut policy = Vec::new();
        ActionKind::SetPolicy {
            version: 1,
            rules_hash: [0u8; 32],
        }
        .serialize(&mut policy)
        .expect("serialises");
        let mut seizure = Vec::new();
        ActionKind::seize(wallet(7), 500, a_reason())
            .expect("valid")
            .serialize(&mut seizure)
            .expect("serialises");
        assert_eq!((policy[0], seizure[0]), (0, 1));
        assert_eq!(seizure.len(), 1 + 32 + 8 + 2 + 32);
        assert_eq!(ActionKind::INIT_SPACE, seizure.len());
    }

    #[test]
    fn a_body_that_is_not_canonical_never_becomes_a_proposal() {
        // Approvers must not be asked to authorise bytes that could not have
        // come out of `encode`.
        assert_eq!(
            err(ActionKind::set_policy(4, &[0u8; 8]).map(|_| ())),
            code(ForgeError::PolicyRulesNotCanonical)
        );
        assert_eq!(
            err(ActionKind::set_policy(4, &vec![0u8; RULES_BYTES]).map(|_| ())),
            code(ForgeError::PolicyStatusRuleMissing)
        );
    }
}
