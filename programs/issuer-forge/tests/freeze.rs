//! An officer's freeze at runtime (T026, FR-014, FR-017).
//!
//! **What this covers and the unit tests cannot.** `authority.rs` and
//! `state/action.rs` test who may sign and what a reason must look like. They
//! cannot say that the token program actually freezes the account when this
//! program asks, that a frozen account then neither sends nor receives — which
//! is FR-014 and which no line of ours enforces — or that `thaw_holder`, signed
//! by the operational key, stops at the record a freeze leaves behind. Those
//! three are what an issuer is sold, and this file runs them against the real
//! Token-2022 program.
//!
//! **A plain Token-2022 mint, without the hook.** The token program refuses a
//! transfer from or to a frozen account before it would call a hook, so the
//! hook's accounts would add setup and prove nothing more. The mint keeps the
//! one property that matters: its freeze authority is the `TokenConfig` PDA,
//! as `create_token` sets it.
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
use anchor_spl::token_2022::spl_token_2022::state::{
    Account as TokenAccountState, AccountState, Mint as MintState,
};
use issuer_forge::constants::{
    FREEZE_SEED, HOLDER_SEED, ISSUER_SEED, MAX_MEMBERS, TOKEN_SEED, VELOCITY_SEED,
};
use issuer_forge::error::ForgeError;
use issuer_forge::instructions::{FreezeHolderArgs, ThawHolderArgs, UnfreezeHolderArgs};
use issuer_forge::state::{
    case_ref_bytes, delegation, role, ComplianceReason, FreezeRecord, HolderStatus,
    HolderStatusInput, IssuerConfig, Member, TokenConfig, VelocityCounter,
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
const OUTSIDER: u8 = 15;
const PAYER: u8 = 16;
/// A second officer: lifting a freeze is not reserved to the one who set it.
const OFFICER_B: u8 = 17;
const OPERATOR: u8 = 90;

/// The holder under investigation: onboarded, thawed, holding funds.
const SUSPECT: u8 = 21;
/// A counterparty: onboarded and thawed.
const COUNTERPARTY: u8 = 22;
/// A holder whose account nobody has onboarded yet — frozen by default.
const NEWCOMER: u8 = 23;

const NOW: i64 = 1_800_000_000;
const DECIMALS: u8 = 6;
const BALANCE: u64 = 500_000_000;
const SOL: u64 = 1_000_000_000;

/// Token-2022's `TokenError::AccountFrozen`: the refusal FR-014 rests on.
const ACCOUNT_FROZEN: u32 = 17;

fn wallet(seed: u8) -> AnchorPubkey {
    AnchorPubkey::new_from_array([seed; 32])
}

/// A token account's address. Not an ATA: nothing here derives one, and the
/// token program does not care what the address is.
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
    reason(4, b"FIU-NG/2026/004117")
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

/// Token-2022 state packed with the anchor-side types, owned by mollusk's
/// Token-2022. The base layouts are what an extension-less mint and account
/// are, byte for byte.
fn token_owned<T: Pack>(value: T) -> Account {
    let mut data = vec![0u8; T::LEN];
    T::pack(value, &mut data).expect("a packable token state");
    Account {
        lamports: SOL,
        data,
        owner: token2022::ID,
        executable: false,
        rent_epoch: 0,
    }
}

fn token_account(owner: u8, mint: AnchorPubkey, amount: u64, state: AccountState) -> Account {
    token_owned(TokenAccountState {
        mint,
        owner: wallet(owner),
        amount,
        delegate: COption::None,
        state,
        is_native: COption::None,
        delegated_amount: 0,
        close_authority: COption::None,
    })
}

fn onboarded_status(mint: AnchorPubkey, holder: u8, bump: u8) -> HolderStatus {
    HolderStatus {
        mint,
        wallet: wallet(holder),
        tier: 2,
        jurisdiction: *b"NG",
        denied: false,
        expires_at: 0,
        updated_at: NOW - 86_400,
        bump,
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
            (OFFICER_B, role::COMPLIANCE),
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
            operational_key: wallet(OPERATOR),
            // Everything the operational key can ever hold. The freeze must
            // stay out of its reach even so — there is nothing to delegate it
            // with.
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

        let mint_account = token_owned(MintState {
            mint_authority: COption::Some(token_config),
            supply: 2 * BALANCE,
            decimals: DECIMALS,
            is_initialized: true,
            freeze_authority: COption::Some(token_config),
        });

        let mut mollusk = Mollusk::new(&sol(&program_id), "issuer_forge");
        token2022::add_program(&mut mollusk);
        mollusk.sysvars.clock.unix_timestamp = NOW;

        let mut accounts = vec![
            (sol(&issuer_config), stored(&issuer, SOL)),
            (sol(&token_config), stored(&token, SOL)),
            (sol(&mint), mint_account),
            (
                sol(&token_account_of(SUSPECT)),
                token_account(SUSPECT, mint, BALANCE, AccountState::Initialized),
            ),
            (
                sol(&token_account_of(COUNTERPARTY)),
                token_account(COUNTERPARTY, mint, BALANCE, AccountState::Initialized),
            ),
            (
                sol(&token_account_of(NEWCOMER)),
                token_account(NEWCOMER, mint, 0, AccountState::Frozen),
            ),
            (sol(&wallet(PAYER)), funded(100 * SOL)),
        ];

        // The suspect is onboarded: both status accounts exist, as
        // `thaw_holder` left them. The newcomer is not.
        for (holder, onboarded) in [(SUSPECT, true), (NEWCOMER, false)] {
            let (status, status_bump) = AnchorPubkey::find_program_address(
                &[HOLDER_SEED, mint.as_ref(), wallet(holder).as_ref()],
                &program_id,
            );
            let (velocity, velocity_bump) = AnchorPubkey::find_program_address(
                &[VELOCITY_SEED, mint.as_ref(), wallet(holder).as_ref()],
                &program_id,
            );
            if onboarded {
                accounts.push((
                    sol(&status),
                    stored(&onboarded_status(mint, holder, status_bump), SOL),
                ));
                let counter = VelocityCounter {
                    mint,
                    wallet: wallet(holder),
                    window_start: 0,
                    spent_in_window: 0,
                    bump: velocity_bump,
                };
                accounts.push((sol(&velocity), stored(&counter, SOL)));
            } else {
                accounts.push((sol(&status), uninitialised()));
                accounts.push((sol(&velocity), uninitialised()));
            }
        }

        for holder in [SUSPECT, COUNTERPARTY, NEWCOMER] {
            accounts.push((sol(&freeze_record_of(holder)), uninitialised()));
        }
        for seed in [
            ADMIN_A,
            ADMIN_B,
            OFFICER,
            OBSERVER,
            OUTSIDER,
            OFFICER_B,
            OPERATOR,
            SUSPECT,
            COUNTERPARTY,
            NEWCOMER,
        ] {
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

    /// Runs one instruction and carries the resulting accounts forward on
    /// success, as `tests/proposal.rs` does.
    fn run(&mut self, instruction: Instruction) -> InstructionResult {
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

    fn token_state(&self, holder: u8) -> TokenAccountState {
        TokenAccountState::unpack(&self.account(&token_account_of(holder)).data)
            .expect("a token account")
    }

    fn record(&self, holder: u8) -> FreezeRecord {
        let data = &self.account(&freeze_record_of(holder)).data;
        FreezeRecord::try_deserialize(&mut &data[..]).expect("a freeze record the program wrote")
    }

    fn record_exists(&self, holder: u8) -> bool {
        !self.account(&freeze_record_of(holder)).data.is_empty()
    }

    // ─── The instructions under test ─────────────────────────────────────────

    fn freeze(&self, officer: u8, holder: u8, reason: ComplianceReason) -> Instruction {
        build(
            issuer_forge::accounts::FreezeHolder {
                issuer_config: self.issuer_config,
                token_config: self.token_config,
                mint: self.mint,
                token_account: token_account_of(holder),
                freeze_record: freeze_record_of(holder),
                payer: wallet(PAYER),
                officer: wallet(officer),
                token_program: spl_token_2022::ID,
                system_program: anchor_lang::system_program::ID,
            },
            issuer_forge::instruction::FreezeHolder {
                args: FreezeHolderArgs { reason },
            },
        )
    }

    fn unfreeze(&self, officer: u8, holder: u8, reason: ComplianceReason) -> Instruction {
        build(
            issuer_forge::accounts::UnfreezeHolder {
                issuer_config: self.issuer_config,
                token_config: self.token_config,
                mint: self.mint,
                token_account: token_account_of(holder),
                freeze_record: freeze_record_of(holder),
                rent_recipient: wallet(PAYER),
                officer: wallet(officer),
                token_program: spl_token_2022::ID,
            },
            issuer_forge::instruction::UnfreezeHolder {
                args: UnfreezeHolderArgs { reason },
            },
        )
    }

    /// The routine thaw, signed by `authority` — the operational key or a member.
    fn thaw(&self, authority: u8, holder: u8, status: Option<HolderStatusInput>) -> Instruction {
        let program_id = issuer_forge::ID;
        let (holder_status, _) = AnchorPubkey::find_program_address(
            &[HOLDER_SEED, self.mint.as_ref(), wallet(holder).as_ref()],
            &program_id,
        );
        let (velocity_counter, _) = AnchorPubkey::find_program_address(
            &[VELOCITY_SEED, self.mint.as_ref(), wallet(holder).as_ref()],
            &program_id,
        );
        build(
            issuer_forge::accounts::ThawHolder {
                issuer_config: self.issuer_config,
                token_config: self.token_config,
                mint: self.mint,
                token_account: token_account_of(holder),
                holder_status,
                velocity_counter,
                payer: wallet(PAYER),
                authority: wallet(authority),
                token_program: spl_token_2022::ID,
                system_program: anchor_lang::system_program::ID,
                freeze_record: freeze_record_of(holder),
            },
            issuer_forge::instruction::ThawHolder {
                args: ThawHolderArgs {
                    wallet: wallet(holder),
                    status,
                },
            },
        )
    }

    /// A transfer straight through the token program, signed by the owner.
    fn transfer(&self, from: u8, to: u8, amount: u64) -> Instruction {
        let instruction = spl_token_2022::instruction::transfer_checked(
            &spl_token_2022::ID,
            &token_account_of(from),
            &self.mint,
            &token_account_of(to),
            &wallet(from),
            &[],
            amount,
            DECIMALS,
        )
        .expect("a transfer instruction");
        Instruction {
            program_id: sol(&instruction.program_id),
            accounts: bridge(&instruction.accounts),
            data: instruction.data,
        }
    }
}

fn freeze_record_of(holder: u8) -> AnchorPubkey {
    AnchorPubkey::find_program_address(
        &[FREEZE_SEED, token_account_of(holder).as_ref()],
        &issuer_forge::ID,
    )
    .0
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

fn first_status() -> HolderStatusInput {
    HolderStatusInput {
        tier: 2,
        jurisdiction: *b"NG",
        denied: false,
        expires_at: 0,
    }
}

// ─── FR-014 ──────────────────────────────────────────────────────────────────

#[test]
fn a_frozen_account_can_neither_send_nor_receive() {
    let mut f = Fixture::new();

    // The control first: the same transfers pass before the freeze, so the
    // refusals below belong to the freeze and to nothing in the setup.
    succeeded(&f.run(f.transfer(SUSPECT, COUNTERPARTY, 1)));
    succeeded(&f.run(f.transfer(COUNTERPARTY, SUSPECT, 1)));

    succeeded(&f.run(f.freeze(OFFICER, SUSPECT, a_reason())));
    assert_eq!(f.token_state(SUSPECT).state, AccountState::Frozen);

    assert_eq!(
        refusal(&f.run(f.transfer(SUSPECT, COUNTERPARTY, 1))),
        ACCOUNT_FROZEN
    );
    assert_eq!(
        refusal(&f.run(f.transfer(COUNTERPARTY, SUSPECT, 1))),
        ACCOUNT_FROZEN
    );
    // The funds stayed where they were: a freeze moves nothing.
    assert_eq!(f.token_state(SUSPECT).amount, BALANCE);
}

#[test]
fn the_freeze_records_who_froze_which_account_and_why() {
    let mut f = Fixture::new();
    succeeded(&f.run(f.freeze(OFFICER, SUSPECT, a_reason())));

    let record = f.record(SUSPECT);
    assert_eq!(record.mint, f.mint);
    assert_eq!(record.token_account, token_account_of(SUSPECT));
    assert_eq!(record.wallet, wallet(SUSPECT));
    assert_eq!(record.officer, wallet(OFFICER));
    assert_eq!(record.payer, wallet(PAYER));
    assert_eq!(record.reason, a_reason());
    assert_eq!(record.frozen_at, NOW);
    assert!(record.was_thawed);
}

#[test]
fn another_officer_lifts_the_freeze_and_the_account_moves_again() {
    let mut f = Fixture::new();
    succeeded(&f.run(f.freeze(OFFICER, SUSPECT, a_reason())));
    let payer_before = f.account(&wallet(PAYER)).lamports;
    let record_rent = f.account(&freeze_record_of(SUSPECT)).lamports;

    succeeded(&f.run(f.unfreeze(OFFICER_B, SUSPECT, reason(9, b"FIU-NG/2026/004117/closed"))));

    assert_eq!(f.token_state(SUSPECT).state, AccountState::Initialized);
    assert!(!f.record_exists(SUSPECT));
    // The rent goes back to whoever paid it, not to the officer who lifted it.
    assert_eq!(
        f.account(&wallet(PAYER)).lamports,
        payer_before + record_rent
    );
    succeeded(&f.run(f.transfer(SUSPECT, COUNTERPARTY, 1)));
}

// ─── The routine thaw stops at the record ────────────────────────────────────

#[test]
fn the_operational_key_cannot_undo_a_freeze_with_a_routine_thaw() {
    let mut f = Fixture::new();

    // The control: before the freeze, the operational key's repeat thaw of
    // this onboarded holder is accepted — it is a no-op on a thawed account.
    succeeded(&f.run(f.thaw(OPERATOR, SUSPECT, None)));

    succeeded(&f.run(f.freeze(OFFICER, SUSPECT, a_reason())));
    // The operational key, and an admin through the same routine path:
    // neither lifts a compliance action.
    for authority in [OPERATOR, ADMIN_A] {
        assert_eq!(
            refusal(&f.run(f.thaw(authority, SUSPECT, None))),
            code(ForgeError::HolderFrozenByOfficer),
            "authority {authority}"
        );
    }
    assert_eq!(f.token_state(SUSPECT).state, AccountState::Frozen);
}

#[test]
fn a_freeze_before_onboarding_holds_through_the_first_thaw() {
    let mut f = Fixture::new();

    // The account is frozen by default; the freeze leaves it so and says so.
    succeeded(&f.run(f.freeze(OFFICER, NEWCOMER, a_reason())));
    assert!(!f.record(NEWCOMER).was_thawed);
    assert_eq!(f.token_state(NEWCOMER).state, AccountState::Frozen);

    // Onboarding is exactly what the freeze stops.
    assert_eq!(
        refusal(&f.run(f.thaw(OPERATOR, NEWCOMER, Some(first_status())))),
        code(ForgeError::HolderFrozenByOfficer)
    );

    // Lifting it returns the account to the queue, not past it: no status
    // exists yet, and a thaw here would skip the step that creates one.
    succeeded(&f.run(f.unfreeze(OFFICER, NEWCOMER, a_reason())));
    assert_eq!(f.token_state(NEWCOMER).state, AccountState::Frozen);

    succeeded(&f.run(f.thaw(OPERATOR, NEWCOMER, Some(first_status()))));
    assert_eq!(f.token_state(NEWCOMER).state, AccountState::Initialized);
}

// ─── Who, and with what ──────────────────────────────────────────────────────

#[test]
fn only_an_officer_freezes() {
    let mut f = Fixture::new();
    for signer in [ADMIN_A, OBSERVER, OPERATOR, OUTSIDER] {
        assert_eq!(
            refusal(&f.run(f.freeze(signer, SUSPECT, a_reason()))),
            code(ForgeError::NotAnOfficer),
            "signer {signer}"
        );
    }
    assert_eq!(f.token_state(SUSPECT).state, AccountState::Initialized);
    assert!(!f.record_exists(SUSPECT));
}

#[test]
fn only_an_officer_lifts_a_freeze() {
    let mut f = Fixture::new();
    succeeded(&f.run(f.freeze(OFFICER, SUSPECT, a_reason())));
    for signer in [ADMIN_A, OBSERVER, OPERATOR, OUTSIDER] {
        assert_eq!(
            refusal(&f.run(f.unfreeze(signer, SUSPECT, a_reason()))),
            code(ForgeError::NotAnOfficer),
            "signer {signer}"
        );
    }
    assert_eq!(f.token_state(SUSPECT).state, AccountState::Frozen);
    assert!(f.record_exists(SUSPECT));
}

#[test]
fn neither_side_goes_through_without_a_reason() {
    let mut f = Fixture::new();

    assert_eq!(
        refusal(&f.run(f.freeze(OFFICER, SUSPECT, reason(0, b"FIU-NG/2026/004117")))),
        code(ForgeError::ReasonCodeMissing)
    );
    assert_eq!(
        refusal(&f.run(f.freeze(OFFICER, SUSPECT, reason(4, b"")))),
        code(ForgeError::CaseReferenceInvalid)
    );
    assert_eq!(f.token_state(SUSPECT).state, AccountState::Initialized);

    succeeded(&f.run(f.freeze(OFFICER, SUSPECT, a_reason())));
    assert_eq!(
        refusal(&f.run(f.unfreeze(OFFICER, SUSPECT, reason(0, b"FIU-NG/2026/004117")))),
        code(ForgeError::ReasonCodeMissing)
    );
    assert_eq!(f.token_state(SUSPECT).state, AccountState::Frozen);
}

#[test]
fn an_account_is_not_frozen_twice() {
    let mut f = Fixture::new();
    succeeded(&f.run(f.freeze(OFFICER, SUSPECT, a_reason())));

    // The second freeze fails on `init` — the record's address is taken —
    // and the first record is left exactly as it was.
    let second = f.run(f.freeze(OFFICER_B, SUSPECT, reason(5, b"ANOTHER-CASE")));
    assert!(!second.program_result.is_ok(), "a second freeze must fail");
    assert_eq!(f.record(SUSPECT).officer, wallet(OFFICER));
    assert_eq!(f.record(SUSPECT).reason, a_reason());
}
