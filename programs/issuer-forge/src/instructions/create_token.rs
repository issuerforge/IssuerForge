//! Token issuance (FR-001, FR-005, FR-006, FR-022) and writing its metadata.
//!
//! **One transaction makes the token whole.** The mint with five extensions,
//! `TokenConfig`, policy version 1, reserve attestation #0, the founder's
//! account and the initial issuance — all here. There is no intermediate
//! state in which the token already exists but the rule, the reserve or the
//! policy does not yet: the instruction either passed in full or left
//! nothing behind.
//!
//! **The metadata is written by a second transaction, and that is not an
//! oversight.** The budget calculation (`SCRATCHPAD.md`, block T018) gave
//! ~1180 bytes of 1232 before the name and symbol strings: 384 bytes of the
//! policy itself, 14 accounts, two signatures. The name and the URI do not
//! fit — so `create_token` sets a `MetadataPointer` to the mint itself (zero
//! bytes of arguments), and `set_token_metadata` writes the content. The
//! window between the two transactions is safe: all accounts are frozen by
//! default, and a name neither allows nor forbids anything.
use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, CreateAccount, Transfer};
use anchor_spl::associated_token::{self, AssociatedToken};
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::token_2022_extensions::spl_token_metadata_interface::state::TokenMetadata;
use anchor_spl::token_2022_extensions::{
    default_account_state_initialize, metadata_pointer_initialize, permanent_delegate_initialize,
    token_metadata_initialize, transfer_hook_initialize, DefaultAccountStateInitialize,
    MetadataPointerInitialize, PermanentDelegateInitialize, TokenMetadataInitialize,
    TransferHookInitialize,
};
use anchor_spl::token_interface::{
    initialize_mint2, mint_to, thaw_account, InitializeMint2, MintTo, ThawAccount, TokenInterface,
};
use spl_token_2022::extension::{ExtensionType, StateWithExtensions};
use spl_token_2022::state::{AccountState, Mint as MintState};

use crate::constants::{
    FIRST_ATTESTATION_INDEX_LE, FIRST_POLICY_VERSION, FIRST_POLICY_VERSION_LE, HOLDER_SEED,
    ISSUER_SEED, MINT_SEED, POLICY_SEED, RESERVE_SEED, TOKEN_SEED, VELOCITY_SEED,
};
use crate::error::ForgeError;
use crate::reserve::{require_latest, ReserveCheck};
use crate::state::{
    role, validate_currency, HolderStatus, HolderStatusInput, IssuerConfig, PolicyConfig,
    ReserveAttestation, TokenConfig, VelocityCounter, CURRENCY_BYTES, POLICY_CONFIG_LEN,
};

/// The mint extensions. **The list is a contract with the hook, not a set of
/// options.**
///
/// - `TransferHook` — what the project exists for: without it the app checks
///   the rule, not the token.
/// - `DefaultAccountState = Frozen` — an account the issuer did not onboard
///   receives no funds. This is what makes `thaw_holder` meaningful.
/// - `PermanentDelegate` — seizure under an order (FR-017), by quorum and
///   from T027.
/// - `Pausable` — the authoritative pause of circulation (FR-016);
///   `TokenConfig.paused_at` remains a mirror for the screens, not a source
///   of truth.
/// - `MetadataPointer` — points at the mint itself; `set_token_metadata`
///   writes the content.
///
/// The order in the array affects only the account size, and does not even
/// affect that: `try_calculate_account_len` computes a sum, not a sequence.
const MINT_EXTENSIONS: [ExtensionType; 5] = [
    ExtensionType::TransferHook,
    ExtensionType::DefaultAccountState,
    ExtensionType::PermanentDelegate,
    ExtensionType::Pausable,
    ExtensionType::MetadataPointer,
];

/// The ceilings on the metadata strings.
///
/// The bound is not a matter of taste: `token_metadata_initialize`
/// **reallocates the mint**, and the rent for the new size is paid by the
/// caller. Without a ceiling one call could demand a megabyte of rent from
/// an officer's wallet.
const MAX_NAME_LEN: usize = 32;
const MAX_SYMBOL_LEN: usize = 12;
const MAX_URI_LEN: usize = 200;

