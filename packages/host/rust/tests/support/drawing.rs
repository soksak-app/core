//! Helpers of the tests of the drawing state of image regions (docs/spec/native-surfaces.md#image-regions): they attach a
//! region and render the drawing changes that the host sends to the supplier.
#![allow(dead_code)]

use soksak_host::images::{Drawing, Images, Key};

/// Attaches one image region of sidecar-a and returns its key.
pub fn attached_drawing_image(images: &Images, surface: &str) -> Key {
    let key: Key = (surface.to_string(), "view".to_string());
    images
        .reserve(&key, "owner-a", "sidecar-a")
        .expect("reserve image");
    assert!(images.set(&key, 100), "attach image");
    key
}

/// Reads the drawing changes of a pass whose sends succeed and records each one as sent, as the host does after each
/// successful send.
pub fn sent_drawing_changes(images: &Images) -> Vec<Drawing> {
    let changes = images.drawing_changes();
    for change in &changes {
        images.mark_drawing_sent(change);
    }
    changes
}

/// Gives each drawing change as name=value, followed by the word hidden for a hidden surface.
pub fn drawing_values(changes: Vec<Drawing>) -> Vec<String> {
    changes
        .into_iter()
        .map(|change| {
            let hidden = if change.hidden { " hidden" } else { "" };
            format!("{}={}{hidden}", change.name, change.drawing)
        })
        .collect()
}

/// One step of a drawing test: its name, the change it makes and the drawing changes it expects.
pub type DrawingStep<'a> = (&'static str, Box<dyn Fn() + 'a>, Vec<&'static str>);
