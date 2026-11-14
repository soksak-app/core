//! A build without diagnostics holds no sample: only a diagnostic build has the stall sample fault injection point.

/// Holds no sample.
pub(super) fn sample_fault() -> Result<(), String> {
    Ok(())
}
