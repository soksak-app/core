//! The endpoint client of the integration tests on macOS: a connection to the unix socket of an endpoint. A read has no time
//! limit: the answer of the endpoint or the end of its connection ends it.

use std::os::unix::net::UnixStream;

/// A connection to the endpoint.
pub type Connection = UnixStream;

/// Connects to the endpoint socket at address.
pub fn connect(address: &str) -> Connection {
    UnixStream::connect(address)
        .unwrap_or_else(|error| panic!("cannot connect to {address}: {error}"))
}
