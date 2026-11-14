//! Fixture package of the host contract runner tests: a library and a binary built with the same features.

/// The features of this build: `other` with the feature, else `none`.
pub fn features() -> &'static str {
    if cfg!(feature = "other") {
        "other"
    } else {
        "none"
    }
}
