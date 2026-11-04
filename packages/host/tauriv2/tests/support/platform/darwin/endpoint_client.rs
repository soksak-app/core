//! The endpoint client of the integration tests on macOS: a connection to the unix socket of an endpoint whose reads have a time
//! limit, so a test whose endpoint does not answer fails instead of waiting.

use std::os::unix::net::UnixStream;
use std::time::Duration;

/// Connects to the endpoint socket at address. A read that receives no byte within read_timeout fails.
pub fn connect(address: &str, read_timeout: Duration) -> UnixStream {
    let stream = UnixStream::connect(address)
        .unwrap_or_else(|error| panic!("cannot connect to {address}: {error}"));
    stream
        .set_read_timeout(Some(read_timeout))
        .unwrap_or_else(|error| panic!("cannot set the read timeout of {address}: {error}"));
    stream
}
