// The issuer-forge program: policy as data, a quorum on actions with funds,
// an issuance gate by reserve, a redemption escrow and the transfer hook that
// enforces all of it. The instructions are filled in during Phase 4 —
// contents and order in docs/TASKS.md.
//
// One program for all issuers (docs/PLAN.md → "Architecture"): there is no
// per-issuer deploy, there is a set of PDAs. That is what makes FR-003
// possible.
use anchor_lang::prelude::*;
use spl_discriminator::SplDiscriminate;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

pub mod authority;
pub mod constants;
pub mod error;
pub mod hook;
pub mod instructions;
pub mod quorum;
pub mod reserve;
pub mod rules;
pub mod state;

use hook::*;
use instructions::*;

declare_id!("DLkwvpN7EjtXLiXJFMiibLf7NXgFFFTBCmMcFvKgsGe5");

#[program]
pub mod issuer_forge {
    use super::*;

    /// Creates an issuer: the authorised membership, the quorum threshold and
    /// the bounds within which the platform's operational key may act
    /// (FR-019a, FR-033, FR-035).
    ///
    /// The only issuer action that does not go through the quorum — because
    /// before it there is no quorum yet. Everything it sets is changed from
    /// then on **only** by quorum.
    pub fn initialize_issuer(
        ctx: Context<InitializeIssuer>,
        args: InitializeIssuerArgs,
    ) -> Result<()> {
        instructions::initialize_issuer::handler(ctx, args)
    }

    /// Issues a token: the mint with its extensions, the configuration, policy
    /// version 1, the first reserve attestation and the initial issuance — all
    /// in one transaction (FR-001, FR-005, FR-006, FR-022).
    ///
    /// Two signatures — the founder-admin and the attestor. The first cannot
    /// issue a token without the second, because the issuance goes through
    /// the reserve gate, and the gate has nothing to read until an
    /// attestation exists; the second can do nothing alone, because the
    /// attestor role is incompatible with any other.
    pub fn create_token(ctx: Context<CreateToken>, args: CreateTokenArgs) -> Result<()> {
        instructions::create_token::create_handler(ctx, args)
    }

    /// Writes the metadata into the mint itself (FR-001).
    ///
    /// A separate transaction from the issuance: the name, symbol and URI do
    /// not fit into a transaction that already carries 384 bytes of policy
    /// and 14 accounts. The metadata pointer on the mint is set by
    /// `create_token`, so there is nowhere to write but into the token
    /// itself.
    pub fn set_token_metadata(
        ctx: Context<SetTokenMetadata>,
        args: SetTokenMetadataArgs,
    ) -> Result<()> {
        instructions::create_token::set_metadata_handler(ctx, args)
    }

    /// Writes the next policy version and moves the token onto it (FR-009,
    /// FR-010).
    ///
    /// The change takes effect without re-issuing the token and without any
    /// action by holders: policy is data, and the hook reads the new version
    /// on the very next transfer. Previous versions stay at their addresses
    /// forever.
    ///
    /// The change is authorised by a quorum of the issuer's wallets (FR-035),
    /// not by the platform's operational key: the signatures are passed in
    /// `remaining_accounts`.
    pub fn set_policy(ctx: Context<SetPolicy>, args: SetPolicyArgs) -> Result<()> {
        instructions::set_policy::handler(ctx, args)
    }

    /// Thaws a holder's account and creates both accounts without which a
    /// transfer is refused: `HolderStatus` and `VelocityCounter` (FR-008b).
    ///
    /// The hook creates no accounts, so they are created here — in advance.
    /// The thaw itself is not a permission to transfer (FR-008b1): the policy
    /// rules are checked on every transfer separately.
    pub fn thaw_holder(ctx: Context<ThawHolder>, args: ThawHolderArgs) -> Result<()> {
        instructions::thaw_holder::thaw_handler(ctx, args)
    }

    /// Updates an address's status in the issuer's own registry (FR-008a,
    /// FR-008b1).
    ///
    /// This instruction is what makes FR-008b1 enforceable: the account stays
    /// thawed, and a transfer from it stops passing the moment the status no
    /// longer satisfies the policy.
    pub fn set_holder_status(
        ctx: Context<SetHolderStatus>,
        args: SetHolderStatusArgs,
    ) -> Result<()> {
        instructions::thaw_holder::set_status_handler(ctx, args)
    }

    /// Publishes a reserve attestation (FR-021, FR-024, FR-026).
    ///
    /// Signed by exactly the current attestor of this token: an attestation
    /// allows nothing, it only narrows what is allowed, which is why it needs
    /// no quorum. The record is append-only — there is nothing to overwrite
    /// it with.
    pub fn attest_reserve(ctx: Context<AttestReserve>, args: AttestReserveArgs) -> Result<()> {
        instructions::attest_reserve::handler(ctx, args)
    }

    /// Creates the `ExtraAccountMetaList` — the list of accounts the token
    /// program will hand to the hook on every transfer (FR-012).
    ///
    /// A separate instruction from the issuance: the list belongs to the hook
    /// interface, not to the mint. The client puts both into one transaction.
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        hook::extra_accounts::handler(ctx)
    }

    /// The transfer hook: the rule check on every transfer (FR-002, FR-011,
    /// FR-012).
    ///
    /// The discriminator is set explicitly: this instruction is called by the
    /// token program through the `spl-transfer-hook-interface`, not by a
    /// client by name, so the eight bytes must be the ones in the interface,
    /// not the ones Anchor would derive from the name.
    #[instruction(discriminator = ExecuteInstruction::SPL_DISCRIMINATOR_SLICE)]
    pub fn execute(ctx: Context<Execute>, amount: u64) -> Result<()> {
        hook::execute::handler(ctx, amount)
    }
}
