//! The fault injection point of the sample of a stall. It is compiled only with the diagnostics feature; a build without it has
//! the no-op counterpart in stall_fault_release.rs.

use std::fs::File;
use std::io;

/// The fault injection point of the sample of a stall. Its value is the path of a FIFO: the sample of the stall does not start
/// until the FIFO has a writer and ends its wait when the writer closes the FIFO, so a sample lasts as long as the check holds
/// the FIFO, as the sample of a loaded system lasts for seconds. docs/operations/examples.md#test-kinds
const FAULT_STALL_SAMPLE: &str = "SOKSAK_FAULT_STALL_SAMPLE";

/// Holds the sample of a stall until the writer of the FIFO that the fault point names closes it, and returns Ok at once when
/// the point is not set.
pub(super) fn sample_fault() -> Result<(), String> {
    let Some(path) = std::env::var_os(FAULT_STALL_SAMPLE).filter(|path| !path.is_empty()) else {
        return Ok(());
    };
    let mut file = File::open(&path).map_err(|error| format!("{FAULT_STALL_SAMPLE}: {error}"))?;
    io::copy(&mut file, &mut io::sink())
        .map(|_| ())
        .map_err(|error| format!("{FAULT_STALL_SAMPLE}: {error}"))
}
