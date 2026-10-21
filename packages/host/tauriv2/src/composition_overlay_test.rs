//! Checks that the DOM overlays of a view surface keep their declared order, insets and visibility on their way to the native surface.

use std::collections::HashMap;

use super::{CompositionPlacement, dom_overlays};
use crate::platform::{DOMOverlay, Insets};

fn placement(name: &str, insets: [f64; 4], visible: bool) -> (String, CompositionPlacement) {
    let [left, top, right, bottom] = insets;
    (
        name.to_string(),
        CompositionPlacement {
            name: name.to_string(),
            left,
            top,
            right,
            bottom,
            visible,
        },
    )
}

// contract: view.overlays.reach-native-in-declared-order
#[test]
fn a_view_overlay_reaches_the_native_surface_in_its_declared_order() {
    // The overlays are declared as the toolbar then the sidebar, and the placements arrive in another order. The
    // native surface receives one entry per declared overlay with its own insets and visibility.
    let names = vec!["toolbar".to_string(), "sidebar".to_string()];
    let overlays: HashMap<String, CompositionPlacement> = HashMap::from([
        placement("sidebar", [0.0, 40.0, 0.0, 0.0], false),
        placement("toolbar", [0.0, 0.0, 0.0, 300.0], true),
    ]);
    assert_eq!(
        dom_overlays(&names, &overlays),
        vec![
            DOMOverlay {
                insets: Insets {
                    left: 0.0,
                    top: 0.0,
                    right: 0.0,
                    bottom: 300.0,
                },
                visible: true,
            },
            DOMOverlay {
                insets: Insets {
                    left: 0.0,
                    top: 40.0,
                    right: 0.0,
                    bottom: 0.0,
                },
                visible: false,
            },
        ],
        "a view overlay does not reach the native surface with its declared insets and visibility"
    );
}
