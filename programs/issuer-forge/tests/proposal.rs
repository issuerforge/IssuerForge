//! The proposal lifecycle at runtime (T025, FR-019, FR-019a, FR-019b).
//!
//! **What this covers and the unit tests cannot.** `state/proposal.rs` and
//! `quorum.rs` test pure functions: whether a term has run out, whether a
//! wallet is already in the list, whether a threshold is met. None of them
//! can say that the accounts are wired together — that `propose_action`
//! writes the account `set_policy` later reads, that an optional account
//! reaches the program the way Anchor's client builds it, that the rent goes
//! back to the payer, and that at the end of a quorum collected on two
//! different days a policy version actually exists on chain. That is the gap
//! this file closes, and it is the first runtime harness in the repository.
//!
//! **`cargo test` does not rebuild the bytecode.** Mollusk loads
//! `target/deploy/issuer_forge.so`, so what runs here is the artifact of the
//! last `anchor build` and not necessarily the source beside it. A stale
//! artifact would make this file assert about a program nobody is running any
//! more, so the harness names the artifact it loaded and fails with an
//! instruction rather than a missing-file panic.
//!
//! **No token program is involved.** Neither `propose_action` nor
//! `set_policy` takes the mint: the token is named through `TokenConfig`,
//! whose seeds carry it. So the harness needs no Token-2022 ELF and no mint
//! account — only the two configuration accounts, which are written here
//! directly because the instructions that create them (T006, T018) are not
//! what is under test.
//!
//! **Two `Pubkey` types.** Mollusk lives on the agave 4.x crates and
//! anchor-lang 0.32.1 on solana-program 2.3; the bridge is `to_bytes()`, as
//! `Cargo.toml` says. Everything below that reads as a key of "our" program
//! is the anchor one, and `sol()` converts at the boundary.
use std::path::PathBuf;
use std::sync::Once;

