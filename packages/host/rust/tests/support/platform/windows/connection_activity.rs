//! The connection activity of the host on Windows, which has no endpoint.

/// Fails the test: the connection activity is not supported on Windows.
pub fn held() -> bool {
    panic!("the connection activity is not supported on Windows")
}
