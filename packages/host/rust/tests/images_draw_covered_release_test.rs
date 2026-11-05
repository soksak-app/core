//! Checks that a build without diagnostics never makes the regions of a covered window draw
//! (docs/spec/native-surfaces.md#image-regions). The setter of that state is not compiled in such a build.

#[path = "support/drawing.rs"]
mod drawing;

use drawing::{DrawingStep, attached_drawing_image, drawing_values};
use soksak_host::images::Images;

// contract: image.drawing.covered-window-never-draws-without-diagnostics
#[cfg(not(feature = "diagnostics"))]
#[test]
fn a_build_without_diagnostics_cannot_draw_a_covered_window() {
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
            "hidden surface while occluded",
            Box::new(|| images.set_surface_visible(&key.0, false)),
            vec!["view=false hidden"],
        ),
        (
            "shown surface while occluded",
            Box::new(|| images.set_surface_visible(&key.0, true)),
            vec!["view=false"],
        ),
        (
            "window on screen",
            Box::new(|| images.set_on_screen(true)),
            vec!["view=true"],
        ),
    ];
    for (name, change, want) in steps {
        change();
        assert_eq!(drawing_values(images.drawing_changes()), want, "{name}");
    }
}
