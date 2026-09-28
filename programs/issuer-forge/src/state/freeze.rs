use anchor_lang::prelude::*;

use crate::state::ComplianceReason;

/// An officer's freeze of one token account. PDA: `["freeze", token_account]`.
///
/// **Why an account at all, when the token account already says `Frozen`.**
/// Because it says the same thing in two situations the program must tell
/// apart: an account that was never thawed (`DefaultAccountState = Frozen`,
/// the onboarding queue) and an account an officer froze. The first is
/// lifted by a routine `thaw_holder`, which the operational key may sign; the
/// second must not be, or a key that FR-035 keeps away from compliance
/// actions would undo one with a routine call. The existence of this account
/// is the difference, and `thaw_holder` refuses while it exists.
///
/// **Keyed by the token account, not by the wallet.** A freeze in Token-2022
/// is a property of one account, and FR-014 speaks of an individual account.
/// A wallet with a second account keeps it; stopping the person as a whole is
/// what `denied` in the status registry is for (FR-008a1), and the hook reads
/// that on every transfer from any of their accounts.
///
/// Closed by `unfreeze_holder`. The named record of who froze it and why does
/// not need this account to survive: it is in the `freeze_holder` instruction
/// itself, which is where the indexer reads every action from.
#[account]
#[derive(InitSpace)]
pub struct FreezeRecord {
    /// The next three duplicate what the seeds and the token account already
    /// say, for the same reason `HolderStatus` does: the console lists an
    /// issuer's frozen accounts with `getProgramAccounts` and a filter by
    /// mint, and a filter cannot be made on seeds.
    pub mint: Pubkey,
    pub token_account: Pubkey,
    /// The token account's owner at the time of the freeze.
    pub wallet: Pubkey,
    /// The officer who froze it.
    pub officer: Pubkey,
    /// Who paid the rent, and so who gets it back.
    pub payer: Pubkey,
    pub reason: ComplianceReason,
    pub frozen_at: i64,
    /// Whether the account was thawed when the officer froze it.
    ///
    /// Lifting the freeze returns the account to where it was, not to
    /// "thawed": an account frozen before it was ever onboarded goes back to
    /// the onboarding queue, and a thaw here would skip the step that creates
    /// its status — the one a transfer is refused without.
    pub was_thawed: bool,
    pub bump: u8,
}
