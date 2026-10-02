//! Seizure at runtime (T027, FR-015, FR-019, FR-020).
//!
//! **What this covers and the unit tests cannot.** `state/proposal.rs` tests
//! what a seizure proposal must carry. It cannot say that the token program
//! lets the permanent delegate burn without the holder's signature, that a
//! frozen account is seized and put back frozen, that the vault the ATA
//! program creates can be minted into, or that supply comes out where it
//! went in. Those are what an issuer is sold, and this file runs them
//! against the real Token-2022 and ATA programs.
//!
//! **The mint carries the production extensions**, set up by the token
//! program's own instructions rather than by hand: `TransferHook` pointing at
//! this very program, `DefaultAccountState = Frozen`, `PermanentDelegate`
//! and `Pausable`. The hook is not there for decoration — a seizure that
//! reached it would die of reentrancy (`issuer_forge → Token-2022 →
//! issuer_forge`), and every successful test here is also the proof that it
//! does not.
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
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::token_2022::spl_token_2022::extension::{
    default_account_state, pausable, transfer_hook, BaseStateWithExtensions, ExtensionType,
    StateWithExtensions, StateWithExtensionsMut,
};
use anchor_spl::token_2022::spl_token_2022::state::{
    Account as TokenAccountState, AccountState, Mint as MintState,
};
use issuer_forge::constants::{ISSUER_SEED, MAX_MEMBERS, PROPOSAL_SEED, TOKEN_SEED};
use issuer_forge::error::ForgeError;
use issuer_forge::instructions::{ProposeActionArgs, SeizeArgs};
use issuer_forge::state::{
    case_ref_bytes, delegation, role, ActionKind, ActionProposal, ComplianceReason, IssuerConfig,
    Member, ProposedAction, TokenConfig,
};
use mollusk_svm::result::{InstructionResult, ProgramResult};
use mollusk_svm::Mollusk;
use mollusk_svm_programs_token::{associated_token, token2022};
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

/// The holder the order names: thawed, holding funds.
const SUSPECT: u8 = 21;
/// A holder an officer has already frozen — the usual target of a seizure.
const FROZEN_SUSPECT: u8 = 22;
/// A bystander whose balance must not move.
const BYSTANDER: u8 = 23;

const NOW: i64 = 1_800_000_000;
const DAY: i64 = 24 * 60 * 60;
const TERM: i64 = 7 * DAY;
const DECIMALS: u8 = 6;
const BALANCE: u64 = 500_000_000;
const SUPPLY: u64 = 3 * BALANCE;
const SOL: u64 = 1_000_000_000;

/// The proposal numbers the fixture prepares accounts for.
const NONCES: [u64; 3] = [1, 2, 3];

/// Token-2022's `TokenError::InsufficientFunds`.
const INSUFFICIENT_FUNDS: u32 = 1;

fn wallet(seed: u8) -> AnchorPubkey {
    AnchorPubkey::new_from_array([seed; 32])
}

fn token_account_of(seed: u8) -> AnchorPubkey {
    AnchorPubkey::new_from_array([seed + 100; 32])
}

fn sol(key: &AnchorPubkey) -> Pubkey {
    Pubkey::new_from_array(key.to_bytes())
}

