//! The application identifier (docs/spec/projects.md#persistence) names the default configuration folder and the file
//! of the path entry. A build with the dev feature adds .dev, so a debug build that runs beside the installed
//! application does not use its data; a diagnostic release without the feature keeps the release identifier.

/// The identifier of the release build, which is also the bundle identifier. A build with the gpuikit feature
/// serves the GPUI application; every other build serves the Tauri application.
pub const RELEASE_IDENTIFIER: &str = if cfg!(feature = "gpuikit") {
    "app.soksak.gpuikit"
} else {
    "app.soksak.tauri"
};

/// The identifier of this build.
pub fn identity() -> &'static str {
    if cfg!(feature = "dev") {
        if cfg!(feature = "gpuikit") {
            "app.soksak.gpuikit.dev"
        } else {
            "app.soksak.tauri.dev"
        }
    } else {
        RELEASE_IDENTIFIER
    }
}
