//! The initial issuance at runtime (FR-001, FR-022, FR-038).
//!
//! **What this covers and the unit tests cannot.** `TokenConfig::fee_on`
//! is arithmetic; whether the initial issuance really splits into the
//! founder's account and the treasury's, whether the treasury's account the
//! ATA program creates for a mint born in the same instruction can be thawed
//! and credited, and whether the gate still sees the whole `initial_supply`,
//! only the real Token-2022 and ATA programs can say. `create_token` is run
//! here whole: the mint with its extensions, the configuration, policy
//! version 1, attestation #0 and the issuance, from nothing.
//!
//! **`cargo test` does not rebuild the bytecode** — see `tests/proposal.rs`;
//! the same guard applies here.
use std::path::PathBuf;
use std::sync::Once;

use anchor_lang::prelude::Pubkey as AnchorPubkey;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::token_2022::spl_token_2022::extension::StateWithExtensions;
use anchor_spl::token_2022::spl_token_2022::state::{
    Account as TokenAccountState, AccountState, Mint as MintState,
};
use issuer_forge::constants::{
    FIRST_ATTESTATION_INDEX_LE, FIRST_POLICY_VERSION_LE, HOLDER_SEED, ISSUER_SEED, MAX_MEMBERS,
    MINT_SEED, POLICY_SEED, RESERVE_SEED, TOKEN_SEED, VELOCITY_SEED,
};
use issuer_forge::error::ForgeError;
use issuer_forge::instructions::CreateTokenArgs;
use issuer_forge::rules::layout::{rule_kind, status_source, RULES_BYTES};
use issuer_forge::state::{
    currency_bytes, delegation, role, HolderStatusInput, IssuerConfig, Member, TokenConfig,
};
use mollusk_svm::result::{InstructionResult, ProgramResult};
use mollusk_svm::Mollusk;
use mollusk_svm_programs_token::{associated_token, token2022};
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_program_error::ProgramError;
use solana_pubkey::Pubkey;

// ─── The cast ────────────────────────────────────────────────────────────────

const FOUNDER: u8 = 11;
const ATTESTOR: u8 = 15;
/// The platform's wallet, outside the membership.
const TREASURY: u8 = 94;
const OPERATOR: u8 = 90;

const NOW: i64 = 1_800_000_000;
const DAY: i64 = 24 * 60 * 60;
const MAX_AGE: i64 = 30 * DAY;
const DECIMALS: u8 = 6;
const RESERVE: u64 = 1_000_000_000;
const SOL: u64 = 1_000_000_000;
/// 0.12%, as `state/token.rs` declares it.
const FEE_BPS: u16 = 12;

/// The per-instruction default a client gets without a compute budget
/// instruction — and `buildCreateToken` adds none, there is no room for one.
const DEFAULT_COMPUTE_UNITS: u64 = 200_000;

fn wallet(seed: u8) -> AnchorPubkey {
    AnchorPubkey::new_from_array([seed; 32])
}

fn sol(key: &AnchorPubkey) -> Pubkey {
    Pubkey::new_from_array(key.to_bytes())
}

