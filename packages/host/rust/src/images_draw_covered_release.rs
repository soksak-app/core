//! A build without diagnostics never draws the regions of a covered window (docs/spec/native-surfaces.md#image-regions).

use super::Inner;

impl Inner {
    /// False: only a diagnostic build makes a covered window draw its regions.
    pub(super) fn draws_covered(&self) -> bool {
        false
    }
}