/// The fee rate ceiling: 100% in basis points (FR-038a).
const MAX_FEE_BPS: u16 = 10_000;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateTokenArgs {
    pub decimals: u8,
    /// The SAS credential of the provider whose attestations this token
    /// accepts, and the schema of those attestations. Both are immutable
    /// parameters (FR-005): their offsets in `TokenConfig` are baked into the
    /// `address_config` of the hook's account list.
    pub attestation_credential: Pubkey,
    pub attestation_schema: Pubkey,
    /// The platform treasury (FR-038).
    pub treasury: Pubkey,
    pub fee_bps: u16,
    /// The reserve attestation validity period, seconds (FR-023b).
    pub attestation_max_age: i64,
    /// The reserve currency, which is also the token's currency.
    pub reserve_currency: [u8; CURRENCY_BYTES],
    /// Policy version 1 in the canonical layout, exactly `RULES_BYTES` bytes.
    pub rules: Vec<u8>,
    /// The initial issuance. Goes through the same reserve check as `mint`
    /// (T038): the program has no other way for tokens to come into
    /// existence.
    pub initial_supply: u64,
    /// The first reserve attestation: the amount and the moment it refers to.
    /// The currency is taken from `reserve_currency` — there are never two
    /// currencies in one transaction.
    pub reserve_amount: u64,
    pub reserve_attested_at: i64,
    /// The founder's status in the issuer's own registry.
    ///
    /// Without it the account the issuance landed on could send nothing: the
    /// hook reads the sender's status on every transfer and treats a missing
    /// record as a refusal (FR-013).
    pub founder_status: HolderStatusInput,
}

