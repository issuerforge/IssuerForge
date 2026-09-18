use anchor_lang::prelude::*;

use crate::constants::{RESERVE_SEED, TOKEN_SEED};
use crate::error::ForgeError;
use crate::state::{validate_currency, ReserveAttestation, TokenConfig, CURRENCY_BYTES};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct AttestReserveArgs {
    /// The attested amount in the smallest unit of the reserve currency.
    pub amount: u64,
    pub currency: [u8; CURRENCY_BYTES],
    /// The moment the attestation refers to. Not "now": the attestor attests
    /// the state of the account at a certain time, and the validity period is
    /// counted from exactly that (FR-023).
    pub attested_at: i64,
}

/// Publishing a reserve attestation (FR-021, FR-024, FR-024b, FR-026).
///
/// **Exactly one key signs — the current attestor of this token.** Not a
/// quorum: an attestation allows nothing, it only **narrows** what is
/// allowed. Not the platform's operational key: FR-024 requires that the
/// attestor key can do nothing else, and the operational key can thaw
/// accounts.
///
/// The attestor is stored in `TokenConfig`, not in `IssuerConfig`: an issuer
/// with two tokens legitimately has different attestors for them (FR-024b).
#[derive(Accounts)]
pub struct AttestReserve<'info> {
    #[account(
        mut,
        seeds = [TOKEN_SEED, token_config.mint.as_ref()],
        bump = token_config.bump,
        constraint = token_config.attestor == attestor.key() @ ForgeError::NotTheAttestor,
    )]
    pub token_config: Account<'info, TokenConfig>,

    /// The next record in the sequence. The index comes from the counter, not
    /// from the client: `init` at such an address is impossible twice, so
    /// there is no way to skip a number or overwrite a previous record.
    #[account(
        init,
        payer = payer,
        space = 8 + ReserveAttestation::INIT_SPACE,
        seeds = [
            RESERVE_SEED,
            token_config.mint.as_ref(),
            &token_config.attestation_count.to_le_bytes(),
        ],
        bump,
    )]
    pub attestation: Account<'info, ReserveAttestation>,

    /// The current reserve attestor of this token.
    pub attestor: Signer<'info>,

    /// Anyone pays the rent: paying is not a power.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub(crate) fn handler(ctx: Context<AttestReserve>, args: AttestReserveArgs) -> Result<()> {
    validate_currency(&args.currency)?;
    // The reserve currency must be the token's currency: otherwise "issuance
    // + circulation ≤ attested" would require an exchange rate, and the
    // program does not have one and never will.
    require!(
        args.currency == ctx.accounts.token_config.reserve_currency,
        ForgeError::ReserveCurrencyMismatch
    );

    let now = Clock::get()?.unix_timestamp;
    // An attestation from the future would extend its own validity in advance.
    require!(
        args.attested_at <= now,
        ForgeError::AttestationInTheFuture
    );

    let index = ctx.accounts.token_config.attestation_count;
    let attestation = &mut ctx.accounts.attestation;
    attestation.mint = ctx.accounts.token_config.mint;
    attestation.index = index;
    attestation.amount = args.amount;
    attestation.currency = args.currency;
    attestation.attestor = ctx.accounts.attestor.key();
    attestation.attested_at = args.attested_at;
    attestation.bump = ctx.bumps.attestation;

    // The counter moves last: until this line the previous attestation stays
    // current, so a refusal above does not leave the token without a current
    // reserve.
    ctx.accounts.token_config.attestation_count = index
        .checked_add(1)
        .ok_or(ForgeError::ReserveInsufficient)?;
    Ok(())
}
