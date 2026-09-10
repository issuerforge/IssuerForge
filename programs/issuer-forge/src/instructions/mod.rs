pub mod attest_reserve;
pub mod create_token;
pub mod initialize_issuer;
pub mod set_policy;
pub mod thaw_holder;

// Глоб потрібен `#[program]`: разом із типами контексту він забирає й
// `__client_accounts_*`, які генерує `#[derive(Accounts)]`. Щоб два `handler`
// не стали неоднозначним ім'ям, самі хендлери оголошені `pub(crate)` — глоб їх
// не бачить, а `lib.rs` кличе їх повним шляхом усередині крейта.
pub use attest_reserve::*;
pub use create_token::*;
pub use initialize_issuer::*;
pub use set_policy::*;
pub use thaw_holder::*;
