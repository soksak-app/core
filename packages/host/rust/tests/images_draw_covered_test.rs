//! Checks that a diagnostic build makes the regions of a covered window draw (docs/spec/native-surfaces.md#image-regions).

#[path = "support/drawing.rs"]
mod drawing;

use drawing::{DrawingStep, attached_drawing_image, drawing_values};
use soksak_host::images::Images;

// A check that reads the pixels of a covered window asks its regions to draw; the window stays occluded, and a region whose
// surface hides still draws nothing.
// contract: image.drawing.draws-covered-in-diagnostic-builds
#[cfg(feature = "diagnostics")]
#[test]
fn a_region_of_a_covered_window_draws_while_the_window_draws_covered() {
    let images = Images::default();
    let key = attached_drawing_image(&images, "tab-1");
    images.set_visible(&key, true).unwrap();
    assert_eq!(
        drawing_values(images.drawing_changes()),
        vec!["view=true"],
        "placed visible on screen"
    );
    let steps: Vec<DrawingStep> = vec![
        (
            "occluded window",
            Box::new(|| images.set_on_screen(false)),
            vec!["view=false"],
        ),
        (
            "drawn while covered",
            Box::new(|| images.set_draw_covered(true)),
            vec!["view=true"],
        ),
        (
            "hidden surface while drawn covered",
            Box::new(|| images.set_surface_visible(&key.0, false)),
            vec!["view=false hidden"],
        ),
        (
            "shown surface while drawn covered",
            Box::new(|| images.set_surface_visible(&key.0, true)),
            vec!["view=true"],
        ),
        (
            "no longer drawn while covered",
            Box::new(|| images.set_draw_covered(false)),
            vec!["view=false"],
        ),
        (
            "window on screen",
            Box::new(|| images.set_on_screen(true)),
            vec!["view=true"],
        ),
        (
            "drawn covered while on screen",
            Box::new(|| images.set_draw_covered(true)),
            vec![],
        ),
    ];
    for (name, change, want) in steps {
        change();
        assert_eq!(drawing_values(images.drawing_changes()), want, "{name}");
    }
}
