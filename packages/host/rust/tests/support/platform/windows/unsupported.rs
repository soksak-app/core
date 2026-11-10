//! The endpoint client of the integration tests on Windows, which has no endpoint: a connection fails its test.

use std::fs::File;

/// The type of a connection, which no call produces on Windows.
pub type Connection = File;

/// Fails the test: the endpoint is not supported on Windows.
pub fn connect(_address: &str) -> Connection {
    panic!("connect is not supported on Windows")
}
