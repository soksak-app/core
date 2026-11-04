//! The version of the core release that this command line belongs to. It is compared with engines.soksak of a plugin. It is the version of Cargo.toml, and
//! scripts/check-versions.mjs checks that it equals the version of the other manifests.

/// The version of the core release.
pub const CORE_VERSION: &str = env!("CARGO_PKG_VERSION");