use anchor_lang::prelude::Pubkey as AnchorPubkey;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use issuer_forge::constants::{
    ISSUER_SEED, MAX_MEMBERS, POLICY_SEED, PROPOSAL_SEED, TOKEN_SEED,
};
use issuer_forge::error::ForgeError;
use issuer_forge::instructions::{ProposeActionArgs, SetPolicyArgs};
use issuer_forge::rules::layout::{rule_kind, status_source, RULES_BYTES, RULE_SLOT_BYTES};
use issuer_forge::state::{
    role, ActionKind, ActionProposal, IssuerConfig, Member, PolicyConfig, ProposedAction,
    TokenConfig,
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
const OUTSIDER: u8 = 15;
const PAYER: u8 = 16;

/// A round unix timestamp well past the epoch. Zero would be indistinguishable
/// from `executed_at`'s "not executed" sentinel.
const NOW: i64 = 1_800_000_000;
const DAY: i64 = 24 * 60 * 60;
const TERM: i64 = 7 * DAY;
const NONCE: u64 = 42;
/// The version `create_token` wrote; the proposal is about the next one.
const CURRENT_VERSION: u32 = 1;
const NEXT_VERSION: u32 = 2;

const SOL: u64 = 1_000_000_000;

fn wallet(seed: u8) -> AnchorPubkey {
    AnchorPubkey::new_from_array([seed; 32])
}

fn sol(key: &AnchorPubkey) -> Pubkey {
    Pubkey::new_from_array(key.to_bytes())
}

// ─── Loading the program ─────────────────────────────────────────────────────

static ARTIFACT: Once = Once::new();

/// Points mollusk at the workspace's `target/deploy` and checks the artifact
/// is there.
///
/// Mollusk searches `tests/fixtures`, `$SBF_OUT_DIR` and the current
/// directory — and the current directory under `cargo test` is the package,
/// not the workspace, so without this the ELF is simply not found. Setting it
/// here rather than expecting it in the environment keeps `cargo test
/// -p issuer-forge` a complete instruction.
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

// ─── Accounts ────────────────────────────────────────────────────────────────

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

/// An address the program is about to create. It must be in the list and it
/// must be empty: `init` refuses an account that already holds something.
fn uninitialised() -> Account {
    funded(0)
}

/// The canonical minimum a policy must carry: the status rule in slot zero.
///
/// `tier` is what varies between the two bodies the mismatch test needs — a
/// change the model accepts, so the refusal can only come from the digest and
/// not from the layout check.
fn rules(tier: u8) -> Vec<u8> {
    let mut bytes = vec![0u8; RULES_BYTES];
    bytes[0] = rule_kind::STATUS;
    // Byte 2 is `params[0]`, the source mask: the issuer's own register only.
    // A policy that accepts provider attestations must also name their
    // validity period (FR-008a2), which this fixture has no use for.
    bytes[2] = status_source::REGISTER;
    // `params[1]` is the minimum verification tier.
    bytes[3] = tier;
    bytes
}

struct Fixture {
    mollusk: Mollusk,
    accounts: Vec<(Pubkey, Account)>,
    mint: AnchorPubkey,
    issuer_config: AnchorPubkey,
    token_config: AnchorPubkey,
    proposal: AnchorPubkey,
    policy_config: AnchorPubkey,
}

impl Fixture {
    fn new() -> Self {
        locate_artifact();

        let program_id = issuer_forge::ID;
        let issuer_id = wallet(99);
        let mint = wallet(98);

        let (issuer_config, issuer_bump) =
            AnchorPubkey::find_program_address(&[ISSUER_SEED, issuer_id.as_ref()], &program_id);
        let (token_config, token_bump) =
            AnchorPubkey::find_program_address(&[TOKEN_SEED, mint.as_ref()], &program_id);
        let (proposal, _) = AnchorPubkey::find_program_address(
            &[PROPOSAL_SEED, mint.as_ref(), &NONCE.to_le_bytes()],
            &program_id,
        );
        let (policy_config, _) = AnchorPubkey::find_program_address(
            &[POLICY_SEED, mint.as_ref(), &NEXT_VERSION.to_le_bytes()],
            &program_id,
        );

        let mut members = [Member::default(); MAX_MEMBERS];
        members[0] = Member {
            wallet: wallet(ADMIN_A),
            roles: role::ADMIN,
        };
        members[1] = Member {
            wallet: wallet(ADMIN_B),
            roles: role::ADMIN,
        };
        members[2] = Member {
            wallet: wallet(OFFICER),
            roles: role::COMPLIANCE,
        };
        members[3] = Member {
            wallet: wallet(OBSERVER),
            roles: role::OBSERVER,
        };

        let issuer = IssuerConfig {
            issuer_id,
            members,
            member_slots: 4,
            quorum_n: 2,
            operational_key: wallet(90),
            delegation_mask: 0,
            bump: issuer_bump,
            token_count: 1,
        };

        let token = TokenConfig {
            issuer: issuer_config,
            mint,
            attestation_credential: wallet(91),
            attestation_schema: wallet(92),
            attestor: wallet(93),
            treasury: wallet(94),
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
            (sol(&proposal), uninitialised()),
            (sol(&policy_config), uninitialised()),
            (sol(&wallet(PAYER)), funded(100 * SOL)),
        ];
        for seed in [ADMIN_A, ADMIN_B, OFFICER, OBSERVER, OUTSIDER] {
            accounts.push((sol(&wallet(seed)), funded(SOL)));
        }
        accounts.push(mollusk_svm::program::keyed_account_for_system_program());

        Self {
            mollusk,
            accounts,
            mint,
            issuer_config,
            token_config,
            proposal,
            policy_config,
        }
    }

    /// Sets the clock, builds the instruction against the current state and
    /// runs it, carrying the resulting accounts forward.
    ///
    /// Not `process_instruction_chain`: that shares one sysvar cache across
    /// the whole chain, and the point of a deferred quorum is that the clock
    /// moves between the steps. The instruction arrives as a closure because
    /// building it reads the fixture while running it writes to it.
    fn run(
        &mut self,
        now: i64,
        make: impl FnOnce(&Self) -> Instruction,
    ) -> InstructionResult {
        self.mollusk.sysvars.clock.unix_timestamp = now;
        let instruction = make(self);
        let result = self.mollusk.process_instruction(&instruction, &self.accounts);
        if result.program_result.is_ok() {
            // `resulting_accounts` maps one to one over what was passed, in
            // order, so the whole store is replaced rather than merged.
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

    fn proposal_state(&self) -> ActionProposal {
        let data = &self.account(&self.proposal).data;
        ActionProposal::try_deserialize(&mut &data[..]).expect("a proposal the program wrote")
    }

    fn token_state(&self) -> TokenConfig {
        let data = &self.account(&self.token_config).data;
        TokenConfig::try_deserialize(&mut &data[..]).expect("a token config")
    }

    fn policy_state(&self) -> PolicyConfig {
        let data = &self.account(&self.policy_config).data;
        // `zero_copy`, so it is read the way the hook reads it: a cast, not a
        // Borsh deserialisation.
        *bytemuck::from_bytes::<PolicyConfig>(&data[8..8 + std::mem::size_of::<PolicyConfig>()])
    }

    // ─── The instructions under test ─────────────────────────────────────────

    fn propose(&self, proposer: u8, version: u32, body: Vec<u8>) -> Instruction {
        build(
            issuer_forge::accounts::ProposeAction {
                issuer_config: self.issuer_config,
                token_config: self.token_config,
                proposal: self.proposal,
                payer: wallet(PAYER),
                proposer: wallet(proposer),
                system_program: anchor_lang::system_program::ID,
            },
            issuer_forge::instruction::ProposeAction {
                args: ProposeActionArgs {
                    nonce: NONCE,
                    term_seconds: TERM,
                    action: ProposedAction::SetPolicy {
                        version,
                        rules: body,
                    },
                },
            },
            &[],
        )
    }

    fn approve(&self, approver: u8) -> Instruction {
        build(
            issuer_forge::accounts::ApproveAction {
                issuer_config: self.issuer_config,
                proposal: self.proposal,
                approver: wallet(approver),
            },
            issuer_forge::instruction::ApproveAction {},
            &[],
        )
    }

    /// `set_policy` on the deferred path, optionally with live co-signers
    /// appended — which the program must refuse (`QuorumSourceAmbiguous`).
    fn execute(&self, body: Vec<u8>, extra_signers: &[u8]) -> Instruction {
        build(
            issuer_forge::accounts::SetPolicy {
                issuer_config: self.issuer_config,
                token_config: self.token_config,
                policy_config: self.policy_config,
                payer: wallet(PAYER),
                system_program: anchor_lang::system_program::ID,
                proposal: Some(self.proposal),
            },
            issuer_forge::instruction::SetPolicy {
                args: SetPolicyArgs {
                    version: NEXT_VERSION,
                    rules: body,
                },
            },
            extra_signers,
        )
    }

    /// `set_policy` on the immediate path, for the comparison that the two
    /// paths end in the same state.
    fn execute_now(&self, body: Vec<u8>, signers: &[u8]) -> Instruction {
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
                    rules: body,
                },
            },
            signers,
        )
    }

    fn close(&self, member: u8) -> Instruction {
        build(
            issuer_forge::accounts::CloseActionProposal {
                issuer_config: self.issuer_config,
                proposal: self.proposal,
                rent_recipient: wallet(PAYER),
                member: wallet(member),
            },
            issuer_forge::instruction::CloseActionProposal {},
            &[],
        )
    }
}

