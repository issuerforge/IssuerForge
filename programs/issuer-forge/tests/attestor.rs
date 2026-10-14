//! The reserve terms at runtime: replacing the attestor and changing the
//! validity period by quorum (T037, FR-023b, FR-024a).
//!
//! **What the unit tests cannot show.** That `set_attestor` is wired as a
//! policy change is: two members on the immediate path, a matured proposal
//! raised under the token on the deferred one, and nothing else. That the
//! history stays as it was: the attestation the old attestor signed keeps
//! its signer. And that the replacement is real where it matters — the next
//! `attest_reserve` is refused to the old attestor and accepted from the new
//! one.
//!
//! **No token program is involved**, as in `tests/delegation.rs`: the
//! configuration and the first attestation are written directly. The
//! harness helpers are that file's, repeated — each test binary is its own
//! crate.
use std::path::PathBuf;
use std::sync::Once;

use anchor_lang::prelude::Pubkey as AnchorPubkey;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use issuer_forge::constants::{ISSUER_SEED, MAX_MEMBERS, PROPOSAL_SEED, RESERVE_SEED, TOKEN_SEED};
use issuer_forge::error::ForgeError;
use issuer_forge::instructions::{AttestReserveArgs, ProposeActionArgs, SetAttestorArgs};
use issuer_forge::reserve::MAX_ATTESTATION_MAX_AGE;
use issuer_forge::state::{
    case_ref_bytes, currency_bytes, role, ActionKind, ActionProposal, ComplianceReason,
    IssuerConfig, Member, ProposedAction, ReserveAttestation, TokenConfig,
};
use mollusk_svm::result::{InstructionResult, ProgramResult};
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_program_error::ProgramError;
use solana_pubkey::Pubkey;

// ─── The cast ────────────────────────────────────────────────────────────────

const ADMIN_A: u8 = 11;
const ADMIN_B: u8 = 12;
const OFFICER: u8 = 13;
/// The attestor the token was issued with.
const ATTESTOR: u8 = 14;
/// The attestor a change hands the role to.
const SUCCESSOR: u8 = 15;
const PAYER: u8 = 16;
/// Not a member at all.
const STRANGER: u8 = 17;

const NOW: i64 = 1_800_000_000;
const DAY: i64 = 24 * 60 * 60;
const TERM: i64 = 7 * DAY;
const NONCE: u64 = 42;
const MAX_AGE: i64 = 7 * DAY;

const SOL: u64 = 1_000_000_000;

fn reason() -> ComplianceReason {
    ComplianceReason {
        code: 21,
        case_ref: case_ref_bytes(b"AUDIT/2026/0007"),
    }
}

fn wallet(seed: u8) -> AnchorPubkey {
    AnchorPubkey::new_from_array([seed; 32])
}

fn sol(key: &AnchorPubkey) -> Pubkey {
    Pubkey::new_from_array(key.to_bytes())
}

static ARTIFACT: Once = Once::new();

/// See `tests/proposal.rs`: mollusk runs `target/deploy`, not the source.
fn locate_artifact() {
    ARTIFACT.call_once(|| {
        let deploy = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy");
        assert!(
            deploy.join("issuer_forge.so").is_file(),
            "target/deploy/issuer_forge.so is missing — run scripts/wsl-build.sh first. \
             cargo test does not build the bytecode, and mollusk runs the artifact, \
             not the source."
        );
        std::env::set_var("SBF_OUT_DIR", deploy);
    });
}

fn stored<T: AccountSerialize>(value: &T, lamports: u64) -> Account {
    let mut data = Vec::new();
    value
        .try_serialize(&mut data)
        .expect("an account the program itself writes");
    Account {
        lamports,
        data,
        owner: sol(&issuer_forge::ID),
        executable: false,
        rent_epoch: 0,
    }
}

fn funded(lamports: u64) -> Account {
    Account {
        lamports,
        data: Vec::new(),
        owner: sol(&anchor_lang::system_program::ID),
        executable: false,
        rent_epoch: 0,
    }
}

