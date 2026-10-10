//! The application identifier (docs/spec/projects.md#persistence) names the default configuration folder and the file
//! of the path entry. A build with the dev feature adds .dev, so a debug build that runs beside the installed
//! application does not use its data; a diagnostic release without the feature keeps the release identifier.

/// The identifier of the release build, which is also the bundle identifier.
pub const RELEASE_IDENTIFIER: &str = "app.soksak.tauri";

/// The identifier of this build.
pub fn identity() -> &'static str {
    if cfg!(feature = "dev") {
        "app.soksak.tauri.dev"
    } else {
        RELEASE_IDENTIFIER
    }
}