/// Anchor's account metas carry the 2.3 `AccountMeta`; mollusk wants the 3.x
/// one. The same `to_bytes()` bridge, one layer up.
fn build<A: ToAccountMetas, D: InstructionData>(
    accounts: A,
    data: D,
    extra_signers: &[u8],
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
    for seed in extra_signers {
        metas.push(AccountMeta {
            pubkey: sol(&wallet(*seed)),
            is_signer: true,
            is_writable: false,
        });
    }
    Instruction {
        program_id: sol(&issuer_forge::ID),
        accounts: metas,
        data: data.data(),
    }
}

// ─── Reading a refusal ───────────────────────────────────────────────────────

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

// ─── The lifecycle ───────────────────────────────────────────────────────────

#[test]
fn a_quorum_collected_across_days_writes_the_policy_version() {
    // The whole of T025 in one run: three transactions, three different days,
    // one policy version at the end.
    let mut fixture = Fixture::new();
    let body = rules(2);

    let result = fixture.run(NOW, |f| f.propose(ADMIN_A, NEXT_VERSION, body.clone()));
    succeeded(&result);

    let raised = fixture.proposal_state();
    assert_eq!(raised.approvals(), &[wallet(ADMIN_A)], "the proposer signs first");
    assert_eq!(raised.created_at, NOW);
    assert_eq!(raised.expires_at, NOW + TERM);
    assert_eq!(raised.executed_at, 0);
    assert_eq!(raised.mint, fixture.mint);
    assert_eq!(
        raised.action,
        ActionKind::set_policy(NEXT_VERSION, &body).expect("a canonical body"),
        "the account keeps the digest the program computed, not the bytes"
    );
    assert_eq!(
        fixture.token_state().policy_version,
        CURRENT_VERSION,
        "a proposal has no on-chain effect (FR-019b)"
    );

    let result = fixture.run(NOW + 2 * DAY, |f| f.approve(ADMIN_B));
    succeeded(&result);
    assert_eq!(
        fixture.proposal_state().approvals(),
        &[wallet(ADMIN_A), wallet(ADMIN_B)],
        "signatures given two days apart sit in one account"
    );

    let executed_at = NOW + 3 * DAY;
    let result = fixture.run(executed_at, |f| f.execute(body.clone(), &[]));
    succeeded(&result);

    assert_eq!(fixture.token_state().policy_version, NEXT_VERSION);
    let policy = fixture.policy_state();
    assert_eq!(policy.version, NEXT_VERSION);
    assert_eq!(policy.mint, fixture.mint);
    assert_eq!(policy.activated_at, executed_at);
    assert_eq!(
        policy.author,
        wallet(ADMIN_A),
        "the author is the first of the collected quorum — the proposer"
    );
    assert_eq!(
        fixture.proposal_state().executed_at,
        executed_at,
        "the proposal is spent, not merely satisfied"
    );
}