fn a_reason() -> ComplianceReason {
    ComplianceReason {
        code: 4,
        case_ref: case_ref_bytes(b"FIU-NG/2026/004117"),
    }
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

fn uninitialised() -> Account {
    funded(0)
}

/// A holder's account, base layout only. The token program accepts it for a
/// mint with extensions: the account extensions are required when an
/// account is initialised, and these are written already initialised.
fn token_account(owner: u8, mint: AnchorPubkey, amount: u64, state: AccountState) -> Account {
    let mut data = vec![0u8; TokenAccountState::LEN];
    TokenAccountState::pack(
        TokenAccountState {
            mint,
            owner: wallet(owner),
            amount,
            delegate: COption::None,
            state,
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

/// Token-2022 instructions come out of the anchor-side crate with 2.x metas.
fn bridged(instruction: anchor_lang::solana_program::instruction::Instruction) -> Instruction {
    Instruction {
        program_id: sol(&instruction.program_id),
        accounts: instruction
            .accounts
            .iter()
            .map(|meta| AccountMeta {
                pubkey: sol(&meta.pubkey),
                is_signer: meta.is_signer,
                is_writable: meta.is_writable,
            })
            .collect(),
        data: instruction.data,
    }
}

struct Fixture {
    mollusk: Mollusk,
    accounts: Vec<(Pubkey, Account)>,
    mint: AnchorPubkey,
    issuer_config: AnchorPubkey,
    token_config: AnchorPubkey,
    vault: AnchorPubkey,
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
        let vault =
            get_associated_token_address_with_program_id(&token_config, &mint, &spl_token_2022::ID);

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
            // Everything the operational key can ever hold; a seizure stays
            // out of its reach even so.
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
        associated_token::add_program(&mut mollusk);
        mollusk.sysvars.clock.unix_timestamp = NOW;

        let mut accounts = vec![
            (sol(&issuer_config), stored(&issuer, SOL)),
            (sol(&token_config), stored(&token, SOL)),
            (
                sol(&mint),
                Self::mint_account(&mut mollusk, mint, token_config),
            ),
            (
                sol(&token_account_of(SUSPECT)),
                token_account(SUSPECT, mint, BALANCE, AccountState::Initialized),
            ),
            (
                sol(&token_account_of(FROZEN_SUSPECT)),
                token_account(FROZEN_SUSPECT, mint, BALANCE, AccountState::Frozen),
            ),
            (
                sol(&token_account_of(BYSTANDER)),
                token_account(BYSTANDER, mint, BALANCE, AccountState::Initialized),
            ),
            (sol(&vault), uninitialised()),
            (sol(&wallet(PAYER)), funded(100 * SOL)),
        ];
        for nonce in NONCES {
            accounts.push((sol(&proposal_of(mint, nonce)), uninitialised()));
        }
        for seed in [ADMIN_A, ADMIN_B, OFFICER, OBSERVER, OPERATOR] {
            accounts.push((sol(&wallet(seed)), funded(SOL)));
        }
        accounts.push(mollusk_svm::program::keyed_account_for_system_program());
        accounts.push(token2022::keyed_account());
        accounts.push(associated_token::keyed_account());

        Self {
            mollusk,
            accounts,
            mint,
            issuer_config,
            token_config,
            vault,
        }
    }

    /// The mint as `create_token` leaves it, built by the token program's own
    /// initialisers; only the supply is written afterwards, standing in for
    /// the issuance that put the three balances there.
    fn mint_account(mollusk: &mut Mollusk, mint: AnchorPubkey, authority: AnchorPubkey) -> Account {
        let token_program = spl_token_2022::ID;
        let len = ExtensionType::try_calculate_account_len::<MintState>(&[
            ExtensionType::TransferHook,
            ExtensionType::DefaultAccountState,
            ExtensionType::PermanentDelegate,
            ExtensionType::Pausable,
        ])
        .expect("a mint length");
        let blank = Account {
            lamports: SOL,
            data: vec![0u8; len],
            owner: token2022::ID,
            executable: false,
            rent_epoch: 0,
        };

        let steps = [
            transfer_hook::instruction::initialize(
                &token_program,
                &mint,
                Some(authority),
                Some(issuer_forge::ID),
            ),
            default_account_state::instruction::initialize_default_account_state(
                &token_program,
                &mint,
                &AccountState::Frozen,
            ),
            spl_token_2022::instruction::initialize_permanent_delegate(
                &token_program,
                &mint,
                &authority,
            ),
            pausable::instruction::initialize(&token_program, &mint, &authority),
            spl_token_2022::instruction::initialize_mint2(
                &token_program,
                &mint,
                &authority,
                Some(&authority),
                DECIMALS,
            ),
        ];

        let mut account = blank;
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
        state.base.supply = SUPPLY;
        state.pack_base();
        account
    }

    /// Runs one instruction at `now` and carries the resulting accounts
    /// forward on success, as `tests/proposal.rs` does.
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

    fn token_state_at(&self, key: &AnchorPubkey) -> TokenAccountState {
        StateWithExtensions::<TokenAccountState>::unpack(&self.account(key).data)
            .expect("a token account")
            .base
    }

    fn balance(&self, holder: u8) -> u64 {
        self.token_state_at(&token_account_of(holder)).amount
    }

    fn vault_state(&self) -> TokenAccountState {
        self.token_state_at(&self.vault)
    }

    fn supply(&self) -> u64 {
        StateWithExtensions::<MintState>::unpack(&self.account(&self.mint).data)
            .expect("a mint")
            .base
            .supply
    }

    fn proposal_state(&self, nonce: u64) -> ActionProposal {
        let data = &self.account(&proposal_of(self.mint, nonce)).data;
        ActionProposal::try_deserialize(&mut &data[..]).expect("a proposal the program wrote")
    }

    fn mint_paused(&self) -> bool {
        let data = &self.account(&self.mint).data;
        let mint = StateWithExtensions::<MintState>::unpack(data).expect("a mint");
        bool::from(
            mint.get_extension::<pausable::PausableConfig>()
                .expect("the pausable extension")
                .paused,
        )
    }

    fn pause(&mut self) {
        let instruction = bridged(
            pausable::instruction::pause(&spl_token_2022::ID, &self.mint, &self.token_config, &[])
                .expect("a pause instruction"),
        );
        // Straight through the token program: the PDA "signs" because
        // mollusk does not verify signatures. `pause_circulation` itself is
        // tested in `tests/pause.rs`; here only the paused state matters.
        let result = self.run(NOW, instruction);
        assert_eq!(
            result.program_result,
            ProgramResult::Success,
            "pause failed"
        );
    }

    // ─── The instructions under test ─────────────────────────────────────────

    fn propose(&self, nonce: u64, proposer: u8, action: ProposedAction) -> Instruction {
        build(
            issuer_forge::accounts::ProposeAction {
                issuer_config: self.issuer_config,
                token_config: self.token_config,
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

    fn propose_seizure(&self, nonce: u64, proposer: u8, holder: u8, amount: u64) -> Instruction {
        self.propose(
            nonce,
            proposer,
            ProposedAction::Seize {
                token_account: token_account_of(holder),
                amount,
                reason: a_reason(),
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

    /// The approvers as the proposal holds them — what `seize` must be
    /// given after its accounts. Empty for a proposal that does not exist.
    fn approvers(&self, nonce: u64) -> Vec<AnchorPubkey> {
        if self.account(&proposal_of(self.mint, nonce)).data.is_empty() {
            return Vec::new();
        }
        self.proposal_state(nonce).approvals().to_vec()
    }

    fn seize_from(
        &self,
        nonce: u64,
        source: AnchorPubkey,
        vault: AnchorPubkey,
        amount: u64,
        reason: ComplianceReason,
    ) -> Instruction {
        self.seize_listing(nonce, source, vault, amount, reason, &self.approvers(nonce))
    }

    fn seize_listing(
        &self,
        nonce: u64,
        source: AnchorPubkey,
        vault: AnchorPubkey,
        amount: u64,
        reason: ComplianceReason,
        approvers: &[AnchorPubkey],
    ) -> Instruction {
        let mut instruction = build(
            issuer_forge::accounts::Seize {
                issuer_config: self.issuer_config,
                token_config: self.token_config,
                mint: self.mint,
                source,
                vault,
                proposal: proposal_of(self.mint, nonce),
                payer: wallet(PAYER),
                token_program: spl_token_2022::ID,
                associated_token_program: anchor_spl::associated_token::ID,
                system_program: anchor_lang::system_program::ID,
            },
            issuer_forge::instruction::Seize {
                args: SeizeArgs { amount, reason },
            },
        );
        instruction.accounts.extend(
            approvers
                .iter()
                .map(|approver| AccountMeta::new_readonly(sol(approver), false)),
        );
        instruction
    }

    fn seize(&self, nonce: u64, holder: u8, amount: u64) -> Instruction {
        self.seize_from(
            nonce,
            token_account_of(holder),
            self.vault,
            amount,
            a_reason(),
        )
    }

    /// Propose and approve — a proposal that has reached its quorum.
    fn matured(&mut self, nonce: u64, holder: u8, amount: u64) {
        succeeded(&self.run(NOW, self.propose_seizure(nonce, OFFICER, holder, amount)));
        succeeded(&self.run(NOW + DAY, self.approve(nonce, ADMIN_A)));
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
        accounts: accounts
            .to_account_metas(None)
            .iter()
            .map(|meta| AccountMeta {
                pubkey: sol(&meta.pubkey),
                is_signer: meta.is_signer,
                is_writable: meta.is_writable,
            })
            .collect(),
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

// ─── FR-015: the funds leave without the holder's signature ─────────────────

#[test]
fn a_quorum_moves_the_balance_into_the_issuers_vault() {
    let mut f = Fixture::new();
    f.matured(1, SUSPECT, BALANCE);

    // Nobody in this instruction is the suspect: the only signer is the payer.
    let seizure = f.seize(1, SUSPECT, BALANCE);
    assert!(seizure
        .accounts
        .iter()
        .filter(|meta| meta.is_signer)
        .all(|meta| meta.pubkey == sol(&wallet(PAYER))));
    succeeded(&f.run(NOW + DAY, seizure));

    assert_eq!(f.balance(SUSPECT), 0);
    let vault = f.vault_state();
    assert_eq!(vault.amount, BALANCE);
    // The issuer's account: owned by the token's PDA, thawed so it could be
    // minted into.
    assert_eq!(vault.owner, f.token_config);
    assert_eq!(vault.mint, f.mint);
    assert_eq!(vault.state, AccountState::Initialized);
    // FR-020 from the chain alone: nothing came into existence, and what was
    // seized is exactly the vault's balance.
    assert_eq!(f.supply(), SUPPLY);
    assert_eq!(f.balance(BYSTANDER), BALANCE);
    assert_eq!(f.proposal_state(1).executed_at, NOW + DAY);
}

#[test]
fn a_frozen_account_is_seized_and_stays_frozen() {
    // The usual order of events: the officer froze the account alone, the
    // quorum followed. The burn needs it thawed; afterwards it must be as the
    // officer left it.
    let mut f = Fixture::new();
    f.matured(1, FROZEN_SUSPECT, 200_000_000);
    succeeded(&f.run(NOW + DAY, f.seize(1, FROZEN_SUSPECT, 200_000_000)));

    let account = f.token_state_at(&token_account_of(FROZEN_SUSPECT));
    assert_eq!(account.amount, BALANCE - 200_000_000);
    assert_eq!(account.state, AccountState::Frozen);
    assert_eq!(f.vault_state().amount, 200_000_000);
}

#[test]
fn a_second_seizure_adds_to_the_same_vault() {
    // The second run takes the path where the vault exists and is thawed.
    let mut f = Fixture::new();
    f.matured(1, SUSPECT, 100_000_000);
    succeeded(&f.run(NOW + DAY, f.seize(1, SUSPECT, 100_000_000)));
    f.matured(2, FROZEN_SUSPECT, BALANCE);
    succeeded(&f.run(NOW + DAY, f.seize(2, FROZEN_SUSPECT, BALANCE)));

    assert_eq!(f.vault_state().amount, 100_000_000 + BALANCE);
    assert_eq!(f.balance(SUSPECT), BALANCE - 100_000_000);
    assert_eq!(f.balance(FROZEN_SUSPECT), 0);
    assert_eq!(f.supply(), SUPPLY);
}

// ─── FR-019: the quorum, and only the quorum ────────────────────────────────

#[test]
fn one_signature_out_of_two_moves_nothing() {
    let mut f = Fixture::new();
    succeeded(&f.run(NOW, f.propose_seizure(1, OFFICER, SUSPECT, BALANCE)));
    assert_eq!(
        refusal(&f.run(NOW, f.seize(1, SUSPECT, BALANCE))),
        code(ForgeError::QuorumNotReached)
    );
    assert_eq!(f.balance(SUSPECT), BALANCE);
    assert_eq!(f.proposal_state(1).executed_at, 0);
}

#[test]
fn the_operational_key_and_an_observer_take_no_part() {
    // SC-012: the operational key has every delegable power and still cannot
    // raise or approve a seizure — there is nothing to delegate it with.
    let mut f = Fixture::new();
    for outsider in [OPERATOR, OBSERVER] {
        assert_eq!(
            refusal(&f.run(NOW, f.propose_seizure(1, outsider, SUSPECT, BALANCE))),
            code(ForgeError::NotAnAuthorisingSigner)
        );
    }
    succeeded(&f.run(NOW, f.propose_seizure(1, OFFICER, SUSPECT, BALANCE)));
    for outsider in [OPERATOR, OBSERVER] {
        assert_eq!(
            refusal(&f.run(NOW, f.approve(1, outsider))),
            code(ForgeError::NotAnAuthorisingSigner)
        );
    }
    assert_eq!(f.balance(SUSPECT), BALANCE);
}

#[test]
fn execution_is_bound_to_the_account_the_amount_and_the_case_approved() {
    let mut f = Fixture::new();
    f.matured(1, SUSPECT, 100_000_000);

    let other_case = ComplianceReason {
        case_ref: case_ref_bytes(b"FIU-NG/2026/004118"),
        ..a_reason()
    };
    for attempt in [
        f.seize(1, SUSPECT, 100_000_001),
        f.seize(1, BYSTANDER, 100_000_000),
        f.seize_from(
            1,
            token_account_of(SUSPECT),
            f.vault,
            100_000_000,
            other_case,
        ),
    ] {
        assert_eq!(
            refusal(&f.run(NOW + DAY, attempt)),
            code(ForgeError::ProposalBodyMismatch)
        );
    }
    assert_eq!(f.balance(SUSPECT), BALANCE);
    assert_eq!(f.balance(BYSTANDER), BALANCE);
}

#[test]
fn a_proposal_seizes_once_and_not_after_its_term() {
    let mut f = Fixture::new();
    f.matured(1, SUSPECT, 100_000_000);
    succeeded(&f.run(NOW + DAY, f.seize(1, SUSPECT, 100_000_000)));
    assert_eq!(
        refusal(&f.run(NOW + DAY, f.seize(1, SUSPECT, 100_000_000))),
        code(ForgeError::ProposalAlreadyExecuted)
    );

    f.matured(2, SUSPECT, 100_000_000);
    assert_eq!(
        refusal(&f.run(NOW + TERM + 1, f.seize(2, SUSPECT, 100_000_000))),
        code(ForgeError::ProposalExpired)
    );
    assert_eq!(f.balance(SUSPECT), BALANCE - 100_000_000);
}

#[test]
fn a_policy_proposal_cannot_be_spent_on_a_seizure() {
    // Both are `ActionProposal`s; the stored kind is what tells them apart.
    let mut f = Fixture::new();
    let mut rules = vec![0u8; issuer_forge::rules::layout::RULES_BYTES];
    rules[0] = issuer_forge::rules::layout::rule_kind::STATUS;
    rules[2] = issuer_forge::rules::layout::status_source::REGISTER;
    succeeded(&f.run(
        NOW,
        f.propose(
            1,
            OFFICER,
            ProposedAction::SetPolicy {
                version: 2,
                rules,
                reason: a_reason(),
            },
        ),
    ));
    succeeded(&f.run(NOW, f.approve(1, ADMIN_A)));
    assert!(matches!(
        f.proposal_state(1).action,
        ActionKind::SetPolicy { .. }
    ));
    assert_eq!(
        refusal(&f.run(NOW, f.seize(1, SUSPECT, BALANCE))),
        code(ForgeError::ProposalBodyMismatch)
    );
}

#[test]
fn the_instruction_names_exactly_the_approvers_the_proposal_holds() {
    // FR-019c: the journal reads who authorised a seizure from this
    // instruction. A list that is short, reordered or padded with someone
    // else is refused, so the one that passes is the one the program counted.
    let mut f = Fixture::new();
    f.matured(1, SUSPECT, BALANCE);
    let listed = f.approvers(1);
    assert_eq!(listed, vec![wallet(OFFICER), wallet(ADMIN_A)]);

    let source = token_account_of(SUSPECT);
    for wrong in [
        vec![listed[0]],
        vec![listed[1], listed[0]],
        vec![listed[0], wallet(ADMIN_B)],
        vec![listed[0], listed[1], wallet(ADMIN_B)],
    ] {
        assert_eq!(
            refusal(&f.run(
                NOW + DAY,
                f.seize_listing(1, source, f.vault, BALANCE, a_reason(), &wrong),
            )),
            code(ForgeError::ApproversNotListed)
        );
    }
    assert_eq!(f.balance(SUSPECT), BALANCE);
    succeeded(&f.run(NOW + DAY, f.seize(1, SUSPECT, BALANCE)));
}

// ─── What a seizure must state ──────────────────────────────────────────────

#[test]
fn a_seizure_without_a_reason_or_of_nothing_is_never_proposed() {
    let mut f = Fixture::new();
    let unstated = ComplianceReason {
        code: 0,
        ..a_reason()
    };
    assert_eq!(
        refusal(&f.run(
            NOW,
            f.propose(
                1,
                OFFICER,
                ProposedAction::Seize {
                    token_account: token_account_of(SUSPECT),
                    amount: BALANCE,
                    reason: unstated,
                },
            ),
        )),
        code(ForgeError::ReasonCodeMissing)
    );
    assert_eq!(
        refusal(&f.run(NOW, f.propose_seizure(1, OFFICER, SUSPECT, 0))),
        code(ForgeError::SeizureAmountZero)
    );
}

// ─── The vault ──────────────────────────────────────────────────────────────

#[test]
fn only_the_tokens_own_vault_receives() {
    let mut f = Fixture::new();
    f.matured(1, SUSPECT, BALANCE);
    // A bystander's account passed as the vault: the funds would have gone to
    // a holder, not to the issuer.
    assert_eq!(
        refusal(&f.run(
            NOW + DAY,
            f.seize_from(
                1,
                token_account_of(SUSPECT),
                token_account_of(BYSTANDER),
                BALANCE,
                a_reason(),
            ),
        )),
        code(ForgeError::SeizureVaultMismatch)
    );
    assert_eq!(f.balance(BYSTANDER), BALANCE);
}

#[test]
fn the_vault_itself_cannot_be_seized_from() {
    let mut f = Fixture::new();
    f.matured(1, SUSPECT, BALANCE);
    succeeded(&f.run(NOW + DAY, f.seize(1, SUSPECT, BALANCE)));

    let vault = f.vault;
    succeeded(&f.run(
        NOW,
        f.propose(
            2,
            OFFICER,
            ProposedAction::Seize {
                token_account: vault,
                amount: BALANCE,
                reason: a_reason(),
            },
        ),
    ));
    succeeded(&f.run(NOW, f.approve(2, ADMIN_B)));
    assert_eq!(
        refusal(&f.run(NOW, f.seize_from(2, vault, vault, BALANCE, a_reason()))),
        code(ForgeError::SeizureFromTheVault)
    );
}

// ─── What the token program refuses ─────────────────────────────────────────

#[test]
fn an_amount_above_the_balance_seizes_nothing() {
    // An exact amount, not "up to": what the quorum approved is not quietly
    // shrunk to what is left.
    let mut f = Fixture::new();
    f.matured(1, SUSPECT, BALANCE + 1);
    assert_eq!(
        refusal(&f.run(NOW + DAY, f.seize(1, SUSPECT, BALANCE + 1))),
        INSUFFICIENT_FUNDS
    );
    assert_eq!(f.balance(SUSPECT), BALANCE);
    assert_eq!(f.proposal_state(1).executed_at, 0);
}

#[test]
fn a_paused_mint_is_still_seized_and_stays_paused() {
    // FR-016 exempts the issuer's own action, and an order is exactly that.
    // Token-2022 refuses burn and mint on a paused mint to every authority,
    // so `seize` lifts the pause for its own instruction and sets it again.
    // Both targets: the vault is created under the pause on the first, and
    // the frozen account is thawed and frozen back under it on the second.
    let mut f = Fixture::new();
    f.matured(1, SUSPECT, BALANCE);
    f.matured(2, FROZEN_SUSPECT, BALANCE);
    f.pause();

    succeeded(&f.run(NOW + DAY, f.seize(1, SUSPECT, BALANCE)));
    assert!(f.mint_paused());
    succeeded(&f.run(NOW + DAY, f.seize(2, FROZEN_SUSPECT, BALANCE)));
    assert!(f.mint_paused());

    assert_eq!(f.balance(SUSPECT), 0);
    assert_eq!(f.balance(FROZEN_SUSPECT), 0);
    assert_eq!(
        f.token_state_at(&token_account_of(FROZEN_SUSPECT)).state,
        AccountState::Frozen
    );
    assert_eq!(f.vault_state().amount, 2 * BALANCE);
    assert_eq!(f.supply(), SUPPLY);
}

#[test]
fn a_seizure_leaves_a_running_mint_running() {
    // The other half of the above: the pause is put back only when it was
    // there. A seizure that paused a running token would stop circulation
    // without the quorum having asked for it.
    let mut f = Fixture::new();
    f.matured(1, SUSPECT, BALANCE);
    succeeded(&f.run(NOW + DAY, f.seize(1, SUSPECT, BALANCE)));
    assert!(!f.mint_paused());
}

#[test]
fn the_fixture_mint_is_the_production_shape() {
    // Without this, every test above could be passing against a mint that
    // has no hook and no delegate — and prove nothing about reentrancy or
    // the delegate's burn.
    let f = Fixture::new();
    let data = &f.account(&f.mint).data;
    let mint = StateWithExtensions::<MintState>::unpack(data).expect("a mint");
    let hook = mint
        .get_extension::<transfer_hook::TransferHook>()
        .expect("the hook extension");
    assert_eq!(
        Option::<AnchorPubkey>::from(hook.program_id),
        Some(issuer_forge::ID)
    );
    let delegate = mint
        .get_extension::<spl_token_2022::extension::permanent_delegate::PermanentDelegate>()
        .expect("the delegate extension");
    assert_eq!(
        Option::<AnchorPubkey>::from(delegate.delegate),
        Some(f.token_config)
    );
}
