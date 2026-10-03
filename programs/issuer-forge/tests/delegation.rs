//! The operational key's delegation at runtime (T030, FR-035, FR-035a,
//! FR-035b, SC-012).
//!
//! **Two things are proved here that the unit tests cannot.** First, that the
//! key with every power delegated is refused by every instruction that moves
//! funds or changes configuration — not by a check each of them carries, but
//! because none of them accepts anyone outside the membership and the key is
//! never in it. The attempts are made against the deployed artifact, the way
//! a compromised key would make them: signed, well-formed, straight to the
//! program. Second, that `set_delegation` is wired as specified on both
//! paths: one admin narrows, the quorum grants and rotates, and a proposal
//! executes only from the delegation it was raised against.
//!
//! **Not the SC-012 measurement.** That is T036, against devnet and through
//! the API. This is the program's side of the same claim.
//!
//! **No token program is involved**, as in `tests/proposal.rs`: every
//! instruction here names the token through `TokenConfig`, and the two
//! configuration accounts are written directly. The harness helpers are that
//! file's, repeated — each test binary is its own crate.
use std::path::PathBuf;
use std::sync::Once;

use anchor_lang::prelude::Pubkey as AnchorPubkey;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use issuer_forge::constants::{ISSUER_SEED, MAX_MEMBERS, POLICY_SEED, PROPOSAL_SEED, TOKEN_SEED};
use issuer_forge::error::ForgeError;
use issuer_forge::instructions::{
    InitializeIssuerArgs, ProposeActionArgs, SetDelegationArgs, SetPolicyArgs,
};
use issuer_forge::rules::layout::{rule_kind, status_source, RULES_BYTES};
use issuer_forge::state::{
    case_ref_bytes, delegation, role, ActionKind, ActionProposal, ComplianceReason, IssuerConfig,
    Member, ProposedAction, TokenConfig,
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
const OBSERVER: u8 = 14;
const PAYER: u8 = 16;
/// The platform's operational key.
const OPERATOR: u8 = 90;
/// The key a rotation hands the delegation to.
const SUCCESSOR: u8 = 91;

const NOW: i64 = 1_800_000_000;
const DAY: i64 = 24 * 60 * 60;
const TERM: i64 = 7 * DAY;
const NONCE: u64 = 42;
const CURRENT_VERSION: u32 = 1;
const NEXT_VERSION: u32 = 2;

const SOL: u64 = 1_000_000_000;

fn reason() -> ComplianceReason {
    ComplianceReason {
        code: 12,
        case_ref: case_ref_bytes(b"ORDER/2026/0031"),
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

fn rules() -> Vec<u8> {
    let mut bytes = vec![0u8; RULES_BYTES];
    bytes[0] = rule_kind::STATUS;
    bytes[2] = status_source::REGISTER;
    bytes[3] = 2;
    bytes
}

struct Fixture {
    mollusk: Mollusk,
    accounts: Vec<(Pubkey, Account)>,
    mint: AnchorPubkey,
    issuer_config: AnchorPubkey,
    token_config: AnchorPubkey,
    /// A proposal raised under the issuer's own scope.
    issuer_proposal: AnchorPubkey,
    /// A proposal raised under the token's scope.
    token_proposal: AnchorPubkey,
    policy_config: AnchorPubkey,
    /// The address a second issuer would be created at.
    new_issuer_id: AnchorPubkey,
    new_issuer_config: AnchorPubkey,
}

impl Fixture {
    /// An issuer of two admins, an officer and an observer, quorum 2, whose
    /// operational key holds `mask`.
    fn new(mask: u8) -> Self {
        locate_artifact();

        let program_id = issuer_forge::ID;
        let issuer_id = wallet(99);
        let mint = wallet(98);
        let new_issuer_id = wallet(97);

        let (issuer_config, issuer_bump) =
            AnchorPubkey::find_program_address(&[ISSUER_SEED, issuer_id.as_ref()], &program_id);
        let (token_config, token_bump) =
            AnchorPubkey::find_program_address(&[TOKEN_SEED, mint.as_ref()], &program_id);
        let (issuer_proposal, _) = AnchorPubkey::find_program_address(
            &[PROPOSAL_SEED, issuer_config.as_ref(), &NONCE.to_le_bytes()],
            &program_id,
        );
        let (token_proposal, _) = AnchorPubkey::find_program_address(
            &[PROPOSAL_SEED, mint.as_ref(), &NONCE.to_le_bytes()],
            &program_id,
        );
        let (policy_config, _) = AnchorPubkey::find_program_address(
            &[POLICY_SEED, mint.as_ref(), &NEXT_VERSION.to_le_bytes()],
            &program_id,
        );
        let (new_issuer_config, _) =
            AnchorPubkey::find_program_address(&[ISSUER_SEED, new_issuer_id.as_ref()], &program_id);

        let mut members = [Member::default(); MAX_MEMBERS];
        for (slot, (seed, roles)) in [
            (ADMIN_A, role::ADMIN),
            (ADMIN_B, role::ADMIN),
            (OFFICER, role::COMPLIANCE),
            (OBSERVER, role::OBSERVER),
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
            member_slots: 4,
            quorum_n: 2,
            operational_key: wallet(OPERATOR),
            delegation_mask: mask,
            bump: issuer_bump,
            token_count: 1,
        };

        let token = TokenConfig {
            issuer: issuer_config,
            mint,
            attestation_credential: wallet(81),
            attestation_schema: wallet(82),
            attestor: wallet(83),
            treasury: wallet(84),
            policy_version: CURRENT_VERSION,
            fee_bps: 0,
            attestation_max_age: 30 * DAY,
            paused_at: 0,
            bump: token_bump,
            attestation_count: 1,
            reserve_currency: issuer_forge::state::currency_bytes(b"NGN"),
        };

        let mut mollusk = Mollusk::new(&sol(&program_id), "issuer_forge");
        mollusk.sysvars.clock.unix_timestamp = NOW;

        let mut accounts = vec![
            (sol(&issuer_config), stored(&issuer, SOL)),
            (sol(&token_config), stored(&token, SOL)),
            (sol(&issuer_proposal), funded(0)),
            (sol(&token_proposal), funded(0)),
            (sol(&policy_config), funded(0)),
            (sol(&new_issuer_config), funded(0)),
            (sol(&wallet(PAYER)), funded(100 * SOL)),
        ];
        for seed in [ADMIN_A, ADMIN_B, OFFICER, OBSERVER, OPERATOR, SUCCESSOR] {
            accounts.push((sol(&wallet(seed)), funded(SOL)));
        }
        accounts.push(mollusk_svm::program::keyed_account_for_system_program());

        Self {
            mollusk,
            accounts,
            mint,
            issuer_config,
            token_config,
            issuer_proposal,
            token_proposal,
            policy_config,
            new_issuer_id,
            new_issuer_config,
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

    fn issuer_state(&self) -> IssuerConfig {
        let data = &self.account(&self.issuer_config).data;
        IssuerConfig::try_deserialize(&mut &data[..]).expect("an issuer config")
    }

    fn proposal_state(&self, address: &AnchorPubkey) -> ActionProposal {
        let data = &self.account(address).data;
        ActionProposal::try_deserialize(&mut &data[..]).expect("a proposal the program wrote")
    }

    /// The delegation as the program holds it: (key, mask).
    fn delegation(&self) -> (AnchorPubkey, u8) {
        let issuer = self.issuer_state();
        (issuer.operational_key, issuer.delegation_mask)
    }

    // ─── Instructions ────────────────────────────────────────────────────────

    /// `propose_action`. `on_token` decides whether a `TokenConfig` is named,
    /// independently of the action, so the scope checks can be crossed.
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

    fn approve(&self, proposal: AnchorPubkey, approver: u8) -> Instruction {
        build(
            issuer_forge::accounts::ApproveAction {
                issuer_config: self.issuer_config,
                proposal,
                approver: wallet(approver),
            },
            issuer_forge::instruction::ApproveAction {},
            Vec::new(),
        )
    }

    fn close(&self, proposal: AnchorPubkey, member: u8) -> Instruction {
        build(
            issuer_forge::accounts::CloseActionProposal {
                issuer_config: self.issuer_config,
                proposal,
                rent_recipient: wallet(PAYER),
                member: wallet(member),
            },
            issuer_forge::instruction::CloseActionProposal {},
            Vec::new(),
        )
    }

    /// `set_delegation` on the immediate path, signed by `signers`.
    fn delegate_now(&self, key: u8, mask: u8, signers: &[u8]) -> Instruction {
        self.delegate(key, mask, None, signing(signers))
    }

    /// `set_delegation` on the deferred path, naming the proposal's approvers.
    fn delegate_from(&self, proposal: AnchorPubkey, key: u8, mask: u8) -> Instruction {
        let approvers = self.proposal_state(&proposal).approvals().to_vec();
        self.delegate(key, mask, Some(proposal), listed(&approvers))
    }

    fn delegate(
        &self,
        key: u8,
        mask: u8,
        proposal: Option<AnchorPubkey>,
        extra: Vec<AccountMeta>,
    ) -> Instruction {
        build(
            issuer_forge::accounts::SetDelegation {
                issuer_config: self.issuer_config,
                proposal,
            },
            issuer_forge::instruction::SetDelegation {
                args: SetDelegationArgs {
                    operational_key: wallet(key),
                    mask,
                },
            },
            extra,
        )
    }

    fn set_policy_now(&self, signers: &[u8]) -> Instruction {
        build(
            issuer_forge::accounts::SetPolicy {
                issuer_config: self.issuer_config,
                token_config: self.token_config,
                policy_config: self.policy_config,
                payer: wallet(PAYER),
                system_program: anchor_lang::system_program::ID,
                proposal: None,
            },
            issuer_forge::instruction::SetPolicy {
                args: SetPolicyArgs {
                    version: NEXT_VERSION,
                    rules: rules(),
                    reason: reason(),
                },
            },
            signing(signers),
        )
    }

    /// `initialize_issuer` for a second issuer, founded by `founder`.
    fn found(&self, founder: u8, members: &[(u8, u8)], operational_key: u8) -> Instruction {
        build(
            issuer_forge::accounts::InitializeIssuer {
                issuer_config: self.new_issuer_config,
                payer: wallet(PAYER),
                founder: wallet(founder),
                system_program: anchor_lang::system_program::ID,
            },
            issuer_forge::instruction::InitializeIssuer {
                args: InitializeIssuerArgs {
                    issuer_id: self.new_issuer_id,
                    members: members
                        .iter()
                        .map(|(seed, roles)| Member {
                            wallet: wallet(*seed),
                            roles: *roles,
                        })
                        .collect(),
                    quorum_n: 2,
                    operational_key: wallet(operational_key),
                    delegation_mask: delegation::ALL,
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

fn grant(mask: u8) -> ProposedAction {
    ProposedAction::SetDelegation {
        operational_key: wallet(OPERATOR),
        mask,
    }
}

// ─── FR-035a: the key with every power signs nothing that matters ────────────

#[test]
fn the_operational_key_with_every_power_is_refused_everywhere_it_does_not_belong() {
    // SC-012 from the program's side: each attempt is signed by the key,
    // well-formed, and sent straight to the program — what a leaked key
    // would do. Each fails for the reason that matters: the key is not a
    // member, so it is nobody the program counts. A refusal reverts the
    // whole instruction, so the code is the proof that nothing changed.
    let mut fixture = Fixture::new(delegation::ALL);
    let not_a_signer = code(ForgeError::NotAnAuthorisingSigner);

    // First the attempts that would create something: the proposal
    // addresses are still empty, so a refusal is ours and not `init`'s.
    let creating: Vec<(&str, Instruction, u32)> = vec![
        (
            "policy change, alone",
            fixture.set_policy_now(&[OPERATOR]),
            not_a_signer,
        ),
        (
            "policy change, as the second signature",
            fixture.set_policy_now(&[ADMIN_A, OPERATOR]),
            not_a_signer,
        ),
        (
            "proposing a policy change",
            fixture.propose(
                OPERATOR,
                ProposedAction::SetPolicy {
                    version: NEXT_VERSION,
                    rules: rules(),
                    reason: reason(),
                },
                true,
            ),
            not_a_signer,
        ),
        (
            "proposing a seizure",
            fixture.propose(
                OPERATOR,
                ProposedAction::Seize {
                    token_account: wallet(70),
                    amount: 1,
                    reason: reason(),
                },
                true,
            ),
            not_a_signer,
        ),
        (
            "proposing a pause",
            fixture.propose(OPERATOR, ProposedAction::Pause { reason: reason() }, true),
            not_a_signer,
        ),
        (
            "proposing a resumption",
            fixture.propose(OPERATOR, ProposedAction::Resume { reason: reason() }, true),
            not_a_signer,
        ),
        (
            "proposing its own rotation",
            fixture.propose(
                OPERATOR,
                ProposedAction::SetDelegation {
                    operational_key: wallet(SUCCESSOR),
                    mask: delegation::ALL,
                },
                false,
            ),
            not_a_signer,
        ),
        (
            "rotating itself, alone",
            fixture.delegate_now(SUCCESSOR, delegation::ALL, &[OPERATOR]),
            not_a_signer,
        ),
        (
            "rotating itself, as the second signature",
            fixture.delegate_now(SUCCESSOR, delegation::ALL, &[ADMIN_A, OPERATOR]),
            not_a_signer,
        ),
        (
            "revoking a power, as if an admin",
            fixture.delegate_now(OPERATOR, delegation::THAW_HOLDER, &[OPERATOR]),
            not_a_signer,
        ),
        (
            "founding an issuer it is not in",
            fixture.found(
                OPERATOR,
                &[(ADMIN_A, role::ADMIN), (ADMIN_B, role::ADMIN)],
                OPERATOR,
            ),
            code(ForgeError::NotAnAdmin),
        ),
        (
            "founding an issuer with itself as an admin",
            fixture.found(
                OPERATOR,
                &[(OPERATOR, role::ADMIN), (ADMIN_B, role::ADMIN)],
                OPERATOR,
            ),
            code(ForgeError::OperationalKeyIsAMember),
        ),
    ];

    for (what, instruction, expected) in &creating {
        let result = fixture
            .mollusk
            .process_instruction(instruction, &fixture.accounts);
        assert_eq!(refusal(&result), *expected, "{what}");
    }

    // Then the attempts on a live proposal an admin raised: pushing it over
    // the threshold, or erasing it.
    succeeded(&fixture.run(NOW, |f| {
        f.propose(ADMIN_A, ProposedAction::Pause { reason: reason() }, true)
    }));
    let on_a_proposal: Vec<(&str, Instruction, u32)> = vec![
        (
            "approving an admin's pause",
            fixture.approve(fixture.token_proposal, OPERATOR),
            not_a_signer,
        ),
        (
            "closing an admin's proposal",
            fixture.close(fixture.token_proposal, OPERATOR),
            not_a_signer,
        ),
    ];

    for (what, instruction, expected) in &on_a_proposal {
        let result = fixture
            .mollusk
            .process_instruction(instruction, &fixture.accounts);
        assert_eq!(refusal(&result), *expected, "{what}");
    }
    assert!(
        creating.len() + on_a_proposal.len() >= 10,
        "SC-012 asks for at least ten"
    );

    // The fixture itself: the same calls by members do go through, so the
    // refusals above are about who signed and not about how the call was
    // built.
    succeeded(&fixture.run(NOW, |f| f.approve(f.token_proposal, ADMIN_B)));
    succeeded(&fixture.run(NOW, |f| f.set_policy_now(&[ADMIN_A, ADMIN_B])));
    succeeded(&fixture.run(NOW, |f| f.delegate_now(OPERATOR, 0, &[ADMIN_A])));
    succeeded(&fixture.run(NOW, |f| {
        f.found(
            ADMIN_A,
            &[(ADMIN_A, role::ADMIN), (ADMIN_B, role::ADMIN)],
            OPERATOR,
        )
    }));
}

// ─── FR-035b: one admin revokes ──────────────────────────────────────────────

#[test]
fn one_admin_revokes_the_whole_delegation_in_one_action() {
    let mut fixture = Fixture::new(delegation::ALL);
    succeeded(&fixture.run(NOW, |f| f.delegate_now(OPERATOR, 0, &[ADMIN_A])));
    assert_eq!(fixture.delegation(), (wallet(OPERATOR), 0));
}

#[test]
fn one_admin_takes_away_a_single_power() {
    let mut fixture = Fixture::new(delegation::ALL);
    let kept = delegation::THAW_HOLDER | delegation::SETTLE_REDEMPTION;
    succeeded(&fixture.run(NOW, |f| f.delegate_now(OPERATOR, kept, &[ADMIN_B])));
    assert_eq!(fixture.delegation(), (wallet(OPERATOR), kept));
}

#[test]
fn an_officer_alone_does_not_revoke() {
    // The officer may sign beside an admin, not instead of one.
    let mut fixture = Fixture::new(delegation::ALL);
    let result = fixture.run(NOW, |f| f.delegate_now(OPERATOR, 0, &[OFFICER]));
    assert_eq!(refusal(&result), code(ForgeError::NotAnAdmin));
    succeeded(&fixture.run(NOW, |f| f.delegate_now(OPERATOR, 0, &[OFFICER, ADMIN_A])));
    assert_eq!(fixture.delegation(), (wallet(OPERATOR), 0));
}

// ─── FR-035: a grant or a rotation takes the quorum ──────────────────────────

#[test]
fn a_grant_takes_the_quorum() {
    let mut fixture = Fixture::new(delegation::THAW_HOLDER);
    let result = fixture.run(NOW, |f| {
        f.delegate_now(OPERATOR, delegation::ALL, &[ADMIN_A])
    });
    assert_eq!(refusal(&result), code(ForgeError::QuorumNotReached));
    assert_eq!(
        fixture.delegation(),
        (wallet(OPERATOR), delegation::THAW_HOLDER)
    );

    succeeded(&fixture.run(NOW, |f| {
        f.delegate_now(OPERATOR, delegation::ALL, &[ADMIN_A, OFFICER])
    }));
    assert_eq!(fixture.delegation(), (wallet(OPERATOR), delegation::ALL));
}

#[test]
fn a_rotation_takes_the_quorum_even_to_an_empty_mask() {
    // The new key is a party the issuer has not trusted before; naming it is
    // a grant whatever it is given.
    let mut fixture = Fixture::new(delegation::ALL);
    let result = fixture.run(NOW, |f| f.delegate_now(SUCCESSOR, 0, &[ADMIN_A]));
    assert_eq!(refusal(&result), code(ForgeError::QuorumNotReached));

    succeeded(&fixture.run(NOW, |f| {
        f.delegate_now(SUCCESSOR, delegation::THAW_HOLDER, &[ADMIN_A, ADMIN_B])
    }));
    assert_eq!(
        fixture.delegation(),
        (wallet(SUCCESSOR), delegation::THAW_HOLDER)
    );
}

#[test]
fn the_key_never_becomes_a_member_even_by_quorum() {
    let mut fixture = Fixture::new(delegation::ALL);
    for member in [ADMIN_B, OFFICER, OBSERVER] {
        let result = fixture.run(NOW, |f| f.delegate_now(member, 0, &[ADMIN_A, ADMIN_B]));
        assert_eq!(
            refusal(&result),
            code(ForgeError::OperationalKeyIsAMember),
            "wallet {member}"
        );
    }
    assert_eq!(fixture.delegation(), (wallet(OPERATOR), delegation::ALL));
}

#[test]
fn a_power_outside_the_closed_list_is_refused_even_by_quorum() {
    let mut fixture = Fixture::new(0);
    for bit in 3..8 {
        let result = fixture.run(NOW, |f| {
            f.delegate_now(OPERATOR, 1 << bit, &[ADMIN_A, ADMIN_B])
        });
        assert_eq!(
            refusal(&result),
            code(ForgeError::UndelegatablePower),
            "bit {bit}"
        );
    }
    let result = fixture.run(NOW, |f| {
        build(
            issuer_forge::accounts::SetDelegation {
                issuer_config: f.issuer_config,
                proposal: None,
            },
            issuer_forge::instruction::SetDelegation {
                args: SetDelegationArgs {
                    operational_key: AnchorPubkey::default(),
                    mask: 0,
                },
            },
            signing(&[ADMIN_A, ADMIN_B]),
        )
    });
    assert_eq!(refusal(&result), code(ForgeError::MissingOperationalKey));
}

#[test]
fn a_change_that_changes_nothing_is_refused() {
    let mut fixture = Fixture::new(delegation::THAW_HOLDER);
    let result = fixture.run(NOW, |f| {
        f.delegate_now(OPERATOR, delegation::THAW_HOLDER, &[ADMIN_A])
    });
    assert_eq!(refusal(&result), code(ForgeError::DelegationUnchanged));
}

#[test]
fn an_unsigned_member_does_not_count() {
    let mut fixture = Fixture::new(delegation::ALL);
    let result = fixture.run(NOW, |f| {
        f.delegate(OPERATOR, 0, None, listed(&[wallet(ADMIN_A)]))
    });
    assert_eq!(refusal(&result), code(ForgeError::NotAnAuthorisingSigner));
}

// ─── The deferred path ───────────────────────────────────────────────────────

#[test]
fn a_grant_collected_across_days_executes_from_the_issuer_scope() {
    let mut fixture = Fixture::new(delegation::THAW_HOLDER);

    succeeded(&fixture.run(NOW, |f| f.propose(ADMIN_A, grant(delegation::ALL), false)));
    let raised = fixture.proposal_state(&fixture.issuer_proposal);
    assert_eq!(
        raised.scope, fixture.issuer_config,
        "no mint: the issuer is the scope"
    );
    assert_eq!(
        raised.action,
        ActionKind::SetDelegation {
            previous_key: wallet(OPERATOR),
            previous_mask: delegation::THAW_HOLDER,
            operational_key: wallet(OPERATOR),
            mask: delegation::ALL,
        },
        "the starting point is read by the program, not given by the proposer"
    );
    assert_eq!(
        fixture.delegation().1,
        delegation::THAW_HOLDER,
        "no effect yet"
    );

    succeeded(&fixture.run(NOW + DAY, |f| f.approve(f.issuer_proposal, OFFICER)));

    let executed_at = NOW + 2 * DAY;
    succeeded(&fixture.run(executed_at, |f| {
        f.delegate_from(f.issuer_proposal, OPERATOR, delegation::ALL)
    }));
    assert_eq!(fixture.delegation(), (wallet(OPERATOR), delegation::ALL));
    assert_eq!(
        fixture.proposal_state(&fixture.issuer_proposal).executed_at,
        executed_at
    );

    let again = fixture.run(executed_at + 1, |f| {
        f.delegate_from(f.issuer_proposal, OPERATOR, delegation::ALL)
    });
    assert_eq!(refusal(&again), code(ForgeError::DelegationUnchanged));
}

#[test]
fn one_signature_out_of_two_grants_nothing() {
    let mut fixture = Fixture::new(delegation::THAW_HOLDER);
    succeeded(&fixture.run(NOW, |f| f.propose(ADMIN_A, grant(delegation::ALL), false)));
    let result = fixture.run(NOW + DAY, |f| {
        f.delegate_from(f.issuer_proposal, OPERATOR, delegation::ALL)
    });
    assert_eq!(refusal(&result), code(ForgeError::QuorumNotReached));
    assert_eq!(fixture.delegation().1, delegation::THAW_HOLDER);
}

#[test]
fn a_revocation_in_between_stops_a_grant_already_approved() {
    // The case the stored starting point exists for: a key leaks while a
    // grant to it is circulating. The admin revokes at once; the grant,
    // fully approved, must not hand everything back.
    let mut fixture = Fixture::new(delegation::THAW_HOLDER);
    succeeded(&fixture.run(NOW, |f| f.propose(ADMIN_A, grant(delegation::ALL), false)));
    succeeded(&fixture.run(NOW + DAY, |f| f.approve(f.issuer_proposal, ADMIN_B)));

    succeeded(&fixture.run(NOW + DAY + 60, |f| {
        f.delegate_now(OPERATOR, 0, &[OFFICER, ADMIN_A])
    }));

    let result = fixture.run(NOW + 2 * DAY, |f| {
        f.delegate_from(f.issuer_proposal, OPERATOR, delegation::ALL)
    });
    assert_eq!(
        refusal(&result),
        code(ForgeError::DelegationChangedSinceProposal)
    );
    assert_eq!(fixture.delegation(), (wallet(OPERATOR), 0));
}

#[test]
fn execution_is_bound_to_the_approved_target() {
    let mut fixture = Fixture::new(delegation::THAW_HOLDER);
    succeeded(&fixture.run(NOW, |f| {
        f.propose(
            ADMIN_A,
            grant(delegation::THAW_HOLDER | delegation::SET_HOLDER_STATUS),
            false,
        )
    }));
    succeeded(&fixture.run(NOW + DAY, |f| f.approve(f.issuer_proposal, ADMIN_B)));

    for (key, mask) in [
        (OPERATOR, delegation::ALL),
        (
            SUCCESSOR,
            delegation::THAW_HOLDER | delegation::SET_HOLDER_STATUS,
        ),
    ] {
        let result = fixture.run(NOW + 2 * DAY, |f| {
            f.delegate_from(f.issuer_proposal, key, mask)
        });
        assert_eq!(
            refusal(&result),
            code(ForgeError::ProposalBodyMismatch),
            "key {key}, mask {mask}"
        );
    }
    assert_eq!(fixture.delegation().1, delegation::THAW_HOLDER);
}

#[test]
fn the_deferred_path_names_exactly_the_approvers_the_proposal_holds() {
    let mut fixture = Fixture::new(delegation::THAW_HOLDER);
    succeeded(&fixture.run(NOW, |f| f.propose(ADMIN_A, grant(delegation::ALL), false)));
    succeeded(&fixture.run(NOW + DAY, |f| f.approve(f.issuer_proposal, ADMIN_B)));

    for list in [
        vec![wallet(ADMIN_A)],
        vec![wallet(ADMIN_B), wallet(ADMIN_A)],
        vec![wallet(ADMIN_A), wallet(ADMIN_B), wallet(OFFICER)],
    ] {
        let result = fixture.run(NOW + 2 * DAY, |f| {
            f.delegate(
                OPERATOR,
                delegation::ALL,
                Some(f.issuer_proposal),
                listed(&list),
            )
        });
        assert_eq!(refusal(&result), code(ForgeError::ApproversNotListed));
    }
}

// ─── Scope ───────────────────────────────────────────────────────────────────

#[test]
fn an_action_is_raised_only_under_its_own_scope() {
    let mut fixture = Fixture::new(delegation::THAW_HOLDER);
    let result = fixture.run(NOW, |f| f.propose(ADMIN_A, grant(delegation::ALL), true));
    assert_eq!(refusal(&result), code(ForgeError::ProposalScopeMismatch));
    let result = fixture.run(NOW, |f| {
        f.propose(ADMIN_A, ProposedAction::Pause { reason: reason() }, false)
    });
    assert_eq!(refusal(&result), code(ForgeError::ProposalScopeMismatch));
}

#[test]
fn a_token_proposal_does_not_execute_as_a_delegation_change() {
    // A matured pause, at the token's scope, handed to `set_delegation`.
    let mut fixture = Fixture::new(delegation::THAW_HOLDER);
    succeeded(&fixture.run(NOW, |f| {
        f.propose(ADMIN_A, ProposedAction::Pause { reason: reason() }, true)
    }));
    succeeded(&fixture.run(NOW + DAY, |f| f.approve(f.token_proposal, ADMIN_B)));
    let result = fixture.run(NOW + 2 * DAY, |f| {
        f.delegate_from(f.token_proposal, OPERATOR, delegation::ALL)
    });
    assert_eq!(refusal(&result), code(ForgeError::ProposalScopeMismatch));
    assert_eq!(fixture.delegation().1, delegation::THAW_HOLDER);
    // And `mint` was never written: the token scope is the mint itself.
    assert_eq!(
        fixture.proposal_state(&fixture.token_proposal).scope,
        fixture.mint
    );
}
