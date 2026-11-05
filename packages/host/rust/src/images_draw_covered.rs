//! The drawing of the regions of a covered window, which only a diagnostic build has (docs/spec/native-surfaces.md#image-regions).

use super::{Images, Inner};

impl Images {
    /// Makes the regions of the window draw while the window is occluded or minimized, for a check that reads the pixels of a
    /// covered window (docs/spec/native-surfaces.md#image-regions). The window keeps reporting its occlusion.
    pub fn set_draw_covered(&self, draw: bool) {
        let mut inner = self.lock();
        if inner.draw_covered != draw {
            inner.draw_covered = draw;
            self.changed();
        }
    }
}

impl Inner {
    /// Whether the regions of the window draw while it is not on screen.
    pub(super) fn draws_covered(&self) -> bool {
        self.draw_covered
    }
}
