//! Pausing circulation at runtime (T028, FR-016, FR-017, FR-019).
//!
//! **What this covers and the unit tests cannot.** `state/proposal.rs` tests
//! what a pause proposal must carry. It cannot say that the token program
//! stops transfers when this program sets the flag, that they pass again
//! when it is lifted without a single holder doing anything, or that the
//! flag the program reads is the one the token program writes. Those are
//! FR-016, and this file runs them against the real Token-2022 program.
//!
//! **A Token-2022 mint with `Pausable` and without the hook.** The token
//! program refuses a paused mint's transfer before it would call a hook — the
//! same reason `tests/freeze.rs` does without one. The pause under the
//! production mint, hook and delegate included, is proved where it matters
//! most, by the seizure that has to go through it (`tests/seize.rs`).
//!
//! **`cargo test` does not rebuild the bytecode** — see `tests/proposal.rs`;
//! the same guard applies here.
//!
//! **Two `Pubkey` types.** The same bridge as in `tests/proposal.rs`: anchor's
//! keys on the program side, mollusk's at the boundary, `to_bytes()` between.
use std::path::PathBuf;
use std::sync::Once;

use anchor_lang::prelude::Pubkey as AnchorPubkey;
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::token_2022::spl_token_2022::extension::pausable::{self, PausableConfig};
use anchor_spl::token_2022::spl_token_2022::extension::{
    BaseStateWithExtensions, ExtensionType, StateWithExtensions, StateWithExtensionsMut,
};
use anchor_spl::token_2022::spl_token_2022::state::{
    Account as TokenAccountState, AccountState, Mint as MintState,
};
use issuer_forge::constants::{ISSUER_SEED, MAX_MEMBERS, PROPOSAL_SEED, TOKEN_SEED};
use issuer_forge::error::ForgeError;
use issuer_forge::instructions::{CirculationArgs, ProposeActionArgs};
use issuer_forge::state::{
    case_ref_bytes, delegation, role, ActionProposal, ComplianceReason, IssuerConfig, Member,
    ProposedAction, TokenConfig,
};
use mollusk_svm::result::{InstructionResult, ProgramResult};
use mollusk_svm::Mollusk;
use mollusk_svm_programs_token::token2022;
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
const OPERATOR: u8 = 90;

/// Two ordinary holders, thawed and funded.
const ALICE: u8 = 21;
const BOB: u8 = 22;

const NOW: i64 = 1_800_000_000;
const DAY: i64 = 24 * 60 * 60;
const TERM: i64 = 7 * DAY;
const DECIMALS: u8 = 6;
const BALANCE: u64 = 500_000_000;
const SOL: u64 = 1_000_000_000;

const NONCES: [u64; 4] = [1, 2, 3, 4];

/// Token-2022's `TokenError::MintPaused`.
const MINT_PAUSED: u32 = 67;

fn wallet(seed: u8) -> AnchorPubkey {
    AnchorPubkey::new_from_array([seed; 32])
}

fn token_account_of(seed: u8) -> AnchorPubkey {
    AnchorPubkey::new_from_array([seed + 100; 32])
}

fn sol(key: &AnchorPubkey) -> Pubkey {
    Pubkey::new_from_array(key.to_bytes())
}

fn reason(code: u16, case: &[u8]) -> ComplianceReason {
    ComplianceReason {
        code,
        case_ref: case_ref_bytes(case),
    }
}

fn a_reason() -> ComplianceReason {
    reason(9, b"INC-2026-0412")
}

// ─── Loading the programs ────────────────────────────────────────────────────

static ARTIFACT: Once = Once::new();

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

fn token_account(owner: u8, mint: AnchorPubkey, amount: u64) -> Account {
    let mut data = vec![0u8; TokenAccountState::LEN];
    TokenAccountState::pack(
        TokenAccountState {
            mint,
            owner: wallet(owner),
            amount,
            delegate: COption::None,
            state: AccountState::Initialized,
            is_native: COption::None,
            delegated_amount: 0,
            close_authority: COption::None,
        },
        &mut data,
    )
    .expect("a packable token account");
    Account {
        lamports: SOL,
        data,
        owner: token2022::ID,
        executable: false,
        rent_epoch: 0,
    }
}