struct Fixture {
    mollusk: Mollusk,
    accounts: Vec<(Pubkey, Account)>,
    issuer_config: AnchorPubkey,
    token_config: AnchorPubkey,
    /// A proposal raised under the token's scope.
    token_proposal: AnchorPubkey,
    /// A proposal raised under the issuer's own scope.
    issuer_proposal: AnchorPubkey,
    /// Attestation #0, signed by `ATTESTOR` at issuance.
    first_attestation: AnchorPubkey,
    /// Where attestation #1 will be created.
    next_attestation: AnchorPubkey,
}

impl Fixture {
    /// An issuer of two admins, an officer and two attestors, quorum 2, with
    /// one token attested once by `ATTESTOR`.
    fn new() -> Self {
        locate_artifact();

        let program_id = issuer_forge::ID;
        let issuer_id = wallet(99);
        let mint = wallet(98);

        let (issuer_config, issuer_bump) =
            AnchorPubkey::find_program_address(&[ISSUER_SEED, issuer_id.as_ref()], &program_id);
        let (token_config, token_bump) =
            AnchorPubkey::find_program_address(&[TOKEN_SEED, mint.as_ref()], &program_id);
        let (token_proposal, _) = AnchorPubkey::find_program_address(
            &[PROPOSAL_SEED, mint.as_ref(), &NONCE.to_le_bytes()],
            &program_id,
        );
        let (issuer_proposal, _) = AnchorPubkey::find_program_address(
            &[PROPOSAL_SEED, issuer_config.as_ref(), &NONCE.to_le_bytes()],
            &program_id,
        );
        let attestation_at = |index: u64| {
            AnchorPubkey::find_program_address(
                &[RESERVE_SEED, mint.as_ref(), &index.to_le_bytes()],
                &program_id,
            )
        };
        let (first_attestation, first_bump) = attestation_at(0);
        let (next_attestation, _) = attestation_at(1);

        let mut members = [Member::default(); MAX_MEMBERS];
        for (slot, (seed, roles)) in [
            (ADMIN_A, role::ADMIN),
            (ADMIN_B, role::ADMIN),
            (OFFICER, role::COMPLIANCE),
            (ATTESTOR, role::ATTESTOR),
            (SUCCESSOR, role::ATTESTOR),
        ]
        .into_iter()
        .enumerate()
        {
            members[slot] = Member {
                wallet: wallet(seed),
                roles,
            };
        }

        let issuer = IssuerConfig {
            issuer_id,
            members,
            member_slots: 5,
            quorum_n: 2,
            operational_key: wallet(90),
            delegation_mask: 0,
            bump: issuer_bump,
            token_count: 1,
        };

        let token = TokenConfig {
            issuer: issuer_config,
            mint,
            attestation_credential: wallet(81),
            attestation_schema: wallet(82),
            attestor: wallet(ATTESTOR),
            treasury: wallet(84),
            policy_version: 1,
            fee_bps: 0,
            attestation_max_age: MAX_AGE,
            paused_at: 0,
            bump: token_bump,
            attestation_count: 1,
            reserve_currency: currency_bytes(b"NGN"),
        };

        let first = ReserveAttestation {
            mint,
            index: 0,
            amount: 1_000_000,
            currency: currency_bytes(b"NGN"),
            attestor: wallet(ATTESTOR),
            attested_at: NOW - DAY,
            bump: first_bump,
        };

        let mut mollusk = Mollusk::new(&sol(&program_id), "issuer_forge");
        mollusk.sysvars.clock.unix_timestamp = NOW;

        let mut accounts = vec![
            (sol(&issuer_config), stored(&issuer, SOL)),
            (sol(&token_config), stored(&token, SOL)),
            (sol(&first_attestation), stored(&first, SOL)),
            (sol(&next_attestation), funded(0)),
            (sol(&token_proposal), funded(0)),
            (sol(&issuer_proposal), funded(0)),
            (sol(&wallet(PAYER)), funded(100 * SOL)),
        ];
        for seed in [ADMIN_A, ADMIN_B, OFFICER, ATTESTOR, SUCCESSOR, STRANGER] {
            accounts.push((sol(&wallet(seed)), funded(SOL)));
        }
        accounts.push(mollusk_svm::program::keyed_account_for_system_program());

        Self {
            mollusk,
            accounts,
            issuer_config,
            token_config,
            token_proposal,
            issuer_proposal,
            first_attestation,
            next_attestation,
        }
    }

