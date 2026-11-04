//! The endpoint client of the integration tests on Windows, which has no endpoint: a connection fails its test.

use std::fs::File;
use std::time::Duration;

/// The type of a connection, which no call produces on Windows.
pub type Connection = File;

/// Fails the test: the endpoint is not supported on Windows.
pub fn connect(_address: &str, _read_timeout: Duration) -> Connection {
    panic!("connect is not supported on Windows")
}
