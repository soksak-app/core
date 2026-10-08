//! The application identifier (docs/spec/projects.md#persistence) names the default configuration folder and the file
//! of the path entry. A build with the dev feature adds .dev, so a debug build that runs beside the installed
//! application does not use its data; a diagnostic release without the feature keeps the release identifier.

/// release build 의 식별자이며 번들 식별자.
pub const RELEASE_IDENTIFIER: &str = "app.soksak.tauri";

/// 이 build 의 식별자.
pub fn identity() -> &'static str {
    if cfg!(feature = "dev") {
        "app.soksak.tauri.dev"
    } else {
        RELEASE_IDENTIFIER
    }
}