    /// Runs one instruction at `now`, carrying the accounts forward on success.
    fn run(&mut self, now: i64, make: impl FnOnce(&Self) -> Instruction) -> InstructionResult {
        self.mollusk.sysvars.clock.unix_timestamp = now;
        let instruction = make(self);
        let result = self
            .mollusk
            .process_instruction(&instruction, &self.accounts);
        if result.program_result.is_ok() {
            self.accounts = result.resulting_accounts.clone();
        }
        result
    }

    fn account(&self, key: &AnchorPubkey) -> &Account {
        let wanted = sol(key);
        &self
            .accounts
            .iter()
            .find(|(candidate, _)| *candidate == wanted)
            .expect("an account the fixture put in the list")
            .1
    }

    fn token_state(&self) -> TokenConfig {
        let data = &self.account(&self.token_config).data;
        TokenConfig::try_deserialize(&mut &data[..]).expect("a token config")
    }

    fn proposal_state(&self, address: &AnchorPubkey) -> ActionProposal {
        let data = &self.account(address).data;
        ActionProposal::try_deserialize(&mut &data[..]).expect("a proposal the program wrote")
    }

    fn attestation_state(&self, address: &AnchorPubkey) -> ReserveAttestation {
        let data = &self.account(address).data;
        ReserveAttestation::try_deserialize(&mut &data[..]).expect("an attestation")
    }

    /// The terms as the program holds them: (attestor, period).
    fn terms(&self) -> (AnchorPubkey, i64) {
        let token = self.token_state();
        (token.attestor, token.attestation_max_age)
    }

    // ─── Instructions ────────────────────────────────────────────────────────

    fn propose(&self, proposer: u8, action: ProposedAction, on_token: bool) -> Instruction {
        build(
            issuer_forge::accounts::ProposeAction {
                issuer_config: self.issuer_config,
                token_config: on_token.then_some(self.token_config),
                proposal: if on_token {
                    self.token_proposal
                } else {
                    self.issuer_proposal
                },
                payer: wallet(PAYER),
                proposer: wallet(proposer),
                system_program: anchor_lang::system_program::ID,
            },
            issuer_forge::instruction::ProposeAction {
                args: ProposeActionArgs {
                    nonce: NONCE,
                    term_seconds: TERM,
                    action,
                },
            },
            Vec::new(),
        )
    }

    fn approve(&self, approver: u8) -> Instruction {
        build(
            issuer_forge::accounts::ApproveAction {
                issuer_config: self.issuer_config,
                proposal: self.token_proposal,
                approver: wallet(approver),
            },
            issuer_forge::instruction::ApproveAction {},
            Vec::new(),
        )
    }

    /// `set_attestor` on the immediate path, signed by `signers`.
    fn set_now(
        &self,
        attestor: u8,
        max_age: i64,
        reason: ComplianceReason,
        signers: &[u8],
    ) -> Instruction {
        self.set(attestor, max_age, reason, None, signing(signers))
    }

    /// `set_attestor` on the deferred path, naming the proposal's approvers.
    fn set_from_proposal(&self, attestor: u8, max_age: i64) -> Instruction {
        let approvers = self
            .proposal_state(&self.token_proposal)
            .approvals()
            .to_vec();
        self.set(
            attestor,
            max_age,
            reason(),
            Some(self.token_proposal),
            listed(&approvers),
        )
    }

