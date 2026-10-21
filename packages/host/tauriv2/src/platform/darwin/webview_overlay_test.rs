//! Checks the values that a view surface sends to the native overlay mask: five per overlay, in the order of the native call.

use super::overlay_values;
use crate::platform::{DOMOverlay, Insets};

#[test]
fn a_view_overlay_sends_its_insets_and_visibility_to_the_native_mask() {
    // The native call reads the left, top, right and bottom insets and a visibility flag per overlay. A hidden overlay
    // sends 0 and a visible one sends 1, so the native mask cuts the plane only for a visible overlay.
    let overlays = [
        DOMOverlay {
            insets: Insets {
                left: 1.0,
                top: 2.0,
                right: 3.0,
                bottom: 4.0,
            },
            visible: true,
        },
        DOMOverlay {
            insets: Insets {
                left: 5.0,
                top: 6.0,
                right: 7.0,
                bottom: 8.0,
            },
            visible: false,
        },
    ];
    assert_eq!(
        overlay_values(&overlays),
        vec![1.0, 2.0, 3.0, 4.0, 1.0, 5.0, 6.0, 7.0, 8.0, 0.0],
        "a view overlay does not reach the native mask with its insets and visibility"
    );
}