/// Token issuance.
///
/// **Exactly two signatures — the founder and the attestor**, and each is
/// needed for its own reason. The founder must be an admin of the
/// membership: a token is not created on behalf of people you are not
/// among, and the platform's operational key never reaches here (FR-035a).
/// The attestor is needed because the first attestation cannot precede the
/// token — its address is derived from the mint — and a token without an
/// attestation would mean an issuance nobody vouched for.
///
/// **There is no quorum here, and that is forced, not a matter of taste.**
/// FR-035 names issuance among the actions that need a quorum, and `mint`
/// (T038) will have one. But a 2-of-N quorum in this transaction costs one
/// more signature and one more key — 96 bytes on top of the 1180 of 1232
/// already used — i.e. a transaction with a quorum simply does not exist
/// without an address lookup table. What is not lost: at the moment of
/// issuance the issuer has no holders, so a quorum would protect only the
/// signers from themselves; further issuance, seizure, pause and policy
/// change do have a quorum.
#[derive(Accounts)]
#[instruction(args: CreateTokenArgs)]
pub struct CreateToken<'info> {
    /// The founder, who is also the rent payer.
    ///
    /// Merged on purpose: a separate payer is a sixteenth account and a
    /// third signature, and there is nowhere to put them. A founder's wallet
    /// without SOL is topped up by the platform before the issuance; in
    /// `set_token_metadata` below the payer is separate again, because there
    /// is room there.
    #[account(mut)]
    pub founder: Signer<'info>,

    /// The reserve attestor of this token. Must be in the issuer's membership
    /// with the attestor role, which under `initialize_issuer` is
    /// incompatible with any other.
    pub attestor: Signer<'info>,

    /// `mut`, because the instruction increments the token counter — the mint
    /// address is derived from it.
    #[account(
        mut,
        seeds = [ISSUER_SEED, issuer_config.issuer_id.as_ref()],
        bump = issuer_config.bump,
    )]
    pub issuer_config: Account<'info, IssuerConfig>,

    /// CHECK: the seeds set the address, the token program writes the
    /// content. There is nothing to type it with: the account does not exist
    /// yet, and `InterfaceAccount<Mint>` would require an initialised mint —
    /// i.e. exactly what this instruction does.
    #[account(
        mut,
        seeds = [MINT_SEED, issuer_config.issuer_id.as_ref(), &issuer_config.token_count.to_le_bytes()],
        bump,
    )]
    pub mint: UncheckedAccount<'info>,

    #[account(
        init,
        payer = founder,
        space = 8 + TokenConfig::INIT_SPACE,
        seeds = [TOKEN_SEED, mint.key().as_ref()],
        bump,
    )]
    pub token_config: Account<'info, TokenConfig>,

    /// Policy version 1. Written with the same `PolicyConfig::write` as all
    /// later versions: two writers would mean two canonicity checks, one of
    /// which would fall behind some day.
    #[account(
        init,
        payer = founder,
        space = POLICY_CONFIG_LEN,
        seeds = [POLICY_SEED, mint.key().as_ref(), FIRST_POLICY_VERSION_LE.as_ref()],
        bump,
    )]
    pub policy_config: AccountLoader<'info, PolicyConfig>,

    /// Attestation #0. The index in the seeds and `init` make the history
    /// immutable without any check on our side (FR-026).
    #[account(
        init,
        payer = founder,
        space = 8 + ReserveAttestation::INIT_SPACE,
        seeds = [RESERVE_SEED, mint.key().as_ref(), FIRST_ATTESTATION_INDEX_LE.as_ref()],
        bump,
    )]
    pub attestation: Account<'info, ReserveAttestation>,

    /// CHECK: the ATA program itself derives and checks the address at
    /// creation — repeating `create_program_address` here would mean paying
    /// for the same check twice. It cannot be created in advance: the mint
    /// does not exist yet.
    #[account(mut)]
    pub founder_token_account: UncheckedAccount<'info>,

    #[account(
        init,
        payer = founder,
        space = 8 + HolderStatus::INIT_SPACE,
        seeds = [HOLDER_SEED, mint.key().as_ref(), founder.key().as_ref()],
        bump,
    )]
    pub holder_status: Account<'info, HolderStatus>,

    #[account(
        init,
        payer = founder,
        space = 8 + VelocityCounter::INIT_SPACE,
        seeds = [VELOCITY_SEED, mint.key().as_ref(), founder.key().as_ref()],
        bump,
    )]
    pub velocity_counter: Account<'info, VelocityCounter>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn create_handler(ctx: Context<CreateToken>, args: CreateTokenArgs) -> Result<()> {
    // The founder is an admin of the membership. This check is FR-035a on
    // this path: the platform's operational key is not in the membership, so
    // it creates no tokens even when compromised.
    require!(
        ctx.accounts
            .issuer_config
            .member_has(&ctx.accounts.founder.key(), role::ADMIN),
        ForgeError::NotAnAdmin
    );
    // The attestor is a member of the membership too, not any key the founder
    // named as the attestor. Otherwise the issuer would vouch for its own
    // reserve itself, simply by signing with a second wallet (FR-024).
    require!(
        ctx.accounts
            .issuer_config
            .member_has(&ctx.accounts.attestor.key(), role::ATTESTOR),
        ForgeError::NotAnAttestorMember
    );

    validate_currency(&args.reserve_currency)?;
    // A zero period would make every attestation expired, including the one
    // created a line below: the token would be issued unfit for issuance.
    require!(
        args.attestation_max_age > 0,
        ForgeError::AttestationMaxAgeInvalid
    );
    require!(args.fee_bps <= MAX_FEE_BPS, ForgeError::FeeRateOutOfRange);

    let now = Clock::get()?.unix_timestamp;
    let mint_key = ctx.accounts.mint.key();
    let config_key = ctx.accounts.token_config.key();
    let token_program = ctx.accounts.token_program.to_account_info();

    let index_bytes = ctx.accounts.issuer_config.token_count.to_le_bytes();
    let mint_signer: &[&[u8]] = &[
        MINT_SEED,
        ctx.accounts.issuer_config.issuer_id.as_ref(),
        &index_bytes,
        &[ctx.bumps.mint],
    ];
    let config_signer: &[&[u8]] = &[TOKEN_SEED, mint_key.as_ref(), &[ctx.bumps.token_config]];

    // ── the mint and its extensions ─────────────────────────────────────────
    // The order is strict and set by the token program: the account, then the
    // extensions, then `initialize_mint2`. An extension initialised after the
    // mint is not initialised at all.
    let space = ExtensionType::try_calculate_account_len::<MintState>(&MINT_EXTENSIONS)?;
    system_program::create_account(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            CreateAccount {
                from: ctx.accounts.founder.to_account_info(),
                to: ctx.accounts.mint.to_account_info(),
            },
            &[mint_signer],
        ),
        Rent::get()?.minimum_balance(space),
        space as u64,
        &token_program.key(),
    )?;

    let extension_accounts = MetadataPointerInitialize {
        token_program_id: token_program.clone(),
        mint: ctx.accounts.mint.to_account_info(),
    };
    // The pointer points at the mint itself: the metadata lives in the same
    // account it describes, so there is no separate account that could be
    // swapped.
    metadata_pointer_initialize(
        CpiContext::new(token_program.clone(), extension_accounts),
        Some(config_key),
        Some(mint_key),
    )?;

    transfer_hook_initialize(
        CpiContext::new(
            token_program.clone(),
            TransferHookInitialize {
                token_program_id: token_program.clone(),
                mint: ctx.accounts.mint.to_account_info(),
            },
        ),
        Some(config_key),
        Some(crate::ID),
    )?;

    default_account_state_initialize(
        CpiContext::new(
            token_program.clone(),
            DefaultAccountStateInitialize {
                token_program_id: token_program.clone(),
                mint: ctx.accounts.mint.to_account_info(),
            },
        ),
        &AccountState::Frozen,
    )?;

    permanent_delegate_initialize(
        CpiContext::new(
            token_program.clone(),
            PermanentDelegateInitialize {
                token_program_id: token_program.clone(),
                mint: ctx.accounts.mint.to_account_info(),
            },
        ),
        &config_key,
    )?;

    // anchor-spl 0.32.1 has no wrapper for `Pausable` — the instruction is
    // built directly. It needs no signature: `initialize` only records who
    // will be able to pause later.
    let pausable = spl_token_2022::extension::pausable::instruction::initialize(
        &token_program.key(),
        &mint_key,
        &config_key,
    )?;
    anchor_lang::solana_program::program::invoke(
        &pausable,
        &[ctx.accounts.mint.to_account_info(), token_program.clone()],
    )?;

    // Both authorities are the `TokenConfig` PDA. No person holds a key that
    // can mint or freeze: everything done with them goes through this
    // program's instructions with their checks.
    initialize_mint2(
        CpiContext::new(
            token_program.clone(),
            InitializeMint2 {
                mint: ctx.accounts.mint.to_account_info(),
            },
        ),
        args.decimals,
        &config_key,
        Some(&config_key),
    )?;

    // ── the token configuration ─────────────────────────────────────────────
    let config = &mut ctx.accounts.token_config;
    config.issuer = ctx.accounts.issuer_config.key();
    config.mint = mint_key;
    config.attestation_credential = args.attestation_credential;
    config.attestation_schema = args.attestation_schema;
    config.attestor = ctx.accounts.attestor.key();
    config.treasury = args.treasury;
    config.policy_version = FIRST_POLICY_VERSION;
    config.fee_bps = args.fee_bps;
    config.attestation_max_age = args.attestation_max_age;
    config.paused_at = 0;
    config.bump = ctx.bumps.token_config;
    config.attestation_count = 1;
    config.reserve_currency = args.reserve_currency;

    {
        let mut policy = ctx.accounts.policy_config.load_init()?;
        policy.write(
            FIRST_POLICY_VERSION,
            mint_key,
            ctx.accounts.founder.key(),
            &args.rules,
            now,
            ctx.bumps.policy_config,
        )?;
    }

    // ── the first attestation and the issuance gate ─────────────────────────
    require!(
        args.reserve_attested_at <= now,
        ForgeError::AttestationInTheFuture
    );
    let attestation = &mut ctx.accounts.attestation;
    attestation.mint = mint_key;
    attestation.index = 0;
    attestation.amount = args.reserve_amount;
    attestation.currency = args.reserve_currency;
    attestation.attestor = ctx.accounts.attestor.key();
    attestation.attested_at = args.reserve_attested_at;
    attestation.bump = ctx.bumps.attestation;

    // Both checks are the same functions as in `mint` (T038). Here they look
    // redundant (the attestation was just created, circulation is known to
    // be zero), and that is exactly why they are here: there must be one way
    // for tokens to come into existence, otherwise "the same" gate will one
    // day split into two.
    require_latest(&ctx.accounts.token_config, &ctx.accounts.attestation)?;
    let supply = {
        let data = ctx.accounts.mint.try_borrow_data()?;
        StateWithExtensions::<MintState>::unpack(&data)?.base.supply
    };
    ReserveCheck {
        attested: args.reserve_amount,
        attested_at: args.reserve_attested_at,
        max_age: args.attestation_max_age,
        supply,
        minting: args.initial_supply,
        now,
    }
    .require_within_reserve()?;

    // ── the founder's account and the initial issuance ──────────────────────
    // **The issuance goes to the issuer's own account, and that is not a
    // simplification.** `mint_to` does not call the hook: tokens minted
    // straight to an address the founder named would land there with no rule
    // check at all. So the initial issuance lands on the wallet that just
    // signed the transaction, and any movement from there is a transfer, and
    // the hook checks it.
    associated_token::create(CpiContext::new(
        ctx.accounts.associated_token_program.to_account_info(),
        associated_token::Create {
            payer: ctx.accounts.founder.to_account_info(),
            associated_token: ctx.accounts.founder_token_account.to_account_info(),
            authority: ctx.accounts.founder.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            token_program: token_program.clone(),
        },
    ))?;

    // The same two accounts `thaw_holder` creates, and they are written
    // through the same single write points. The thaw is duplicated here not
    // for convenience: `DefaultAccountState = Frozen` is already in effect,
    // and the token program rejects `mint_to` onto a frozen account.
    let status = &mut ctx.accounts.holder_status;
    status.mint = mint_key;
    status.wallet = ctx.accounts.founder.key();
    status.bump = ctx.bumps.holder_status;
    status.apply(&args.founder_status, now)?;

    let counter = &mut ctx.accounts.velocity_counter;
    counter.mint = mint_key;
    counter.wallet = ctx.accounts.founder.key();
    counter.bump = ctx.bumps.velocity_counter;

    thaw_account(CpiContext::new_with_signer(
        token_program.clone(),
        ThawAccount {
            account: ctx.accounts.founder_token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            authority: ctx.accounts.token_config.to_account_info(),
        },
        &[config_signer],
    ))?;

    mint_to(
        CpiContext::new_with_signer(
            token_program,
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.founder_token_account.to_account_info(),
                authority: ctx.accounts.token_config.to_account_info(),
            },
            &[config_signer],
        ),
        args.initial_supply,
    )?;

    // The last action: the number is taken only when the token behind it is
    // really created.
    ctx.accounts.issuer_config.token_count = ctx
        .accounts
        .issuer_config
        .token_count
        .checked_add(1)
        .ok_or(ForgeError::TooManyMembers)?;

    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SetTokenMetadataArgs {
    pub name: String,
    pub symbol: String,
    pub uri: String,
}

