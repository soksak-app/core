//! 이 command line 이 속한 core release 의 version. plugin 의 engines.soksak 과 비교한다. Cargo.toml 의 version 이며
//! scripts/check-versions.mjs 가 다른 manifest 의 version 과 같은지 검사한다.

/// core release 의 version.
pub const CORE_VERSION: &str = env!("CARGO_PKG_VERSION");
