//! The transfer hook: the account list, reading the provider attestation and
//! `Execute` itself.
//!
//! There is not a single rule here — they are in `rules/`. What is here is
//! how the hook obtains facts: which accounts arrive (`extra_accounts`), how
//! to read a foreign source (`attestation`) and how to assemble a context
//! from what was read (`execute`).
pub mod attestation;
pub mod execute;
pub mod extra_accounts;

pub use execute::*;
pub use extra_accounts::*;
