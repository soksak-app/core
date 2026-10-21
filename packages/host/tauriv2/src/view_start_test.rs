//! The start values script of a view (docs/spec/native-surfaces.md#view-surfaces): the document-start script sets
//! window.sokSurface to the frozen start values that the page declared for the surface. The same cases run in the Go host.

use serde_json::json;

use super::surface_start_script;
use crate::surfaces::{SurfaceProject, ViewStart, view_origin_directory};

// contract: view.start-values.first-script
#[test]
fn the_start_values_script_freezes_the_start_values_for_the_first_page_script() {
    let start = ViewStart {
        params: Some(json!({"path": "a.md"})),
        origin: Some(json!({"directory": "/work/one"})),
        project: Some(SurfaceProject {
            root: "/work/one".to_string(),
        }),
        declarations: Some(json!({"commands": []})),
    };
    assert_eq!(
        surface_start_script("probe-surface", &start).expect("the origin has its form"),
        r##"window.sokSurface = Object.freeze({"surface":"probe-surface","params":{"path":"a.md"},"origin":Object.freeze({"directory":"/work/one"}),"project":Object.freeze({"root":"/work/one"}),"declarations":Object.freeze({"commands":[]})});"##,
        "the script sets the frozen start values"
    );
}

// A start value that the surface has none of is carried as JSON null, and an origin that records no directory is {directory: null}.
// contract: view.start-values.first-script
#[test]
fn the_start_values_script_carries_absent_values_as_null() {
    let start = ViewStart {
        origin: Some(json!({"directory": null})),
        ..Default::default()
    };
    assert_eq!(
        surface_start_script("probe-surface", &start).expect("the origin has its form"),
        r##"window.sokSurface = Object.freeze({"surface":"probe-surface","params":null,"origin":Object.freeze({"directory":null}),"project":null,"declarations":Object.freeze({})});"##,
        "the script carries the absent values as null"
    );
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
