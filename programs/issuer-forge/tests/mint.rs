//! Further issuance at runtime (T038, T039, FR-022, FR-023, FR-024b, FR-035,
//! FR-038).
//!
//! **What this covers and the unit tests cannot.** `reserve.rs` tests the
//! gate as arithmetic and `state/proposal.rs` what an issuance proposal
//! carries. Neither can say that the supply the gate reads is the mint's
//! own, that the token program mints only on the PDA's signature, or that a
//! pause refuses issuance before the gate is reached, or that the fee lands
//! in an account the ATA program created. This file runs them against the
//! real Token-2022 and ATA programs, with the attestations written by the
//! real `attest_reserve` and the attestor replaced by the real `set_attestor`.
//!
//! **`cargo test` does not rebuild the bytecode** — see `tests/proposal.rs`;
//! the same guard applies here.
use std::path::PathBuf;
use std::sync::Once;

use anchor_lang::prelude::Pubkey as AnchorPubkey;
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::token_2022::spl_token_2022::error::TokenError;
use anchor_spl::token_2022::spl_token_2022::extension::{
    default_account_state, pausable, transfer_hook, ExtensionType, StateWithExtensions,
    StateWithExtensionsMut,
};
use anchor_spl::token_2022::spl_token_2022::state::{
    Account as TokenAccountState, AccountState, Mint as MintState,
};
use issuer_forge::constants::{
    FREEZE_SEED, ISSUER_SEED, MAX_MEMBERS, PROPOSAL_SEED, RESERVE_SEED, TOKEN_SEED,
};
use issuer_forge::error::ForgeError;
use issuer_forge::instructions::{
    AttestReserveArgs, FreezeHolderArgs, MintArgs, ProposeActionArgs, SetAttestorArgs,
};
use issuer_forge::state::{
    case_ref_bytes, currency_bytes, delegation, role, ActionProposal, ComplianceReason,
    IssuerConfig, Member, ProposedAction, ReserveAttestation, TokenConfig,
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
const ATTESTOR: u8 = 15;
const PAYER: u8 = 16;
const NEW_ATTESTOR: u8 = 17;
/// The platform's wallet, outside the membership.
const TREASURY: u8 = 94;
const OPERATOR: u8 = 90;

/// A holder outside the membership, thawed and in good standing.
const HOLDER: u8 = 21;

const NOW: i64 = 1_800_000_000;
const DAY: i64 = 24 * 60 * 60;
const TERM: i64 = 7 * DAY;
const MAX_AGE: i64 = 30 * DAY;
const DECIMALS: u8 = 6;
const SUPPLY: u64 = 1_000_000_000;
/// Twice the supply: room for exactly one more `SUPPLY`.
const RESERVE: u64 = 2 * SUPPLY;
const HEADROOM: u64 = RESERVE - SUPPLY;
const SOL: u64 = 1_000_000_000;
/// 0.12%, as `state/token.rs` declares it.
const FEE_BPS: u16 = 12;

/// The proposal numbers the fixture prepares accounts for.
const NONCES: [u64; 3] = [1, 2, 3];
/// The attestation indices `attest_reserve` may write after #0.
const LATER_ATTESTATIONS: [u64; 2] = [1, 2];

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
        case_ref: case_ref_bytes(b"BOARD/2026/0117"),
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

/// An account thawed as `thaw_holder` or `create_token` leaves it, base
/// layout only, as in `tests/seize.rs`.
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

fn attestation_of(mint: AnchorPubkey, index: u64) -> (AnchorPubkey, u8) {
    AnchorPubkey::find_program_address(
        &[RESERVE_SEED, mint.as_ref(), &index.to_le_bytes()],
        &issuer_forge::ID,
    )
}

fn treasury_account_of(mint: AnchorPubkey) -> AnchorPubkey {
    get_associated_token_address_with_program_id(&wallet(TREASURY), &mint, &spl_token_2022::ID)
}

fn freeze_record_of(token_account: AnchorPubkey) -> AnchorPubkey {
    AnchorPubkey::find_program_address(&[FREEZE_SEED, token_account.as_ref()], &issuer_forge::ID).0
}

fn proposal_of(mint: AnchorPubkey, nonce: u64) -> AnchorPubkey {
    AnchorPubkey::find_program_address(
        &[PROPOSAL_SEED, mint.as_ref(), &nonce.to_le_bytes()],
        &issuer_forge::ID,
    )
    .0
}

struct Fixture {
    mollusk: Mollusk,
    accounts: Vec<(Pubkey, Account)>,
    mint: AnchorPubkey,
    issuer_config: AnchorPubkey,
    token_config: AnchorPubkey,
    treasury_account: AnchorPubkey,
}

impl Fixture {
    fn new() -> Self {
        Self::with_fee(0)
    }

    /// A token as `create_token` leaves it: attestation #0 for `RESERVE`,
    /// signed a day ago by its attestor, `SUPPLY` already issued to the
    /// founder, the treasury's account not yet created.
    fn with_fee(fee_bps: u16) -> Self {
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
            (ATTESTOR, role::ATTESTOR),
            (NEW_ATTESTOR, role::ATTESTOR),
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
            member_slots: 6,
            quorum_n: 2,
            operational_key: wallet(OPERATOR),
            // Everything the operational key can ever hold; issuance stays
            // out of its reach even so (SC-012).
            delegation_mask: delegation::ALL,
            bump: issuer_bump,
            token_count: 1,
        };

        let token = TokenConfig {
            issuer: issuer_config,
            mint,
            attestation_credential: wallet(91),
            attestation_schema: wallet(92),
            attestor: wallet(ATTESTOR),
            treasury: wallet(TREASURY),
            policy_version: 1,
            fee_bps,
            attestation_max_age: MAX_AGE,
            paused_at: 0,
            bump: token_bump,
            attestation_count: 1,
            reserve_currency: currency_bytes(b"NGN"),
        };

        let (first_attestation, first_bump) = attestation_of(mint, 0);
        let attestation = ReserveAttestation {
            mint,
            index: 0,
            amount: RESERVE,
            currency: currency_bytes(b"NGN"),
            attestor: wallet(ATTESTOR),
            attested_at: NOW - DAY,
            bump: first_bump,
        };

        let mut mollusk = Mollusk::new(&sol(&program_id), "issuer_forge");
        token2022::add_program(&mut mollusk);
        associated_token::add_program(&mut mollusk);
        mollusk.sysvars.clock.unix_timestamp = NOW;

        let treasury_account = treasury_account_of(mint);

        let mut accounts = vec![
            (sol(&issuer_config), stored(&issuer, SOL)),
            (sol(&token_config), stored(&token, SOL)),
            (sol(&first_attestation), stored(&attestation, SOL)),
            (
                sol(&mint),
                Self::mint_account(&mut mollusk, mint, token_config),
            ),
            (sol(&wallet(PAYER)), funded(100 * SOL)),
        ];
        for (seed, amount) in [
            (ADMIN_A, SUPPLY),
            (ADMIN_B, 0),
            (OFFICER, 0),
            (OBSERVER, 0),
            (ATTESTOR, 0),
            (HOLDER, 0),
        ] {
            accounts.push((
                sol(&token_account_of(seed)),
                token_account(seed, mint, amount),
            ));
        }
        accounts.push((sol(&wallet(TREASURY)), uninitialised()));
        accounts.push((sol(&treasury_account), uninitialised()));
        accounts.push((sol(&freeze_record_of(treasury_account)), uninitialised()));
        for index in LATER_ATTESTATIONS {
            accounts.push((sol(&attestation_of(mint, index).0), uninitialised()));
        }
        for nonce in NONCES {
            accounts.push((sol(&proposal_of(mint, nonce)), uninitialised()));
        }
        for seed in [
            ADMIN_A,
            ADMIN_B,
            OFFICER,
            OBSERVER,
            ATTESTOR,
            NEW_ATTESTOR,
            OPERATOR,
        ] {
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
            treasury_account,
        }
    }

    /// The mint as `create_token` leaves it, built by the token program's own
    /// initialisers; only the supply is written afterwards, standing in for
    /// the initial issuance.
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

    fn balance(&self, owner: u8) -> u64 {
        self.token_state_at(&token_account_of(owner)).amount
    }

    fn treasury_exists(&self) -> bool {
        !self.account(&self.treasury_account).data.is_empty()
    }

    fn treasury_state(&self) -> TokenAccountState {
        self.token_state_at(&self.treasury_account)
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

    fn pause(&mut self) {
        let instruction = bridged(
            pausable::instruction::pause(&spl_token_2022::ID, &self.mint, &self.token_config, &[])
                .expect("a pause instruction"),
        );
        // Straight through the token program, as in `tests/seize.rs`:
        // `pause_circulation` is tested in `tests/pause.rs`.
        succeeded(&self.run(NOW, instruction));
    }

    // ─── The instructions under test ─────────────────────────────────────────

    fn propose(&self, nonce: u64, proposer: u8, owner: u8, amount: u64) -> Instruction {
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
                    action: ProposedAction::Mint {
                        token_account: token_account_of(owner),
                        amount,
                    },
                },
            },
            Vec::new(),
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
            Vec::new(),
        )
    }

    /// Propose and approve — a proposal that has reached its quorum.
    fn matured(&mut self, nonce: u64, owner: u8, amount: u64) {
        self.matured_at(NOW, nonce, owner, amount);
    }

    fn matured_at(&mut self, now: i64, nonce: u64, owner: u8, amount: u64) {
        succeeded(&self.run(now, self.propose(nonce, ADMIN_A, owner, amount)));
        succeeded(&self.run(now, self.approve(nonce, ADMIN_B)));
    }

    fn approvers(&self, nonce: u64) -> Vec<AnchorPubkey> {
        self.proposal_state(nonce).approvals().to_vec()
    }

    fn latest_attestation(&self) -> AnchorPubkey {
        let data = &self.account(&self.token_config).data;
        let token = TokenConfig::try_deserialize(&mut &data[..]).expect("a token config");
        attestation_of(self.mint, token.attestation_count - 1).0
    }

    /// `mint` as a client would build it: the latest attestation, the
    /// proposal's approvers after the accounts.
    fn issue(&self, nonce: u64, owner: u8, amount: u64) -> Instruction {
        self.issue_with(
            nonce,
            token_account_of(owner),
            amount,
            self.latest_attestation(),
            &self.approvers(nonce),
        )
    }

    fn issue_with(
        &self,
        nonce: u64,
        destination: AnchorPubkey,
        amount: u64,
        attestation: AnchorPubkey,
        approvers: &[AnchorPubkey],
    ) -> Instruction {
        self.issue_paying(
            nonce,
            destination,
            amount,
            attestation,
            approvers,
            self.treasury_account,
        )
    }

    fn issue_paying(
        &self,
        nonce: u64,
        destination: AnchorPubkey,
        amount: u64,
        attestation: AnchorPubkey,
        approvers: &[AnchorPubkey],
        treasury_account: AnchorPubkey,
    ) -> Instruction {
        build(
            issuer_forge::accounts::MintTokens {
                issuer_config: self.issuer_config,
                token_config: self.token_config,
                mint: self.mint,
                attestation,
                destination,
                treasury: wallet(TREASURY),
                treasury_account,
                treasury_freeze: freeze_record_of(self.treasury_account),
                proposal: proposal_of(self.mint, nonce),
                payer: wallet(PAYER),
                token_program: spl_token_2022::ID,
                associated_token_program: anchor_spl::associated_token::ID,
                system_program: anchor_lang::system_program::ID,
            },
            issuer_forge::instruction::Mint {
                args: MintArgs { amount },
            },
            approvers
                .iter()
                .map(|approver| AccountMeta::new_readonly(sol(approver), false))
                .collect(),
        )
    }

    /// `freeze_holder` on the treasury's account, by the officer.
    fn freeze_treasury(&self) -> Instruction {
        build(
            issuer_forge::accounts::FreezeHolder {
                issuer_config: self.issuer_config,
                token_config: self.token_config,
                mint: self.mint,
                token_account: self.treasury_account,
                freeze_record: freeze_record_of(self.treasury_account),
                payer: wallet(PAYER),
                officer: wallet(OFFICER),
                token_program: spl_token_2022::ID,
                system_program: anchor_lang::system_program::ID,
            },
            issuer_forge::instruction::FreezeHolder {
                args: FreezeHolderArgs { reason: a_reason() },
            },
            Vec::new(),
        )
    }

    /// `attest_reserve` for the next index, signed by `attestor`.
    fn attest(&self, attestor: u8, amount: u64, attested_at: i64) -> Instruction {
        let data = &self.account(&self.token_config).data;
        let token = TokenConfig::try_deserialize(&mut &data[..]).expect("a token config");
        build(
            issuer_forge::accounts::AttestReserve {
                token_config: self.token_config,
                attestation: attestation_of(self.mint, token.attestation_count).0,
                attestor: wallet(attestor),
                payer: wallet(PAYER),
                system_program: anchor_lang::system_program::ID,
            },
            issuer_forge::instruction::AttestReserve {
                args: AttestReserveArgs {
                    amount,
                    currency: currency_bytes(b"NGN"),
                    attested_at,
                    attestation_max_age: MAX_AGE,
                },
            },
            Vec::new(),
        )
    }

    /// `set_attestor` on the immediate path, signed by both admins.
    fn replace_attestor(&self, attestor: u8) -> Instruction {
        build(
            issuer_forge::accounts::SetAttestor {
                issuer_config: self.issuer_config,
                token_config: self.token_config,
                proposal: None,
            },
            issuer_forge::instruction::SetAttestor {
                args: SetAttestorArgs {
                    attestor: wallet(attestor),
                    attestation_max_age: MAX_AGE,
                    reason: a_reason(),
                },
            },
            [ADMIN_A, ADMIN_B]
                .iter()
                .map(|seed| AccountMeta::new_readonly(sol(&wallet(*seed)), true))
                .collect(),
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

// ─── FR-022: within the reserve, and not one unit beyond ────────────────────

#[test]
fn a_quorum_issues_up_to_exactly_the_attested_reserve() {
    let mut f = Fixture::new();
    f.matured(1, ADMIN_B, HEADROOM);

    // Only the payer signs the execution: the quorum is in the proposal.
    let issuance = f.issue(1, ADMIN_B, HEADROOM);
    let signers: Vec<Pubkey> = issuance
        .accounts
        .iter()
        .filter(|meta| meta.is_signer)
        .map(|meta| meta.pubkey)
        .collect();
    assert_eq!(signers, vec![sol(&wallet(PAYER))]);
    succeeded(&f.run(NOW + DAY, issuance));

    assert_eq!(f.balance(ADMIN_B), HEADROOM);
    assert_eq!(f.supply(), RESERVE);
    assert_eq!(f.balance(ADMIN_A), SUPPLY);
    assert_eq!(f.proposal_state(1).executed_at, NOW + DAY);
}

#[test]
fn one_unit_beyond_the_reserve_is_refused() {
    let mut f = Fixture::new();
    f.matured(1, ADMIN_B, HEADROOM + 1);
    assert_eq!(
        refusal(&f.run(NOW + DAY, f.issue(1, ADMIN_B, HEADROOM + 1))),
        code(ForgeError::ReserveInsufficient)
    );
    assert_eq!(f.supply(), SUPPLY);
    assert_eq!(f.proposal_state(1).executed_at, 0);
}

#[test]
fn the_second_of_two_issuances_that_each_fit_alone_is_refused() {
    // SC-005: both proposals were approved against the same reserve. The
    // second execution reads a supply the first one already raised.
    let mut f = Fixture::new();
    let each = HEADROOM / 2 + 1;
    f.matured(1, ADMIN_A, each);
    f.matured(2, ADMIN_B, each);

    succeeded(&f.run(NOW + DAY, f.issue(1, ADMIN_A, each)));
    assert_eq!(
        refusal(&f.run(NOW + DAY, f.issue(2, ADMIN_B, each))),
        code(ForgeError::ReserveInsufficient)
    );
    assert_eq!(f.supply(), SUPPLY + each);
}

#[test]
fn an_expired_attestation_stops_issuance_until_a_fresh_one_lands() {
    // The independent test of US3: wait out the attestation — issuance
    // stops; attest again — it resumes.
    let mut f = Fixture::new();
    let expired = NOW - DAY + MAX_AGE + 1;
    f.matured_at(expired, 1, ADMIN_B, 1_000);
    assert_eq!(
        refusal(&f.run(expired, f.issue(1, ADMIN_B, 1_000))),
        code(ForgeError::ReserveAttestationExpired)
    );

    succeeded(&f.run(expired, f.attest(ATTESTOR, RESERVE, expired)));
    succeeded(&f.run(expired, f.issue(1, ADMIN_B, 1_000)));
    assert_eq!(f.supply(), SUPPLY + 1_000);
}

#[test]
fn an_older_attestation_with_a_larger_amount_is_not_an_input() {
    // A later attestation narrowed the reserve to what is already issued;
    // the earlier, larger one is still on chain and must not count.
    let mut f = Fixture::new();
    succeeded(&f.run(NOW, f.attest(ATTESTOR, SUPPLY, NOW)));
    f.matured(1, ADMIN_B, 1_000);

    let first = attestation_of(f.mint, 0).0;
    assert_eq!(
        refusal(&f.run(
            NOW,
            f.issue_with(1, token_account_of(ADMIN_B), 1_000, first, &f.approvers(1)),
        )),
        code(ForgeError::AttestationNotLatest)
    );
    assert_eq!(
        refusal(&f.run(NOW, f.issue(1, ADMIN_B, 1_000))),
        code(ForgeError::ReserveInsufficient)
    );
}

// ─── FR-024b: the attestation of a replaced attestor no longer counts ───────

#[test]
fn replacing_the_attestor_stops_issuance_until_the_new_one_attests() {
    let mut f = Fixture::new();
    f.matured(1, ADMIN_B, 1_000);
    succeeded(&f.run(NOW, f.replace_attestor(NEW_ATTESTOR)));

    // Attestation #0 is still the latest and still within its period.
    assert_eq!(
        refusal(&f.run(NOW, f.issue(1, ADMIN_B, 1_000))),
        code(ForgeError::AttestationByFormerAttestor)
    );
    assert_eq!(f.supply(), SUPPLY);

    succeeded(&f.run(NOW, f.attest(NEW_ATTESTOR, RESERVE, NOW)));
    succeeded(&f.run(NOW, f.issue(1, ADMIN_B, 1_000)));
    assert_eq!(f.balance(ADMIN_B), 1_000);
}

// ─── FR-019, FR-035: the quorum, and only the quorum ────────────────────────

#[test]
fn one_signature_out_of_two_issues_nothing() {
    let mut f = Fixture::new();
    succeeded(&f.run(NOW, f.propose(1, ADMIN_A, ADMIN_B, 1_000)));
    assert_eq!(
        refusal(&f.run(NOW, f.issue(1, ADMIN_B, 1_000))),
        code(ForgeError::QuorumNotReached)
    );
    assert_eq!(f.supply(), SUPPLY);
}

#[test]
fn the_operational_key_an_observer_and_the_attestor_cannot_raise_an_issuance() {
    // SC-012 and FR-024: neither the key with every delegable power nor the
    // attestor can so much as propose one.
    let mut f = Fixture::new();
    for outsider in [OPERATOR, OBSERVER, ATTESTOR] {
        assert_eq!(
            refusal(&f.run(NOW, f.propose(1, outsider, ADMIN_A, 1_000))),
            code(ForgeError::NotAnAuthorisingSigner)
        );
    }
}

#[test]
fn the_approvers_must_be_named_exactly() {
    let mut f = Fixture::new();
    f.matured(1, ADMIN_B, 1_000);
    let attestation = f.latest_attestation();
    let destination = token_account_of(ADMIN_B);
    for listed in [
        vec![wallet(ADMIN_A)],
        vec![wallet(ADMIN_B), wallet(ADMIN_A)],
        vec![wallet(ADMIN_A), wallet(ADMIN_B), wallet(OFFICER)],
    ] {
        assert_eq!(
            refusal(&f.run(
                NOW,
                f.issue_with(1, destination, 1_000, attestation, &listed),
            )),
            code(ForgeError::ApproversNotListed)
        );
    }
}

#[test]
fn the_execution_issues_exactly_what_was_approved() {
    let mut f = Fixture::new();
    f.matured(1, ADMIN_B, 1_000);
    let attestation = f.latest_attestation();
    let approvers = f.approvers(1);
    for (destination, amount) in [
        (token_account_of(ADMIN_B), 1_001),
        (token_account_of(ADMIN_A), 1_000),
    ] {
        assert_eq!(
            refusal(&f.run(
                NOW,
                f.issue_with(1, destination, amount, attestation, &approvers),
            )),
            code(ForgeError::ProposalBodyMismatch)
        );
    }
}

#[test]
fn an_executed_issuance_does_not_run_twice() {
    let mut f = Fixture::new();
    f.matured(1, ADMIN_B, 1_000);
    succeeded(&f.run(NOW, f.issue(1, ADMIN_B, 1_000)));
    assert_eq!(
        refusal(&f.run(NOW, f.issue(1, ADMIN_B, 1_000))),
        code(ForgeError::ProposalAlreadyExecuted)
    );
    assert_eq!(f.supply(), SUPPLY + 1_000);
}

// ─── Where the tokens land ──────────────────────────────────────────────────

#[test]
fn issuance_lands_only_with_a_member_who_may_authorise() {
    // `mint_to` skips the hook. A holder's account would receive tokens no
    // rule has checked; the attestor's would hand FR-024's key funds.
    let mut f = Fixture::new();
    for (nonce, owner) in [(1, HOLDER), (2, ATTESTOR), (3, OBSERVER)] {
        f.matured(nonce, owner, 1_000);
        assert_eq!(
            refusal(&f.run(NOW, f.issue(nonce, owner, 1_000))),
            code(ForgeError::IssuanceToANonMember)
        );
        assert_eq!(f.balance(owner), 0);
    }
    assert_eq!(f.supply(), SUPPLY);
}

#[test]
fn a_compliance_officer_may_receive_an_issuance() {
    let mut f = Fixture::new();
    f.matured(1, OFFICER, 1_000);
    succeeded(&f.run(NOW, f.issue(1, OFFICER, 1_000)));
    assert_eq!(f.balance(OFFICER), 1_000);
}

#[test]
fn a_pause_stops_issuance_at_the_token_program() {
    let mut f = Fixture::new();
    f.matured(1, ADMIN_B, 1_000);
    f.pause();
    assert_eq!(
        refusal(&f.run(NOW, f.issue(1, ADMIN_B, 1_000))),
        TokenError::MintPaused as u32
    );
    assert_eq!(f.supply(), SUPPLY);
}

// ─── FR-038: the platform's fee, out of the issued amount ───────────────────

/// What `fee_on` gives for `FEE_BPS`, rounded up; `state/token.rs` tests the
/// arithmetic, this only spares the tests below a second formula.
fn fee(amount: u64) -> u64 {
    (amount * u64::from(FEE_BPS)).div_ceil(10_000)
}

#[test]
fn the_fee_goes_to_the_treasury_and_the_rest_to_the_approved_account() {
    let mut f = Fixture::with_fee(FEE_BPS);
    f.matured(1, ADMIN_B, 1_000_000);
    succeeded(&f.run(NOW, f.issue(1, ADMIN_B, 1_000_000)));

    assert_eq!(fee(1_000_000), 1_200);
    assert_eq!(f.balance(ADMIN_B), 1_000_000 - 1_200);
    let treasury = f.treasury_state();
    assert_eq!(treasury.amount, 1_200);
    assert_eq!(treasury.owner, wallet(TREASURY));
    assert_eq!(treasury.mint, f.mint);
    // Created under `DefaultAccountState = Frozen` and thawed for the fee.
    assert_eq!(treasury.state, AccountState::Initialized);
    assert_eq!(f.supply(), SUPPLY + 1_000_000);
}

#[test]
fn the_reserve_covers_the_fee_as_well() {
    // FR-038b: the gate counts the whole amount. The issuer's share of one
    // unit beyond the reserve would fit; the issuance does not.
    let mut f = Fixture::with_fee(FEE_BPS);
    f.matured(1, ADMIN_B, HEADROOM + 1);
    assert!(HEADROOM + 1 - fee(HEADROOM + 1) <= HEADROOM);
    assert_eq!(
        refusal(&f.run(NOW, f.issue(1, ADMIN_B, HEADROOM + 1))),
        code(ForgeError::ReserveInsufficient)
    );
    assert!(!f.treasury_exists());

    f.matured(2, ADMIN_B, HEADROOM);
    succeeded(&f.run(NOW, f.issue(2, ADMIN_B, HEADROOM)));
    assert_eq!(f.supply(), RESERVE);
    assert_eq!(f.balance(ADMIN_B) + f.treasury_state().amount, HEADROOM);
}

#[test]
fn a_fraction_of_a_unit_of_fee_is_a_whole_unit() {
    let mut f = Fixture::with_fee(FEE_BPS);
    f.matured(1, ADMIN_B, 1);
    succeeded(&f.run(NOW, f.issue(1, ADMIN_B, 1)));
    assert_eq!(f.treasury_state().amount, 1);
    assert_eq!(f.balance(ADMIN_B), 0);
}

#[test]
fn a_zero_rate_leaves_the_treasury_untouched() {
    let mut f = Fixture::new();
    f.matured(1, ADMIN_B, 1_000);
    succeeded(&f.run(NOW, f.issue(1, ADMIN_B, 1_000)));
    assert_eq!(f.balance(ADMIN_B), 1_000);
    assert!(!f.treasury_exists());
}

#[test]
fn fees_accumulate_in_the_one_treasury_account() {
    let mut f = Fixture::with_fee(FEE_BPS);
    f.matured(1, ADMIN_A, 1_000_000);
    f.matured(2, ADMIN_B, 2_000_000);
    succeeded(&f.run(NOW, f.issue(1, ADMIN_A, 1_000_000)));
    succeeded(&f.run(NOW, f.issue(2, ADMIN_B, 2_000_000)));
    assert_eq!(f.treasury_state().amount, fee(1_000_000) + fee(2_000_000));
}

#[test]
fn a_treasury_account_someone_else_created_is_thawed_and_paid() {
    // Anyone may create an associated account for anyone. Left frozen by
    // `DefaultAccountState`, it must not stop the issuer's issuance.
    let mut f = Fixture::with_fee(FEE_BPS);
    // The ATA program's `Create`: an empty instruction data.
    let create = Instruction {
        program_id: sol(&anchor_spl::associated_token::ID),
        accounts: vec![
            AccountMeta::new(sol(&wallet(PAYER)), true),
            AccountMeta::new(sol(&f.treasury_account), false),
            AccountMeta::new_readonly(sol(&wallet(TREASURY)), false),
            AccountMeta::new_readonly(sol(&f.mint), false),
            AccountMeta::new_readonly(sol(&anchor_lang::system_program::ID), false),
            AccountMeta::new_readonly(sol(&spl_token_2022::ID), false),
        ],
        data: Vec::new(),
    };
    succeeded(&f.run(NOW, create));
    assert_eq!(f.treasury_state().state, AccountState::Frozen);

    f.matured(1, ADMIN_B, 1_000_000);
    succeeded(&f.run(NOW, f.issue(1, ADMIN_B, 1_000_000)));
    assert_eq!(f.treasury_state().amount, fee(1_000_000));
    assert_eq!(f.treasury_state().state, AccountState::Initialized);
}

#[test]
fn a_treasury_an_officer_froze_is_not_thawed_by_an_issuance() {
    // A `FreezeRecord` says the account is frozen by an officer, and
    // `thaw_holder` refuses to step over it; issuance does not either.
    let mut f = Fixture::with_fee(FEE_BPS);
    f.matured(1, ADMIN_B, 1_000_000);
    succeeded(&f.run(NOW, f.issue(1, ADMIN_B, 1_000_000)));
    succeeded(&f.run(NOW, f.freeze_treasury()));

    f.matured(2, ADMIN_B, 1_000_000);
    assert_eq!(
        refusal(&f.run(NOW, f.issue(2, ADMIN_B, 1_000_000))),
        code(ForgeError::TreasuryFrozenByOfficer)
    );
    assert_eq!(f.treasury_state().state, AccountState::Frozen);
    assert_eq!(f.supply(), SUPPLY + 1_000_000);
}

#[test]
fn the_fee_goes_only_to_the_treasury_the_token_declares() {
    let mut f = Fixture::with_fee(FEE_BPS);
    f.matured(1, ADMIN_B, 1_000_000);
    let attestation = f.latest_attestation();
    let approvers = f.approvers(1);
    for elsewhere in [token_account_of(ADMIN_A), token_account_of(HOLDER)] {
        assert_eq!(
            refusal(&f.run(
                NOW,
                f.issue_paying(
                    1,
                    token_account_of(ADMIN_B),
                    1_000_000,
                    attestation,
                    &approvers,
                    elsewhere,
                ),
            )),
            code(ForgeError::TreasuryAccountMismatch)
        );
    }
    assert_eq!(f.supply(), SUPPLY);
}