    fn set(
        &self,
        attestor: u8,
        max_age: i64,
        reason: ComplianceReason,
        proposal: Option<AnchorPubkey>,
        extra: Vec<AccountMeta>,
    ) -> Instruction {
        build(
            issuer_forge::accounts::SetAttestor {
                issuer_config: self.issuer_config,
                token_config: self.token_config,
                proposal,
            },
            issuer_forge::instruction::SetAttestor {
                args: SetAttestorArgs {
                    attestor: wallet(attestor),
                    attestation_max_age: max_age,
                    reason,
                },
            },
            extra,
        )
    }

    /// `attest_reserve` #1, signed by `attestor` under the period `max_age`.
    fn attest(&self, attestor: u8, max_age: i64) -> Instruction {
        build(
            issuer_forge::accounts::AttestReserve {
                token_config: self.token_config,
                attestation: self.next_attestation,
                attestor: wallet(attestor),
                payer: wallet(PAYER),
                system_program: anchor_lang::system_program::ID,
            },
            issuer_forge::instruction::AttestReserve {
                args: AttestReserveArgs {
                    amount: 2_000_000,
                    currency: currency_bytes(b"NGN"),
                    attested_at: NOW,
                    attestation_max_age: max_age,
                },
            },
            Vec::new(),
        )
    }
}

fn build<A: ToAccountMetas, D: InstructionData>(
    accounts: A,
    data: D,
    extra: Vec<AccountMeta>,
) -> Instruction {
    let mut metas: Vec<AccountMeta> = accounts
        .to_account_metas(None)
        .iter()
        .map(|meta| AccountMeta {
            pubkey: sol(&meta.pubkey),
            is_signer: meta.is_signer,
            is_writable: meta.is_writable,
        })
        .collect();
    metas.extend(extra);
    Instruction {
        program_id: sol(&issuer_forge::ID),
        accounts: metas,
        data: data.data(),
    }
}

fn signing(seeds: &[u8]) -> Vec<AccountMeta> {
    seeds
        .iter()
        .map(|seed| AccountMeta {
            pubkey: sol(&wallet(*seed)),
            is_signer: true,
            is_writable: false,
        })
        .collect()
}

fn listed(keys: &[AnchorPubkey]) -> Vec<AccountMeta> {
    keys.iter()
        .map(|key| AccountMeta {
            pubkey: sol(key),
            is_signer: false,
            is_writable: false,
        })
        .collect()
}

fn refusal(result: &InstructionResult) -> u32 {
    match &result.program_result {
        ProgramResult::Failure(ProgramError::Custom(code)) => *code,
        other => panic!("expected a refusal from the program, got {other:?}"),
    }
}

fn code(error: ForgeError) -> u32 {
    u32::from(error)
}

fn succeeded(result: &InstructionResult) {
    assert_eq!(
        result.program_result,
        ProgramResult::Success,
        "expected success, got {:?}",
        result.program_result
    );
}

fn handover(max_age: i64) -> ProposedAction {
    ProposedAction::SetAttestor {
        attestor: wallet(SUCCESSOR),
        attestation_max_age: max_age,
        reason: reason(),
    }
}

// ─── The immediate path ──────────────────────────────────────────────────────

#[test]
fn the_quorum_replaces_the_attestor_and_history_keeps_the_old_signer() {
    let mut f = Fixture::new();
    succeeded(&f.run(NOW, |f| {
        f.set_now(SUCCESSOR, 30 * DAY, reason(), &[ADMIN_A, ADMIN_B])
    }));
    assert_eq!(f.terms(), (wallet(SUCCESSOR), 30 * DAY));

    // FR-024a: the attestation signed before the change stays as it was.
    let first = f.attestation_state(&f.first_attestation);
    assert_eq!(first.attestor, wallet(ATTESTOR));
    assert_eq!(first.index, 0);

    // And the replacement is real: the old attestor signs nothing further.
    assert_eq!(
        refusal(&f.run(NOW, |f| f.attest(ATTESTOR, 30 * DAY))),
        code(ForgeError::NotTheAttestor)
    );
    succeeded(&f.run(NOW, |f| f.attest(SUCCESSOR, 30 * DAY)));
    let next = f.attestation_state(&f.next_attestation);
    assert_eq!((next.index, next.attestor), (1, wallet(SUCCESSOR)));
}

