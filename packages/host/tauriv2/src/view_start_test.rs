//! The start values script of a view (docs/spec/native-surfaces.md#view-surfaces): the document-start script sets
//! window.sokSurface to the frozen start values that the page declared for the surface. The same cases run in the Go host.

use serde_json::json;

use super::surface_start_script;
use crate::surfaces::{ViewStart, view_origin_directory};

// contract: view.start-values.first-script
#[test]
fn the_start_values_script_freezes_the_start_values_for_the_first_page_script() {
    let start: ViewStart = serde_json::from_value(json!({
        "params": {"path": "a.md"},
        "origin": {"directory": "/work/one"},
        "project": {"id": "prj-one", "root": "/work/one"},
        "declarations": {"commands": []},
        "diagnostics": {"module": "ui/probe-diagnostics.js", "exposes": {}},
        "section": {"card": "c3", "id": "files.tree", "sidebar": "c3:right"},
    }))
    .expect("the start values have their form");
    assert_eq!(
        surface_start_script("probe-surface", &start).expect("the origin has its form"),
        r##"window.sokSurface = Object.freeze({"surface":"probe-surface","params":{"path":"a.md"},"origin":Object.freeze({"directory":"/work/one"}),"project":Object.freeze({"id":"prj-one","root":"/work/one"}),"declarations":Object.freeze({"commands":[]}),"diagnostics":Object.freeze({"exposes":{},"module":"ui/probe-diagnostics.js"}),"section":Object.freeze({"card":"c3","id":"files.tree","sidebar":"c3:right"})});"##,
        "the script sets the frozen start values"
    );
}

// A start value that the surface has none of is carried as JSON null, and an origin that records no directory is {directory: null}.
// contract: view.start-values.first-script
#[test]
fn the_start_values_script_carries_absent_values_as_null() {
    let start: ViewStart = serde_json::from_value(json!({
        "origin": {"directory": null},
        "diagnostics": null,
        "section": null,
    }))
    .expect("the start values have their form");
    assert_eq!(
        surface_start_script("probe-surface", &start).expect("the origin has its form"),
        r##"window.sokSurface = Object.freeze({"surface":"probe-surface","params":null,"origin":Object.freeze({"directory":null}),"project":null,"declarations":Object.freeze({}),"diagnostics":null,"section":null});"##,
        "the script carries the absent values as null"
    );
}

// A start value script whose section is absent is refused, after the origin and the diagnostic declaration.
// contract: view.start-values.refuses-a-missing-section
#[test]
fn the_start_values_script_refuses_a_missing_section() {
    let start: ViewStart = serde_json::from_value(json!({
        "origin": {"directory": null},
        "diagnostics": null,
    }))
    .expect("the start values have their form");
    assert_eq!(
        surface_start_script("probe-surface", &start),
        Err(r#"surface "probe-surface": view start section is missing"#.to_string()),
        "the script names the missing section"
    );
}

// A start value script whose section is neither null nor an object with exactly a non-empty id, a non-empty sidebar and a card
// that is a non-empty text or null is refused with its reason.
// contract: view.start-values.refuses-a-section-of-another-form
#[test]
fn the_start_values_script_refuses_a_section_of_another_form() {
    let text = r#"surface "probe-surface": view start section is not {id, sidebar, card}"#;
    for section in [
        json!([]),
        json!("left/files.tree"),
        json!({"id": "files.tree", "sidebar": "left"}),
        json!({"id": "", "sidebar": "left", "card": null}),
        json!({"id": "files.tree", "sidebar": "left", "card": ""}),
        json!({"id": "files.tree", "sidebar": "left", "card": null, "name": "Files"}),
    ] {
        let start: ViewStart = serde_json::from_value(json!({
            "origin": {"directory": null},
            "diagnostics": null,
            "section": section,
        }))
        .expect("the start values have their form");
        assert_eq!(
            surface_start_script("probe-surface", &start),
            Err(text.to_string()),
            "the section {section} is refused"
        );
    }
}

// A start value script without an origin is refused; the host never builds one with a null directory in its place.
// contract: view.start-values.refuses-a-missing-origin
#[test]
fn the_start_values_script_refuses_a_missing_origin() {
    assert_eq!(
        surface_start_script("probe-surface", &ViewStart::default()),
        Err(r#"surface "probe-surface": view start origin is missing"#.to_string()),
        "the script names the missing origin"
    );
}

// The origin directory is an absolute path in the one local form: a relative path, the // and /<letter>: prefixes and a NUL
// byte are refused with the same text, and an absolute local path is accepted.
#[test]
// contract: view.start-values.refuses-a-missing-origin
fn the_origin_directory_refuses_a_path_that_is_not_local_absolute() {
    let text = r#"surface "probe-surface": view start origin directory is not an absolute path"#;
    for path in ["relative", "C:\\x", "/C:/x", "//server/share", "a\u{0}b"] {
        assert_eq!(
            view_origin_directory("probe-surface", Some(&json!({"directory": path}))),
            Err(text.to_string()),
            "the directory {path:?} is refused as not absolute"
        );
    }
    assert_eq!(
        view_origin_directory("probe-surface", Some(&json!({"directory": "/a"}))),
        Ok(Some("/a".to_string())),
        "an absolute local directory is accepted"
    );
}
