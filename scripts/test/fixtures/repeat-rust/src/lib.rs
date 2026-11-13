//! Fixture library of the repeat runner tests.

/// ```
/// assert_eq!(fixture::doc_example(), 1);
/// ```
pub fn doc_example() -> u32 {
    1
}

#[cfg(test)]
mod fixture {
    #[test]
    fn alpha() {}

    #[test]
    fn beta() {
        // Holds the test past its limit, so the runner ends it at the limit.
        std::thread::sleep(std::time::Duration::from_secs(8));
    }

    #[test]
    fn library_case() {}

    #[test]
    fn deployment_target() {
        // The deployment target of the declared build (MACOS_MINIMUM of the Makefile).
        assert_eq!(env!("FIXTURE_DEPLOYMENT_TARGET"), "14.4");
    }

    #[cfg(feature = "diagnostics")]
    #[test]
    fn feature_case() {}
}
