//! A main page reload ends the document registrations of each surface, and the view that the reloaded page creates on a
//! surface binds to that surface only. The registrations of the other surfaces keep their surface names, so a press of
//! their view resolves to their own surface.

use super::{Documents, Key, Streams, remove_surface_for_reload};

fn key(surface: &str, name: &str) -> Key {
    (surface.to_string(), name.to_string())
}

// contract: surface.view.reload-keeps-bindings
#[test]
fn a_reload_keeps_each_view_bound_to_its_own_surface() {
    let documents = Documents::default();
    let streams = Streams::default();
    for (surface, handle) in [("first", 710001_usize), ("second", 710002)] {
        documents
            .reserve(&key(surface, "view"))
            .expect("reserve the view of the surface");
        assert!(
            documents.set(&key(surface, "view"), handle),
            "set the view of {surface}"
        );
    }
    remove_surface_for_reload(&documents, &streams, "first");
    // The reloaded page creates the view of the first surface again, with a new address.
    documents
        .reserve(&key("first", "view"))
        .expect("reserve the reloaded view");
    assert!(
        documents.set(&key("first", "view"), 710003),
        "set the reloaded view"
    );
    let names = documents.names();
    let surface_of = |handle: usize| names.get(&handle).map(|key| key.0.clone());
    assert_eq!(
        surface_of(710002).as_deref(),
        Some("second"),
        "the view of the second surface after the reload"
    );
    assert_eq!(
        surface_of(710003).as_deref(),
        Some("first"),
        "the reloaded view of the first surface"
    );
    assert_eq!(
        surface_of(710001),
        None,
        "the old view of the first surface after the reload"
    );
}
