//! The start values script of a view (docs/spec/native-surfaces.md#view-surfaces): the document-start script sets
//! window.sokSurface to the frozen start values that the page declared for the surface. The same cases run in the Go host.

use serde_json::json;

use super::surface_start_script;
use crate::surfaces::{SurfaceOrigin, SurfaceProject, ViewStart};

// contract: view.start-values.first-script
#[test]
fn the_start_values_script_freezes_the_start_values_for_the_first_page_script() {
    let start = ViewStart {
        params: Some(json!({"path": "a.md"})),
        origin: Some(SurfaceOrigin {
            directory: Some("/work/one".to_string()),
        }),
        project: Some(SurfaceProject {
            root: "/work/one".to_string(),
        }),
        declarations: Some(json!({"commands": []})),
    };
    assert_eq!(
        surface_start_script("probe-surface", &start),
        r##"window.sokSurface = Object.freeze({"surface":"probe-surface","params":{"path":"a.md"},"origin":Object.freeze({"directory":"/work/one"}),"project":Object.freeze({"root":"/work/one"}),"declarations":Object.freeze({"commands":[]})});"##,
        "the script sets the frozen start values"
    );
}

// A start value that the surface has none of is carried as JSON null.
// contract: view.start-values.first-script
#[test]
fn the_start_values_script_carries_absent_values_as_null() {
    assert_eq!(
        surface_start_script("probe-surface", &ViewStart::default()),
        r##"window.sokSurface = Object.freeze({"surface":"probe-surface","params":null,"origin":Object.freeze({"directory":null}),"project":null,"declarations":Object.freeze({})});"##,
        "the script carries the absent values as null"
    );
}