fn bridge(metas: &[anchor_lang::solana_program::instruction::AccountMeta]) -> Vec<AccountMeta> {
    metas
        .iter()
        .map(|meta| AccountMeta {
            pubkey: sol(&meta.pubkey),
            is_signer: meta.is_signer,
            is_writable: meta.is_writable,
        })
        .collect()
}

fn bridged(instruction: anchor_lang::solana_program::instruction::Instruction) -> Instruction {
    Instruction {
        program_id: sol(&instruction.program_id),
        accounts: bridge(&instruction.accounts),
        data: instruction.data,
    }
}

struct Fixture {
    mollusk: Mollusk,
    accounts: Vec<(Pubkey, Account)>,
    mint: AnchorPubkey,
    issuer_config: AnchorPubkey,
    token_config: AnchorPubkey,
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
            // Everything the operational key can ever hold; a pause stays out
            // of its reach even so.
            delegation_mask: delegation::ALL,
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
            policy_version: 1,
            fee_bps: 0,
            attestation_max_age: 30 * 86_400,
            paused_at: 0,
            bump: token_bump,
            attestation_count: 1,
            reserve_currency: issuer_forge::state::currency_bytes(b"NGN"),
        };

        let mut mollusk = Mollusk::new(&sol(&program_id), "issuer_forge");
        token2022::add_program(&mut mollusk);
        mollusk.sysvars.clock.unix_timestamp = NOW;

        let mut accounts = vec![
            (sol(&issuer_config), stored(&issuer, SOL)),
            (sol(&token_config), stored(&token, SOL)),
            (
                sol(&mint),
                Self::mint_account(&mut mollusk, mint, token_config),
            ),
            (
                sol(&token_account_of(ALICE)),
                token_account(ALICE, mint, BALANCE),
            ),
            (
                sol(&token_account_of(BOB)),
                token_account(BOB, mint, BALANCE),
            ),
            (sol(&wallet(PAYER)), funded(100 * SOL)),
        ];
        for nonce in NONCES {
            accounts.push((sol(&proposal_of(mint, nonce)), funded(0)));
        }
        for seed in [ADMIN_A, ADMIN_B, OFFICER, OBSERVER, OPERATOR, ALICE, BOB] {
            accounts.push((sol(&wallet(seed)), funded(SOL)));
        }
        accounts.push(mollusk_svm::program::keyed_account_for_system_program());
        accounts.push(token2022::keyed_account());

        Self {
            mollusk,
            accounts,
            mint,
            issuer_config,
            token_config,
        }
    }

    /// A mint whose pause authority is the `TokenConfig` PDA, as
    /// `create_token` sets it, built by the token program's own initialisers.
    fn mint_account(mollusk: &mut Mollusk, mint: AnchorPubkey, authority: AnchorPubkey) -> Account {
        let token_program = spl_token_2022::ID;
        let len = ExtensionType::try_calculate_account_len::<MintState>(&[ExtensionType::Pausable])
            .expect("a mint length");
        let mut account = Account {
            lamports: SOL,
            data: vec![0u8; len],
            owner: token2022::ID,
            executable: false,
            rent_epoch: 0,
        };
        let steps = [
            pausable::instruction::initialize(&token_program, &mint, &authority),
            spl_token_2022::instruction::initialize_mint2(
                &token_program,
                &mint,
                &authority,
                Some(&authority),
                DECIMALS,
            ),
        ];
        for step in steps {
            let instruction = bridged(step.expect("a token-2022 initialiser"));
            let result = mollusk.process_instruction(
                &instruction,
                &[(sol(&mint), account.clone()), token2022::keyed_account()],
            );
            assert_eq!(
                result.program_result,
                ProgramResult::Success,
                "mint initialiser failed"
            );
            account = result.get_account(&sol(&mint)).expect("the mint").clone();
        }

        let mut state =
            StateWithExtensionsMut::<MintState>::unpack(&mut account.data).expect("a mint");
        state.base.supply = 2 * BALANCE;
        state.pack_base();
        account
    }

    fn run(&mut self, now: i64, instruction: Instruction) -> InstructionResult {
        self.mollusk.sysvars.clock.unix_timestamp = now;
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

    fn balance(&self, holder: u8) -> u64 {
        StateWithExtensions::<TokenAccountState>::unpack(
            &self.account(&token_account_of(holder)).data,
        )
        .expect("a token account")
        .base
        .amount
    }

    /// The flag as the token program keeps it — the authoritative one.
    fn mint_paused(&self) -> bool {
        let data = &self.account(&self.mint).data;
        let mint = StateWithExtensions::<MintState>::unpack(data).expect("a mint");
        bool::from(
            mint.get_extension::<PausableConfig>()
                .expect("the pausable extension")
                .paused,
        )
    }

    /// The mirror in `TokenConfig`.
    fn paused_at(&self) -> i64 {
        let data = &self.account(&self.token_config).data;
        TokenConfig::try_deserialize(&mut &data[..])
            .expect("the token config")
            .paused_at
    }

    fn proposal_state(&self, nonce: u64) -> ActionProposal {
        let data = &self.account(&proposal_of(self.mint, nonce)).data;
        ActionProposal::try_deserialize(&mut &data[..]).expect("a proposal the program wrote")
    }

    fn approvers(&self, nonce: u64) -> Vec<AnchorPubkey> {
        if self.account(&proposal_of(self.mint, nonce)).data.is_empty() {
            return Vec::new();
        }
        self.proposal_state(nonce).approvals().to_vec()
    }

    // ─── The instructions under test ─────────────────────────────────────────

    fn propose(&self, nonce: u64, proposer: u8, action: ProposedAction) -> Instruction {
        build(
            issuer_forge::accounts::ProposeAction {
                issuer_config: self.issuer_config,
                token_config: Some(self.token_config),
                proposal: proposal_of(self.mint, nonce),
                payer: wallet(PAYER),
                proposer: wallet(proposer),
                system_program: anchor_lang::system_program::ID,
            },
            issuer_forge::instruction::ProposeAction {
                args: ProposeActionArgs {
                    nonce,
                    term_seconds: TERM,
                    action,
                },
            },
        )
    }

    fn approve(&self, nonce: u64, approver: u8) -> Instruction {
        build(
            issuer_forge::accounts::ApproveAction {
                issuer_config: self.issuer_config,
                proposal: proposal_of(self.mint, nonce),
                approver: wallet(approver),
            },
            issuer_forge::instruction::ApproveAction {},
        )
    }

    fn change_accounts(&self, nonce: u64) -> issuer_forge::accounts::ChangeCirculation {
        issuer_forge::accounts::ChangeCirculation {
            issuer_config: self.issuer_config,
            token_config: self.token_config,
            mint: self.mint,
            proposal: proposal_of(self.mint, nonce),
            token_program: spl_token_2022::ID,
        }
    }

    fn listing(mut instruction: Instruction, approvers: &[AnchorPubkey]) -> Instruction {
        instruction.accounts.extend(
            approvers
                .iter()
                .map(|approver| AccountMeta::new_readonly(sol(approver), false)),
        );
        instruction
    }

    fn pause_listing(
        &self,
        nonce: u64,
        reason: ComplianceReason,
        approvers: &[AnchorPubkey],
    ) -> Instruction {
        Self::listing(
            build(
                self.change_accounts(nonce),
                issuer_forge::instruction::PauseCirculation {
                    args: CirculationArgs { reason },
                },
            ),
            approvers,
        )
    }

    fn pause_with(&self, nonce: u64, reason: ComplianceReason) -> Instruction {
        self.pause_listing(nonce, reason, &self.approvers(nonce))
    }

    fn pause(&self, nonce: u64) -> Instruction {
        self.pause_with(nonce, a_reason())
    }

    fn resume_with(&self, nonce: u64, reason: ComplianceReason) -> Instruction {
        Self::listing(
            build(
                self.change_accounts(nonce),
                issuer_forge::instruction::ResumeCirculation {
                    args: CirculationArgs { reason },
                },
            ),
            &self.approvers(nonce),
        )
    }

    fn resume(&self, nonce: u64) -> Instruction {
        self.resume_with(nonce, a_reason())
    }

    /// Propose and approve — a proposal that has reached its quorum.
    fn matured(&mut self, nonce: u64, action: ProposedAction) {
        succeeded(&self.run(NOW, self.propose(nonce, OFFICER, action)));
        succeeded(&self.run(NOW + DAY, self.approve(nonce, ADMIN_A)));
    }

    fn matured_pause(&mut self, nonce: u64) {
        self.matured(nonce, ProposedAction::Pause { reason: a_reason() });
    }

    fn matured_resume(&mut self, nonce: u64) {
        self.matured(nonce, ProposedAction::Resume { reason: a_reason() });
    }

    /// A transfer straight through the token program, signed by the owner.
    fn transfer(&self, from: u8, to: u8, amount: u64) -> Instruction {
        bridged(
            spl_token_2022::instruction::transfer_checked(
                &spl_token_2022::ID,
                &token_account_of(from),
                &self.mint,
                &token_account_of(to),
                &wallet(from),
                &[],
                amount,
                DECIMALS,
            )
            .expect("a transfer instruction"),
        )
    }
}