#[test]
fn one_signature_out_of_two_has_no_on_chain_effect() {
    // SC-013 at runtime, and the literal reading of FR-019b: the proposal
    // exists, it is readable, and the token has not moved.
    let mut fixture = Fixture::new();
    let body = rules(2);

    succeeded(&fixture.run(NOW, |f| f.propose(ADMIN_A, NEXT_VERSION, body.clone())));

    let result = fixture.run(NOW + DAY, |f| f.execute(body, &[]));
    assert_eq!(refusal(&result), code(ForgeError::QuorumNotReached));
    assert_eq!(fixture.token_state().policy_version, CURRENT_VERSION);
    assert!(
        fixture.account(&fixture.policy_config).data.is_empty(),
        "the refused version must not exist at its address"
    );
}

#[test]
fn a_proposal_past_its_term_no_longer_executes() {
    // Revocation is the passage of the term, and it binds a proposal that has
    // already reached its quorum — otherwise the term would only mean "no new
    // signatures".
    let mut fixture = Fixture::new();
    let body = rules(2);

    succeeded(&fixture.run(NOW, |f| f.propose(ADMIN_A, NEXT_VERSION, body.clone())));
    succeeded(&fixture.run(NOW + DAY, |f| f.approve(ADMIN_B)));

    let result = fixture.run(NOW + TERM + 1, |f| f.execute(body.clone(), &[]));
    assert_eq!(refusal(&result), code(ForgeError::ProposalExpired));
    assert_eq!(fixture.token_state().policy_version, CURRENT_VERSION);

    // And one second earlier it still runs, so the refusal above is the term
    // and not something else about the fixture.
    let result = fixture.run(NOW + TERM, |f| f.execute(body, &[]));
    succeeded(&result);
    assert_eq!(fixture.token_state().policy_version, NEXT_VERSION);
}

#[test]
fn execution_is_bound_to_the_rules_that_were_approved() {
    // The digest is the whole reason the proposal can hold 32 bytes instead
    // of 384: a body the approvers never saw cannot be substituted at the
    // last step.
    let mut fixture = Fixture::new();
    let approved = rules(2);
    let substituted = rules(3);

    succeeded(&fixture.run(NOW, |f| f.propose(ADMIN_A, NEXT_VERSION, approved.clone())));
    succeeded(&fixture.run(NOW + DAY, |f| f.approve(ADMIN_B)));

    let result = fixture.run(NOW + 2 * DAY, |f| f.execute(substituted, &[]));
    assert_eq!(refusal(&result), code(ForgeError::ProposalBodyMismatch));
    assert_eq!(fixture.token_state().policy_version, CURRENT_VERSION);

    succeeded(&fixture.run(NOW + 2 * DAY, |f| f.execute(approved, &[])));
    assert_eq!(fixture.token_state().policy_version, NEXT_VERSION);
}

#[test]
fn the_two_sources_of_a_quorum_are_never_combined() {
    // A proposal one signature short plus a live co-signer would be two lists
    // of who authorised the action.
    let mut fixture = Fixture::new();
    let body = rules(2);

    succeeded(&fixture.run(NOW, |f| f.propose(ADMIN_A, NEXT_VERSION, body.clone())));

    let result = fixture.run(NOW + DAY, |f| f.execute(body, &[ADMIN_B]));
    assert_eq!(refusal(&result), code(ForgeError::QuorumSourceAmbiguous));
    assert_eq!(fixture.token_state().policy_version, CURRENT_VERSION);
}

#[test]
fn the_immediate_path_still_ends_where_it_did() {
    // T025 added a branch to an instruction that already worked. This is the
    // branch that existed before, run through the same harness: same version,
    // same author, and no proposal account touched.
    let mut fixture = Fixture::new();
    let body = rules(2);

    let result = fixture.run(NOW, |f| f.execute_now(body, &[ADMIN_A, ADMIN_B]));
    succeeded(&result);

    assert_eq!(fixture.token_state().policy_version, NEXT_VERSION);
    assert_eq!(fixture.policy_state().author, wallet(ADMIN_A));
    assert!(
        fixture.account(&fixture.proposal).data.is_empty(),
        "the immediate path creates no proposal"
    );
}

