use anchor_lang::prelude::*;

use crate::constants::MAX_MEMBERS;

/// Issuer roles (FR-033). A bitmask, because one person is legitimately both
/// an admin and an officer — except the attestor, see `ATTESTOR`.
pub mod role {
    /// Admin: a member of the quorum on actions with funds and configuration changes.
    pub const ADMIN: u8 = 1 << 0;
    /// Compliance officer: freezes an individual account alone (FR-014),
    /// takes part in the quorum on seizure and pause.
    pub const COMPLIANCE: u8 = 1 << 1;
    /// Reserve attestor. FR-024 requires that this key **can do nothing else**,
    /// so the program rejects combining this bit with any other.
    pub const ATTESTOR: u8 = 1 << 2;
    /// An observer with no right to act (FR-033). Exists precisely so that
    /// "console access" does not have to be granted with a role that can do
    /// something.
    pub const OBSERVER: u8 = 1 << 3;

    pub const ALL: u8 = ADMIN | COMPLIANCE | ATTESTOR | OBSERVER;
    /// The roles whose signature counts towards the quorum.
    pub const AUTHORISING: u8 = ADMIN | COMPLIANCE;
}

/// The powers an issuer delegates to the platform's operational key (FR-035).
///
/// The list is closed **in code**, not in configuration: issuance, seizure,
/// pause and policy change are not here and cannot be. That is what makes
/// FR-035a a check rather than a promise — a compromised operational key
/// will not get these rights even from the issuer's owner, because there is
/// nothing to express them with.
pub mod delegation {
    /// Thawing an account after verification (FR-008b2).
    pub const THAW_HOLDER: u8 = 1 << 0;
    /// Updating the issuer's own status registry (FR-008a).
    pub const SET_HOLDER_STATUS: u8 = 1 << 1;
    /// Settling a redemption after the corridor's confirmation (FR-029).
    pub const SETTLE_REDEMPTION: u8 = 1 << 2;

    pub const ALL: u8 = THAW_HOLDER | SET_HOLDER_STATUS | SETTLE_REDEMPTION;
}

/// A row of the authorised membership: a wallet address and its role mask.
///
/// A role is bound to the address, not to the login account (FR-034a): a
/// change of login method does not change the powers, and losing access to
/// the account does not pass the role to another address.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Default, PartialEq, Eq)]
pub struct Member {
    pub wallet: Pubkey,
    pub roles: u8,
}

impl Member {
    pub fn is_empty(&self) -> bool {
        self.roles == 0
    }

    pub fn has(&self, mask: u8) -> bool {
        self.roles & mask != 0
    }
}

/// The issuer configuration. PDA: `["issuer", issuer_id]`.
#[account]
#[derive(InitSpace)]
pub struct IssuerConfig {
    /// The immutable identifier this account's address is derived from. Signs
    /// nothing: its only job is to be the seed that outlives membership
    /// changes.
    pub issuer_id: Pubkey,
    /// A fixed-length membership. The row order matters: the signature bitmap
    /// in `ActionProposal` indexes exactly it, so removing a member must not
    /// shift the rest — the freed slot stays empty.
    pub members: [Member; MAX_MEMBERS],
    /// How many slots are in use. Not equal to the number of non-empty slots
    /// after removals — it is the upper bound for iteration, not a member
    /// count.
    pub member_slots: u8,
    /// The quorum threshold (FR-019). Not below `MIN_QUORUM`.
    pub quorum_n: u8,
    /// The platform's operational key. Moves no money (FR-035a).
    pub operational_key: Pubkey,
    /// What exactly is delegated to it. Revoked with one action (FR-035b).
    pub delegation_mask: u8,
    pub bump: u8,
    /// How many tokens the issuer has issued. The next one gets exactly this
    /// number.
    ///
    /// Not a statistic: the number is in the mint seeds
    /// (`["mint", issuer_id, index]`), i.e. it is the counter that makes the
    /// token address derivable. Through it two concurrent `create_token`s of
    /// the same issuer conflict on the account — and that is right: the
    /// second sees an already taken address instead of creating a twin token.
    ///
    /// Appended at the end of the struct: `IssuerConfig` is created before the
    /// first token, so no offsets in it are baked in anywhere, but the rule
    /// "only at the end" is cheaper to keep always than to remember where it
    /// is needed.
    pub token_count: u32,
}

impl IssuerConfig {
    /// Whether this address has at least one of the named roles.
    pub fn member_has(&self, wallet: &Pubkey, mask: u8) -> bool {
        self.members
            .iter()
            .any(|m| !m.is_empty() && m.wallet == *wallet && m.has(mask))
    }

    /// How many signatures can be collected at all. A quorum larger than this
    /// number would make actions with funds impossible forever.
    pub fn authorising_count(&self) -> u8 {
        self.members
            .iter()
            .filter(|m| !m.is_empty() && m.has(role::AUTHORISING))
            .count() as u8
    }

    /// Whether a specific power is delegated to the operational key.
    pub fn delegates(&self, power: u8) -> bool {
        self.delegation_mask & power == power
    }
}