fn proposal_of(mint: AnchorPubkey, nonce: u64) -> AnchorPubkey {
    AnchorPubkey::find_program_address(
        &[PROPOSAL_SEED, mint.as_ref(), &nonce.to_le_bytes()],
        &issuer_forge::ID,
    )
    .0
}

fn build<A: ToAccountMetas, D: InstructionData>(accounts: A, data: D) -> Instruction {
    Instruction {
        program_id: sol(&issuer_forge::ID),
        accounts: bridge(&accounts.to_account_metas(None)),
        data: data.data(),
    }
}

// ─── Reading a result ────────────────────────────────────────────────────────

fn refusal(result: &InstructionResult) -> u32 {
    match &result.program_result {
        ProgramResult::Failure(ProgramError::Custom(code)) => *code,
        other => panic!("expected a refusal, got {other:?}"),
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

// ─── FR-016: the pause stops every transfer, and lifting it restores them ───

#[test]
fn a_quorum_pauses_and_every_transfer_stops() {
    let mut f = Fixture::new();
    // The control first: the same transfers pass before the pause, so the
    // refusal below is the pause and nothing else.
    succeeded(&f.run(NOW, f.transfer(ALICE, BOB, 1)));
    succeeded(&f.run(NOW, f.transfer(BOB, ALICE, 1)));

    f.matured_pause(1);
    succeeded(&f.run(NOW + DAY, f.pause(1)));

    assert!(f.mint_paused());
    assert_eq!(f.paused_at(), NOW + DAY);
    assert_eq!(f.proposal_state(1).executed_at, NOW + DAY);
    for (from, to) in [(ALICE, BOB), (BOB, ALICE)] {
        assert_eq!(
            refusal(&f.run(NOW + DAY, f.transfer(from, to, 1))),
            MINT_PAUSED
        );
    }
    assert_eq!((f.balance(ALICE), f.balance(BOB)), (BALANCE, BALANCE));
}

#[test]
fn lifting_the_pause_needs_nothing_from_the_holders() {
    // The acceptance scenario of US2: after the pause is lifted, transfers
    // pass "without additional actions of holders" — the accounts below are
    // the same accounts, untouched since the pause.
    let mut f = Fixture::new();
    f.matured_pause(1);
    succeeded(&f.run(NOW + DAY, f.pause(1)));

    f.matured_resume(2);
    succeeded(&f.run(NOW + 2 * DAY, f.resume(2)));

    assert!(!f.mint_paused());
    assert_eq!(f.paused_at(), 0);
    succeeded(&f.run(NOW + 2 * DAY, f.transfer(ALICE, BOB, 7)));
    assert_eq!(f.balance(BOB), BALANCE + 7);
}

// ─── FR-019: the quorum, and nobody outside it ──────────────────────────────

#[test]
fn one_signature_pauses_nothing() {
    let mut f = Fixture::new();
    succeeded(&f.run(
        NOW,
        f.propose(1, OFFICER, ProposedAction::Pause { reason: a_reason() }),
    ));
    assert_eq!(
        refusal(&f.run(NOW, f.pause(1))),
        code(ForgeError::QuorumNotReached)
    );
    assert!(!f.mint_paused());
    assert_eq!(f.proposal_state(1).executed_at, 0);
    succeeded(&f.run(NOW, f.transfer(ALICE, BOB, 1)));
}

#[test]
fn the_operational_key_and_an_observer_take_no_part() {
    // SC-012: the operational key holds every delegable power and still
    // cannot raise or approve a pause.
    let mut f = Fixture::new();
    for outsider in [OPERATOR, OBSERVER] {
        assert_eq!(
            refusal(&f.run(
                NOW,
                f.propose(1, outsider, ProposedAction::Pause { reason: a_reason() }),
            )),
            code(ForgeError::NotAnAuthorisingSigner)
        );
    }
    succeeded(&f.run(
        NOW,
        f.propose(1, OFFICER, ProposedAction::Pause { reason: a_reason() }),
    ));
    for outsider in [OPERATOR, OBSERVER] {
        assert_eq!(
            refusal(&f.run(NOW, f.approve(1, outsider))),
            code(ForgeError::NotAnAuthorisingSigner)
        );
    }
    assert!(!f.mint_paused());
}

#[test]
fn execution_is_bound_to_the_direction_and_the_case_approved() {
    let mut f = Fixture::new();
    f.matured_pause(1);

    // The same reason under the opposite instruction, and the same
    // instruction under another case.
    for attempt in [
        f.resume(1),
        f.pause_with(1, reason(9, b"INC-2026-0413")),
        f.pause_with(1, reason(10, b"INC-2026-0412")),
    ] {
        assert_eq!(
            refusal(&f.run(NOW + DAY, attempt)),
            code(ForgeError::ProposalBodyMismatch)
        );
    }
    assert!(!f.mint_paused());
    succeeded(&f.run(NOW + DAY, f.pause(1)));
}

#[test]
fn a_proposal_pauses_once_and_not_after_its_term() {
    let mut f = Fixture::new();
    f.matured_pause(1);
    succeeded(&f.run(NOW + DAY, f.pause(1)));
    f.matured_resume(2);
    succeeded(&f.run(NOW + DAY, f.resume(2)));
    // Spent: the same proposal does not pause a second time.
    assert_eq!(
        refusal(&f.run(NOW + DAY, f.pause(1))),
        code(ForgeError::ProposalAlreadyExecuted)
    );

    f.matured_pause(3);
    assert_eq!(
        refusal(&f.run(NOW + TERM + 1, f.pause(3))),
        code(ForgeError::ProposalExpired)
    );
    assert!(!f.mint_paused());
}

#[test]
fn a_seizure_proposal_cannot_be_spent_on_a_pause() {
    // Both are `ActionProposal`s; the stored kind is what tells them apart.
    let mut f = Fixture::new();
    f.matured(
        1,
        ProposedAction::Seize {
            token_account: token_account_of(ALICE),
            amount: 1,
            reason: a_reason(),
        },
    );
    assert_eq!(
        refusal(&f.run(NOW + DAY, f.pause(1))),
        code(ForgeError::ProposalBodyMismatch)
    );
    assert!(!f.mint_paused());
}

#[test]
fn the_instruction_names_exactly_the_approvers_the_proposal_holds() {
    // FR-019c, as for a seizure: the journal names who paused the token from
    // this instruction.
    let mut f = Fixture::new();
    f.matured_pause(1);
    let listed = f.approvers(1);
    assert_eq!(listed, vec![wallet(OFFICER), wallet(ADMIN_A)]);
    for wrong in [
        vec![],
        vec![listed[1], listed[0]],
        vec![listed[0], wallet(ADMIN_B)],
        vec![listed[0], listed[1], wallet(ADMIN_B)],
    ] {
        assert_eq!(
            refusal(&f.run(NOW + DAY, f.pause_listing(1, a_reason(), &wrong))),
            code(ForgeError::ApproversNotListed)
        );
    }
    assert!(!f.mint_paused());
    succeeded(&f.run(NOW + DAY, f.pause(1)));
}

// ─── FR-017 and the journal: no reason, no pause; nothing that did nothing ──

#[test]
fn a_pause_or_a_resumption_without_a_reason_is_never_proposed() {
    let mut f = Fixture::new();
    for action in [
        ProposedAction::Pause {
            reason: reason(0, b"INC-2026-0412"),
        },
        ProposedAction::Resume {
            reason: reason(0, b"INC-2026-0412"),
        },
    ] {
        assert_eq!(
            refusal(&f.run(NOW, f.propose(1, OFFICER, action))),
            code(ForgeError::ReasonCodeMissing)
        );
    }
    assert_eq!(
        refusal(&f.run(
            NOW,
            f.propose(
                1,
                OFFICER,
                ProposedAction::Pause {
                    reason: reason(9, b"")
                }
            ),
        )),
        code(ForgeError::CaseReferenceInvalid)
    );
}

#[test]
fn a_paused_token_is_not_paused_again_nor_a_running_one_resumed() {
    // The token program would accept both silently; a second "pause" in the
    // journal under another case would record something that did not happen.
    let mut f = Fixture::new();
    f.matured_resume(1);
    assert_eq!(
        refusal(&f.run(NOW + DAY, f.resume(1))),
        code(ForgeError::MintNotPaused)
    );
    assert_eq!(f.proposal_state(1).executed_at, 0);

    f.matured_pause(2);
    succeeded(&f.run(NOW + DAY, f.pause(2)));
    f.matured_pause(3);
    assert_eq!(
        refusal(&f.run(NOW + 2 * DAY, f.pause(3))),
        code(ForgeError::MintAlreadyPaused)
    );
    assert_eq!(f.proposal_state(3).executed_at, 0);
    // The mirror still says when the pause that holds was set.
    assert_eq!(f.paused_at(), NOW + DAY);

    // The resumption refused a moment ago is still live, and now it applies.
    succeeded(&f.run(NOW + 2 * DAY, f.resume(1)));
    assert!(!f.mint_paused());
}

#[test]
fn the_state_is_read_from_the_mint_not_from_the_mirror() {
    // A mirror that disagrees with the mint — as it would if someone paused
    // through another path — must not decide anything.
    let mut f = Fixture::new();
    let wanted = sol(&f.token_config);
    let (_, account) = f
        .accounts
        .iter_mut()
        .find(|(key, _)| *key == wanted)
        .expect("the token config");
    let mut token = TokenConfig::try_deserialize(&mut &account.data[..]).expect("a token config");
    token.paused_at = NOW - DAY;
    *account = stored(&token, account.lamports);

    f.matured_pause(1);
    succeeded(&f.run(NOW + DAY, f.pause(1)));
    assert!(f.mint_paused());
    assert_eq!(f.paused_at(), NOW + DAY);
}
