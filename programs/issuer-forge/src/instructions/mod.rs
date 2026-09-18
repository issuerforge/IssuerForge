pub mod attest_reserve;
pub mod create_token;
pub mod initialize_issuer;
pub mod set_policy;
pub mod thaw_holder;

// `#[program]` needs the glob: along with the context types it also picks up
// the `__client_accounts_*` that `#[derive(Accounts)]` generates. So that two
// `handler`s do not become an ambiguous name, the handlers themselves are
// declared `pub(crate)` — the glob does not see them, and `lib.rs` calls them
// by full path inside the crate.
pub use attest_reserve::*;
pub use create_token::*;
pub use initialize_issuer::*;
pub use set_policy::*;
pub use thaw_holder::*;
