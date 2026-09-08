//! Transfer hook: перелік акаунтів, читання атестації провайдера й сам `Execute`.
//!
//! Тут немає жодного правила — вони в `rules/`. Тут є те, як хук дістає факти:
//! які акаунти приходять (`extra_accounts`), як прочитати чуже джерело
//! (`attestation`) і як із прочитаного скласти контекст (`execute`).
pub mod attestation;
pub mod execute;
pub mod extra_accounts;

pub use execute::*;
pub use extra_accounts::*;