#[test]
fn only_a_member_who_may_authorise_takes_part() {
    let mut fixture = Fixture::new();
    let body = rules(2);

    // An observer cannot raise a proposal: it is a claim about what the
    // issuer intends, and making it is the same right as signing it.
    let result = fixture.run(NOW, |f| f.propose(OBSERVER, NEXT_VERSION, body.clone()));
    assert_eq!(refusal(&result), code(ForgeError::NotAnAuthorisingSigner));

    succeeded(&fixture.run(NOW, |f| f.propose(ADMIN_A, NEXT_VERSION, body)));

    let result = fixture.run(NOW + DAY, |f| f.approve(OUTSIDER));
    assert_eq!(refusal(&result), code(ForgeError::NotAnAuthorisingSigner));

    let result = fixture.run(NOW + DAY, |f| f.approve(ADMIN_A));
    assert_eq!(
        refusal(&result),
        code(ForgeError::DuplicateApproval),
        "one wallet must not fill the quorum twice"
    );

    // A compliance officer does fill it — FR-033 gives the role the right to
    // authorise, and the quorum is not an admins-only club.
    succeeded(&fixture.run(NOW + DAY, |f| f.approve(OFFICER)));
    assert_eq!(fixture.proposal_state().approvals().len(), 2);
}

#[test]
fn the_rent_goes_back_to_whoever_paid_it_and_only_when_it_is_over() {
    let mut fixture = Fixture::new();
    let body = rules(2);

    succeeded(&fixture.run(NOW, |f| f.propose(ADMIN_A, NEXT_VERSION, body.clone())));
    let rent = fixture.account(&fixture.proposal).lamports;
    assert!(rent > 0, "the proposal is rent-exempt after propose");

    // Live and unexecuted: closing it would be a revocation the term owns.
    let result = fixture.run(NOW + DAY, |f| f.close(ADMIN_B));
    assert_eq!(refusal(&result), code(ForgeError::ProposalStillLive));

    succeeded(&fixture.run(NOW + DAY, |f| f.approve(ADMIN_B)));
    succeeded(&fixture.run(NOW + 2 * DAY, |f| f.execute(body, &[])));

    // Measured immediately before the close, not before the propose: the same
    // payer also funded the new `PolicyConfig` in between, and a balance
    // taken earlier would net two unrelated rents against each other.
    let before_close = fixture.account(&wallet(PAYER)).lamports;
    let closer_before = fixture.account(&wallet(ADMIN_B)).lamports;

    succeeded(&fixture.run(NOW + 3 * DAY, |f| f.close(ADMIN_B)));
    assert!(
        fixture.account(&fixture.proposal).data.is_empty(),
        "the account is gone once the action is over"
    );
    assert_eq!(
        fixture.account(&wallet(PAYER)).lamports,
        before_close + rent,
        "closing returns the rent to the payer"
    );
    assert_eq!(
        fixture.account(&wallet(ADMIN_B)).lamports,
        closer_before,
        "and not to whoever closed it"
    );
}

#[test]
fn a_lapsed_proposal_can_be_closed_without_ever_having_run() {
    // The other half of the term: nothing happened, and the rent still comes
    // back.
    let mut fixture = Fixture::new();

    succeeded(&fixture.run(NOW, |f| f.propose(ADMIN_A, NEXT_VERSION, rules(2))));
    let rent = fixture.account(&fixture.proposal).lamports;
    let before_close = fixture.account(&wallet(PAYER)).lamports;

    succeeded(&fixture.run(NOW + TERM + 1, |f| f.close(OFFICER)));
    assert!(fixture.account(&fixture.proposal).data.is_empty());
    assert_eq!(fixture.account(&wallet(PAYER)).lamports, before_close + rent);
    assert_eq!(
        fixture.token_state().policy_version,
        CURRENT_VERSION,
        "a lapsed proposal leaves no trace on the token"
    );
}

/// The rule slot width is part of what `rules()` above assumes; if it ever
/// changes, that helper writes into the wrong byte and every test here would
/// still pass while testing the wrong policy.
#[test]
fn the_fixture_writes_into_the_slot_it_thinks_it_does() {
    assert_eq!(RULE_SLOT_BYTES, 24);
    assert_ne!(rules(2), rules(3));
    assert!(ActionKind::set_policy(NEXT_VERSION, &rules(3)).is_ok());
}