#[test]
fn the_period_alone_changes_and_the_attestor_stays() {
    let mut f = Fixture::new();
    succeeded(&f.run(NOW, |f| {
        f.set_now(ATTESTOR, DAY, reason(), &[ADMIN_A, OFFICER])
    }));
    assert_eq!(f.terms(), (wallet(ATTESTOR), DAY));

    // An attestation signed for the old period does not land as one for the
    // new: the attestor signs the terms, not only the amount.
    assert_eq!(
        refusal(&f.run(NOW, |f| f.attest(ATTESTOR, MAX_AGE))),
        code(ForgeError::AttestationMaxAgeMismatch)
    );
    succeeded(&f.run(NOW, |f| f.attest(ATTESTOR, DAY)));
}

#[test]
fn one_signature_changes_nothing() {
    let mut f = Fixture::new();
    assert_eq!(
        refusal(&f.run(NOW, |f| f.set_now(SUCCESSOR, MAX_AGE, reason(), &[ADMIN_A]))),
        code(ForgeError::QuorumNotReached)
    );
    assert_eq!(f.terms(), (wallet(ATTESTOR), MAX_AGE));
}

#[test]
fn an_attestor_does_not_fill_the_quorum_that_appoints_one() {
    // FR-024: the attestor role grants nothing else — not even a say in who
    // attests next.
    let mut f = Fixture::new();
    assert_eq!(
        refusal(&f.run(NOW, |f| f.set_now(
            SUCCESSOR,
            MAX_AGE,
            reason(),
            &[ADMIN_A, SUCCESSOR]
        ))),
        code(ForgeError::NotAnAuthorisingSigner)
    );
    assert_eq!(f.terms(), (wallet(ATTESTOR), MAX_AGE));
}

#[test]
fn the_new_attestor_must_already_hold_the_role() {
    let mut f = Fixture::new();
    for outsider in [ADMIN_A, STRANGER] {
        assert_eq!(
            refusal(&f.run(NOW, |f| f.set_now(
                outsider,
                MAX_AGE,
                reason(),
                &[ADMIN_A, ADMIN_B]
            ))),
            code(ForgeError::NotAnAttestorMember)
        );
    }
    assert_eq!(f.terms(), (wallet(ATTESTOR), MAX_AGE));
}

#[test]
fn a_change_without_a_reason_or_without_a_period_is_refused() {
    let mut f = Fixture::new();
    let unstated = ComplianceReason {
        code: 0,
        ..reason()
    };
    assert_eq!(
        refusal(&f.run(NOW, |f| f.set_now(
            SUCCESSOR,
            MAX_AGE,
            unstated,
            &[ADMIN_A, ADMIN_B]
        ))),
        code(ForgeError::ReasonCodeMissing)
    );
    for max_age in [0, MAX_ATTESTATION_MAX_AGE + 1] {
        assert_eq!(
            refusal(&f.run(NOW, |f| f.set_now(
                SUCCESSOR,
                max_age,
                reason(),
                &[ADMIN_A, ADMIN_B]
            ))),
            code(ForgeError::AttestationMaxAgeInvalid)
        );
    }
    assert_eq!(
        refusal(&f.run(NOW, |f| f.set_now(
            ATTESTOR,
            MAX_AGE,
            reason(),
            &[ADMIN_A, ADMIN_B]
        ))),
        code(ForgeError::AttestationTermsUnchanged)
    );
    assert_eq!(f.terms(), (wallet(ATTESTOR), MAX_AGE));
}