/// Writing the metadata into the mint itself (FR-001).
///
/// The second issuance transaction. The split is purely budgetary — see the
/// file header — but it had a pleasant consequence too: the payer here is
/// separate again from whoever authorises, as in `initialize_issuer`.
///
/// A repeat call is rejected by the token program: the metadata TLV entry
/// will already exist. Renaming is `token_metadata_update_field` and a
/// separate issuer action, which M1 does not have.
#[derive(Accounts)]
pub struct SetTokenMetadata<'info> {
    #[account(
        seeds = [ISSUER_SEED, issuer_config.issuer_id.as_ref()],
        bump = issuer_config.bump,
    )]
    pub issuer_config: Account<'info, IssuerConfig>,

    #[account(
        seeds = [TOKEN_SEED, token_config.mint.as_ref()],
        bump = token_config.bump,
        constraint = token_config.issuer == issuer_config.key() @ ForgeError::TokenNotFromThisIssuer,
    )]
    pub token_config: Account<'info, TokenConfig>,

    /// CHECK: the mint is checked against `TokenConfig`; the token program reads and writes the content.
    #[account(
        mut,
        constraint = mint.key() == token_config.mint @ ForgeError::HolderAccountMismatch,
    )]
    pub mint: UncheckedAccount<'info>,

    /// Who tops up the rent for the grown mint. Grants no powers.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// An admin of the issuer's membership.
    pub authority: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn set_metadata_handler(
    ctx: Context<SetTokenMetadata>,
    args: SetTokenMetadataArgs,
) -> Result<()> {
    require!(
        ctx.accounts
            .issuer_config
            .member_has(&ctx.accounts.authority.key(), role::ADMIN),
        ForgeError::NotAnAdmin
    );
    require!(
        args.name.len() <= MAX_NAME_LEN
            && args.symbol.len() <= MAX_SYMBOL_LEN
            && args.uri.len() <= MAX_URI_LEN,
        ForgeError::TokenMetadataTooLong
    );

    let mint_key = ctx.accounts.mint.key();
    let token_program = ctx.accounts.token_program.to_account_info();

    // The token program reallocates the mint itself but adds no rent — it
    // expects the lamports to be there already. We have to top them up, and
    // that is exactly why the strings have a ceiling: otherwise the caller
    // would set the realloc size.
    let metadata = TokenMetadata {
        name: args.name.clone(),
        symbol: args.symbol.clone(),
        uri: args.uri.clone(),
        mint: mint_key,
        ..Default::default()
    };
    let grown = ctx
        .accounts
        .mint
        .data_len()
        .saturating_add(metadata.tlv_size_of()?);
    let required = Rent::get()?.minimum_balance(grown);
    let shortfall = required.saturating_sub(ctx.accounts.mint.lamports());
    if shortfall > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.mint.to_account_info(),
                },
            ),
            shortfall,
        )?;
    }

    // The right to change the metadata later stays with the PDA, not with a
    // person: otherwise the "immutable parameters" the wizard shows at
    // issuance (FR-005) would be changed by one key outside any check.
    let config_signer: &[&[u8]] = &[TOKEN_SEED, mint_key.as_ref(), &[ctx.accounts.token_config.bump]];
    token_metadata_initialize(
        CpiContext::new_with_signer(
            token_program.clone(),
            TokenMetadataInitialize {
                program_id: token_program.clone(),
                metadata: ctx.accounts.mint.to_account_info(),
                update_authority: ctx.accounts.token_config.to_account_info(),
                mint_authority: ctx.accounts.token_config.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
            },
            &[config_signer],
        ),
        args.name,
        args.symbol,
        args.uri,
    )?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::program_pack::Pack;

    /// The mint extensions are a contract with the hook: without
    /// `TransferHook` the rule is not enforced, without `DefaultAccountState`
    /// `thaw_holder` makes no sense, without `MetadataPointer` the second
    /// transaction has nowhere to write. The list is checked by count so that
    /// "remove one while at it" fails a test.
    #[test]
    fn the_mint_carries_every_extension_the_product_depends_on() {
        assert!(MINT_EXTENSIONS.contains(&ExtensionType::TransferHook));
        assert!(MINT_EXTENSIONS.contains(&ExtensionType::DefaultAccountState));
        assert!(MINT_EXTENSIONS.contains(&ExtensionType::PermanentDelegate));
        assert!(MINT_EXTENSIONS.contains(&ExtensionType::Pausable));
        assert!(MINT_EXTENSIONS.contains(&ExtensionType::MetadataPointer));
        assert_eq!(MINT_EXTENSIONS.len(), 5);
    }

    /// An account created for such a mint must carry the companion extensions
    /// (`TransferHookAccount`, `PausableAccount`) — otherwise the token
    /// program rejects the transfer before the hook. The ATA program creates
    /// it and derives the list from the mint itself; the test proves there is
    /// something to derive.
    #[test]
    fn the_extensions_require_their_account_side_counterparts() {
        let required = ExtensionType::get_required_init_account_extensions(&MINT_EXTENSIONS);
        assert!(required.contains(&ExtensionType::TransferHookAccount));
        assert!(required.contains(&ExtensionType::PausableAccount));
    }

    /// The mint size is computed from the list, not a constant: an added
    /// extension must not silently fail to fit.
    #[test]
    fn the_mint_account_is_larger_than_a_plain_one() {
        let space = ExtensionType::try_calculate_account_len::<MintState>(&MINT_EXTENSIONS)
            .expect("length is computable");
        assert!(space > MintState::LEN);
    }

    /// The string ceilings exist not for tidiness but because whoever calls
    /// the instruction pays for the mint realloc.
    #[test]
    fn metadata_limits_bound_the_rent_a_single_call_can_demand() {
        let metadata = TokenMetadata {
            name: "x".repeat(MAX_NAME_LEN),
            symbol: "x".repeat(MAX_SYMBOL_LEN),
            uri: "x".repeat(MAX_URI_LEN),
            ..Default::default()
        };
        let size = metadata.tlv_size_of().expect("size is computable");
        // Half a kilobyte is the upper bound on how much the mint grows. The
        // number is deliberately coarse: it guards the order of magnitude, not
        // the bytes.
        assert!(size < 512, "metadata grows the mint by {size} bytes");
    }
}