/// The issuer's own register only, any tier — the policy is not what this
/// file tests.
fn open_rules() -> Vec<u8> {
    let mut bytes = vec![0u8; RULES_BYTES];
    bytes[0] = rule_kind::STATUS;
    bytes[2] = status_source::REGISTER;
    bytes
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

fn pda(seeds: &[&[u8]]) -> AnchorPubkey {
    AnchorPubkey::find_program_address(seeds, &issuer_forge::ID).0
}

fn token_account_of(owner: &AnchorPubkey, mint: &AnchorPubkey) -> AnchorPubkey {
    get_associated_token_address_with_program_id(owner, mint, &spl_token_2022::ID)
}

struct Fixture {
    mollusk: Mollusk,
    accounts: Vec<(Pubkey, Account)>,
    issuer_config: AnchorPubkey,
    mint: AnchorPubkey,
}

impl Fixture {
    /// An issuer with a founder (admin) and an attestor, no token yet.
    fn new() -> Self {
        locate_artifact();

        let program_id = issuer_forge::ID;
        let issuer_id = wallet(99);
        let (issuer_config, issuer_bump) =
            AnchorPubkey::find_program_address(&[ISSUER_SEED, issuer_id.as_ref()], &program_id);
        let mint = pda(&[MINT_SEED, issuer_id.as_ref(), &0u32.to_le_bytes()]);

        let mut members = [Member::default(); MAX_MEMBERS];
        members[0] = Member {
            wallet: wallet(FOUNDER),
            roles: role::ADMIN,
        };
        members[1] = Member {
            wallet: wallet(ATTESTOR),
            roles: role::ATTESTOR,
        };
        let issuer = IssuerConfig {
            issuer_id,
            members,
            member_slots: 2,
            quorum_n: 1,
            operational_key: wallet(OPERATOR),
            delegation_mask: delegation::ALL,
            bump: issuer_bump,
            token_count: 0,
        };

        let mut mollusk = Mollusk::new(&sol(&program_id), "issuer_forge");
        token2022::add_program(&mut mollusk);
        associated_token::add_program(&mut mollusk);
        mollusk.sysvars.clock.unix_timestamp = NOW;

        let mut accounts = vec![
            (sol(&issuer_config), stored(&issuer, SOL)),
            (sol(&wallet(FOUNDER)), funded(100 * SOL)),
            (sol(&wallet(ATTESTOR)), funded(SOL)),
            (sol(&wallet(TREASURY)), uninitialised()),
        ];
        for key in [
            mint,
            pda(&[TOKEN_SEED, mint.as_ref()]),
            pda(&[POLICY_SEED, mint.as_ref(), FIRST_POLICY_VERSION_LE.as_ref()]),
            pda(&[
                RESERVE_SEED,
                mint.as_ref(),
                FIRST_ATTESTATION_INDEX_LE.as_ref(),
            ]),
            pda(&[HOLDER_SEED, mint.as_ref(), wallet(FOUNDER).as_ref()]),
            pda(&[VELOCITY_SEED, mint.as_ref(), wallet(FOUNDER).as_ref()]),
            token_account_of(&wallet(FOUNDER), &mint),
            token_account_of(&wallet(TREASURY), &mint),
        ] {
            accounts.push((sol(&key), uninitialised()));
        }
        accounts.push(mollusk_svm::program::keyed_account_for_system_program());
        accounts.push(token2022::keyed_account());
        accounts.push(associated_token::keyed_account());

        Self {
            mollusk,
            accounts,
            issuer_config,
            mint,
        }
    }

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

    fn token_state(&self, owner: u8) -> TokenAccountState {
        StateWithExtensions::<TokenAccountState>::unpack(
            &self
                .account(&token_account_of(&wallet(owner), &self.mint))
                .data,
        )
        .expect("a token account")
        .base
    }

    fn treasury_exists(&self) -> bool {
        !self
            .account(&token_account_of(&wallet(TREASURY), &self.mint))
            .data
            .is_empty()
    }

    fn supply(&self) -> u64 {
        StateWithExtensions::<MintState>::unpack(&self.account(&self.mint).data)
            .expect("a mint")
            .base
            .supply
    }

    fn token_config(&self) -> TokenConfig {
        let data = &self.account(&pda(&[TOKEN_SEED, self.mint.as_ref()])).data;
        TokenConfig::try_deserialize(&mut &data[..]).expect("a token config")
    }

    /// `create_token` as `buildCreateToken` assembles it.
    fn create(&self, fee_bps: u16, initial_supply: u64, treasury: u8) -> Instruction {
        self.create_paying(
            fee_bps,
            initial_supply,
            treasury,
            token_account_of(&wallet(treasury), &self.mint),
        )
    }

    fn create_paying(
        &self,
        fee_bps: u16,
        initial_supply: u64,
        treasury: u8,
        treasury_account: AnchorPubkey,
    ) -> Instruction {
        let mint = self.mint;
        let accounts = issuer_forge::accounts::CreateToken {
            founder: wallet(FOUNDER),
            attestor: wallet(ATTESTOR),
            issuer_config: self.issuer_config,
            mint,
            token_config: pda(&[TOKEN_SEED, mint.as_ref()]),
            policy_config: pda(&[POLICY_SEED, mint.as_ref(), FIRST_POLICY_VERSION_LE.as_ref()]),
            attestation: pda(&[
                RESERVE_SEED,
                mint.as_ref(),
                FIRST_ATTESTATION_INDEX_LE.as_ref(),
            ]),
            founder_token_account: token_account_of(&wallet(FOUNDER), &mint),
            holder_status: pda(&[HOLDER_SEED, mint.as_ref(), wallet(FOUNDER).as_ref()]),
            velocity_counter: pda(&[VELOCITY_SEED, mint.as_ref(), wallet(FOUNDER).as_ref()]),
            treasury: wallet(treasury),
            treasury_account,
            token_program: spl_token_2022::ID,
            associated_token_program: anchor_spl::associated_token::ID,
            system_program: anchor_lang::system_program::ID,
        };
        let data = issuer_forge::instruction::CreateToken {
            args: CreateTokenArgs {
                decimals: DECIMALS,
                attestation_credential: wallet(91),
                attestation_schema: wallet(92),
                fee_bps,
                attestation_max_age: MAX_AGE,
                reserve_currency: currency_bytes(b"NGN"),
                rules: open_rules(),
                initial_supply,
                reserve_amount: RESERVE,
                reserve_attested_at: NOW - DAY,
                founder_status: HolderStatusInput {
                    tier: 3,
                    jurisdiction: *b"NG",
                    denied: false,
                    expires_at: 0,
                },
            },
        };
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
}

fn fee_on(amount: u64, fee_bps: u16) -> u64 {
    (u128::from(amount) * u128::from(fee_bps)).div_ceil(10_000) as u64
}

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

// ─── FR-038: the initial issuance pays the fee ───────────────────────────────

#[test]
fn the_initial_issuance_pays_the_fee_into_the_treasury() {
    let mut f = Fixture::new();
    let result = f.run(f.create(FEE_BPS, RESERVE, TREASURY));
    succeeded(&result);

    let fee = fee_on(RESERVE, FEE_BPS);
    assert!(fee > 0);
    assert_eq!(f.token_state(FOUNDER).amount, RESERVE - fee);
    let treasury = f.token_state(TREASURY);
    assert_eq!(treasury.amount, fee);
    assert_eq!(treasury.owner, wallet(TREASURY));
    // Thawed: `DefaultAccountState = Frozen` would otherwise lock the fee in.
    assert_eq!(treasury.state, AccountState::Initialized);
    assert_eq!(f.supply(), RESERVE);
    assert_eq!(f.token_config().treasury, wallet(TREASURY));
    assert_eq!(f.token_config().fee_bps, FEE_BPS);
}

/// The whole `initial_supply` is what the gate sees (FR-038b): the fee is cut
/// from it, so one unit past the reserve is refused even though the founder
/// would receive less than the reserve.
#[test]
fn the_reserve_covers_the_fee_on_the_initial_issuance_as_well() {
    let mut f = Fixture::new();
    let beyond = f.run(f.create(FEE_BPS, RESERVE + 1, TREASURY));
    assert_eq!(refusal(&beyond), code(ForgeError::ReserveInsufficient));
    assert!(!f.treasury_exists());
}

#[test]
fn a_zero_rate_creates_no_treasury_account() {
    let mut f = Fixture::new();
    succeeded(&f.run(f.create(0, RESERVE, TREASURY)));

    assert_eq!(f.token_state(FOUNDER).amount, RESERVE);
    assert!(!f.treasury_exists());
    assert_eq!(f.token_config().treasury, wallet(TREASURY));
}

/// The one way the treasury's account exists before the fee: the treasury is
/// the founder, and the account is the one just created and thawed.
#[test]
fn a_founder_who_is_the_treasury_receives_the_whole_issuance_in_one_account() {
    let mut f = Fixture::new();
    succeeded(&f.run(f.create(FEE_BPS, RESERVE, FOUNDER)));

    assert_eq!(f.token_state(FOUNDER).amount, RESERVE);
    assert_eq!(f.supply(), RESERVE);
}

#[test]
fn a_treasury_account_off_the_associated_address_is_refused() {
    let mut f = Fixture::new();
    let elsewhere = token_account_of(&wallet(OPERATOR), &f.mint);
    f.accounts.push((sol(&elsewhere), uninitialised()));

    let result = f.run(f.create_paying(FEE_BPS, RESERVE, TREASURY, elsewhere));
    assert_eq!(refusal(&result), code(ForgeError::TreasuryAccountMismatch));
}

/// The fee's account creation, thaw and second `mint_to` are the heaviest
/// thing added to the heaviest instruction; it must still fit the default
/// budget, since the transaction has no room for a compute budget
/// instruction.
#[test]
fn the_issuance_with_a_fee_fits_the_default_compute_budget() {
    let mut f = Fixture::new();
    let result = f.run(f.create(FEE_BPS, RESERVE, TREASURY));
    succeeded(&result);
    println!(
        "create_token with a fee: {} CU",
        result.compute_units_consumed
    );
    assert!(result.compute_units_consumed < DEFAULT_COMPUTE_UNITS);
}