// ─── The deferred path ───────────────────────────────────────────────────────

#[test]
fn a_change_collected_across_days_executes_from_the_token_scope() {
    let mut f = Fixture::new();
    succeeded(&f.run(NOW, |f| f.propose(ADMIN_A, handover(30 * DAY), true)));
    assert_eq!(
        f.proposal_state(&f.token_proposal).action,
        ActionKind::SetAttestor {
            previous_attestor: wallet(ATTESTOR),
            previous_max_age: MAX_AGE,
            attestor: wallet(SUCCESSOR),
            max_age: 30 * DAY,
            reason: reason(),
        }
    );

    // One signature is still a proposal.
    assert_eq!(
        refusal(&f.run(NOW + DAY, |f| f.set_from_proposal(SUCCESSOR, 30 * DAY))),
        code(ForgeError::QuorumNotReached)
    );
    succeeded(&f.run(NOW + DAY, |f| f.approve(ADMIN_B)));
    succeeded(&f.run(NOW + 2 * DAY, |f| f.set_from_proposal(SUCCESSOR, 30 * DAY)));

    assert_eq!(f.terms(), (wallet(SUCCESSOR), 30 * DAY));
    assert_eq!(
        f.proposal_state(&f.token_proposal).executed_at,
        NOW + 2 * DAY
    );
}

#[test]
fn a_change_in_between_stops_a_proposal_already_approved() {
    // The terms the proposal was raised against are gone: executing it would
    // silently undo the change made in between.
    let mut f = Fixture::new();
    succeeded(&f.run(NOW, |f| f.propose(ADMIN_A, handover(30 * DAY), true)));
    succeeded(&f.run(NOW, |f| f.approve(ADMIN_B)));
    succeeded(&f.run(NOW + DAY, |f| {
        f.set_now(ATTESTOR, DAY, reason(), &[ADMIN_A, ADMIN_B])
    }));

    assert_eq!(
        refusal(&f.run(NOW + DAY, |f| f.set_from_proposal(SUCCESSOR, 30 * DAY))),
        code(ForgeError::AttestationTermsChangedSinceProposal)
    );
    assert_eq!(f.terms(), (wallet(ATTESTOR), DAY));
}

#[test]
fn execution_is_bound_to_the_approved_terms() {
    let mut f = Fixture::new();
    succeeded(&f.run(NOW, |f| f.propose(ADMIN_A, handover(30 * DAY), true)));
    succeeded(&f.run(NOW, |f| f.approve(ADMIN_B)));
    assert_eq!(
        refusal(&f.run(NOW, |f| f.set_from_proposal(SUCCESSOR, 60 * DAY))),
        code(ForgeError::ProposalBodyMismatch)
    );
    assert_eq!(f.terms(), (wallet(ATTESTOR), MAX_AGE));
}

#[test]
fn the_deferred_path_names_exactly_the_approvers_the_proposal_holds() {
    let mut f = Fixture::new();
    succeeded(&f.run(NOW, |f| f.propose(ADMIN_A, handover(30 * DAY), true)));
    succeeded(&f.run(NOW, |f| f.approve(ADMIN_B)));
    assert_eq!(
        refusal(&f.run(NOW, |f| f.set(
            SUCCESSOR,
            30 * DAY,
            reason(),
            Some(f.token_proposal),
            listed(&[wallet(ADMIN_A)]),
        ))),
        code(ForgeError::ApproversNotListed)
    );
    assert_eq!(f.terms(), (wallet(ATTESTOR), MAX_AGE));
}

#[test]
fn an_attestor_change_is_raised_only_under_its_token() {
    let mut f = Fixture::new();
    assert_eq!(
        refusal(&f.run(NOW, |f| f.propose(ADMIN_A, handover(30 * DAY), false))),
        code(ForgeError::ProposalScopeMismatch)
    );
}
