//! Adapter capability registry.
//!
//! Every core capability must be reachable from the Rust CLI and from the
//! desktop adapter. Console commands are the desktop mapping until a capability
//! gets a dedicated UI action; the in-process console reaches the same router.

mod query;
mod registry;
mod types;
mod validation;

pub use query::*;
pub use registry::*;
pub use types::*;
pub use validation::*;

#[cfg(test)]
mod tests;
