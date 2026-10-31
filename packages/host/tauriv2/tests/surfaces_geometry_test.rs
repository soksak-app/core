use std::collections::HashMap;

use soksak_host_tauriv2::platform::WindowOverlay;
use soksak_host_tauriv2::surfaces::{
    SurfaceComposition, SyncRequest, check_sync_request, validate_rect,
};

// contract: surfaces-geometry.rect.accepts-zero-size, surfaces-geometry.rect.rejects-negative-size, surfaces-geometry.rect.rejects-non-finite
#[test]
fn rejects_non_finite_and_negative_surface_geometry_without_fallback() {
    assert!(validate_rect("surface", 0.0, 0.0, 0.0, 10.0).is_ok());
    assert!(
        validate_rect("surface", 0.0, 0.0, -0.1, 10.0)
            .unwrap_err()
            .contains("negative size")
    );
    assert!(
        validate_rect("surface", 0.0, 0.0, f64::NAN, 10.0)
            .unwrap_err()
            .contains("finite")
    );
}

fn sync_request(request: serde_json::Value) -> SyncRequest {
    serde_json::from_value(request).expect("the sync request fixture is a valid request")
}

// contract: view.start-values.declaration-table
#[test]
fn sync_request_resolves_request_local_view_declaration_indices() {
    let view = |id: &str, index: serde_json::Value| {
        serde_json::json!({
            "id": id, "x": 0.0, "y": 0.0, "w": 10.0, "h": 10.0,
            "visible": true, "dim": false, "plugin": "page",
            "composition": {"kind": "view", "page": "ui/page.html"},
            "start": {
                "params": {"path": id},
                "origin": {"directory": "/work/one"},
                "project": {"id": "prj-one", "root": "/work/one"},
                "declarations": index,
                "diagnostics": null,
            },
        })
    };
    let missing_table = serde_json::json!({
        "settled": true, "titlebar": 40.0, "surfaces": [view("tab-1", serde_json::json!(0))],
    });
    assert!(
        serde_json::from_value::<SyncRequest>(missing_table).is_err(),
        "a sync request without its declaration table must be refused"
    );

    let declarations = serde_json::json!([
        {"commands": ["open"], "dom": ["one"]},
        {"commands": ["save"], "dom": ["two"]},
    ]);
    let request: SyncRequest = serde_json::from_value(serde_json::json!({
        "settled": true,
        "titlebar": 40.0,
        "declarations": declarations,
        "surfaces": [view("tab-1", serde_json::json!(0)), view("tab-2", serde_json::json!(1))],
    }))
    .expect("the current indexed wire request is valid");
    let composition: SurfaceComposition = serde_json::from_value(serde_json::json!({
        "kind": "view", "page": "ui/page.html",
    }))
    .expect("the composition fixture is valid");
    let held = HashMap::from([
        ("tab-1".to_string(), composition.clone()),
        ("tab-2".to_string(), composition),
    ]);
    let plugins = HashMap::from([
        ("tab-1".to_string(), "page".to_string()),
        ("tab-2".to_string(), "page".to_string()),
    ]);
    assert!(
        check_sync_request(&request, &held, &plugins).is_ok(),
        "each view index must resolve to a declaration object in this request"
    );

    let negative_zero: Result<SyncRequest, _> = serde_json::from_str(
        r#"{"settled":true,"titlebar":40,"declarations":[{"commands":[]}],"surfaces":[{"id":"tab-zero","x":0,"y":0,"w":10,"h":10,"visible":true,"dim":false,"plugin":"page","composition":{"kind":"view","page":"ui/page.html"},"start":{"origin":{"directory":null},"declarations":-0,"diagnostics":null}}]}"#,
    );
    assert!(
        negative_zero.is_err(),
        "serde's nonnegative integer index rejects negative zero's floating representation"
    );

    for (request, expected) in [
        (
            serde_json::json!({
                "settled": true, "titlebar": 40.0, "declarations": [],
                "surfaces": [view("tab-1", serde_json::json!(0))],
            }),
            r#"surface "tab-1": view start declarations index 0 is outside the request table of 0 entries"#,
        ),
        (
            serde_json::json!({
                "settled": true, "titlebar": 40.0, "declarations": [null],
                "surfaces": [view("tab-1", serde_json::json!(0))],
            }),
            "surface declaration table entry 0 is not an object",
        ),
        (
            serde_json::json!({
                "settled": true, "titlebar": 40.0,
                "declarations": [{"commands": ["open"]}, {"commands": ["unused"]}],
                "surfaces": [view("tab-1", serde_json::json!(0))],
            }),
            "surface declaration table entry 1 is not referenced",
        ),
    ] {
        let request: SyncRequest = serde_json::from_value(request)
            .expect("the invalid reference fixture has a valid wire type");
        let error = check_sync_request(&request, &HashMap::new(), &HashMap::new())
            .expect_err("an invalid declaration reference must be refused");
        assert_eq!(error, expected);
    }

    for start in [
        serde_json::json!({"origin": {"directory": "/work/one"}}),
        serde_json::json!({"origin": {"directory": "/work/one"}, "declarations": -1}),
        serde_json::json!({"origin": {"directory": "/work/one"}, "declarations": 0.5}),
        serde_json::json!({"origin": {"directory": "/work/one"}, "declarations": {"commands": []}}),
    ] {
        let mut surface = view("tab-1", serde_json::json!(0));
        surface["start"] = start;
        let request = serde_json::json!({
            "settled": true, "titlebar": 40.0, "declarations": [{"commands": []}],
            "surfaces": [surface],
        });
        assert!(
            serde_json::from_value::<SyncRequest>(request).is_err(),
            "missing, noninteger, negative and nested declaration forms must be refused"
        );
    }
    for declarations in [serde_json::Value::Null, serde_json::json!({})] {
        let request = serde_json::json!({
            "settled": true, "titlebar": 40.0, "declarations": declarations, "surfaces": [],
        });
        assert!(
            serde_json::from_value::<SyncRequest>(request).is_err(),
            "a null or non-array declaration table must be refused"
        );
    }
}

fn surface(id: &str, w: f64) -> serde_json::Value {
    serde_json::json!({
        "id": id, "module": "surface.js", "x": 0.0, "y": 0.0, "w": w, "h": 10.0,
        "visible": true, "dim": false, "plugin": "page", "composition": {"kind": "view", "page": "ui/page.html", "regions": [{"name": "page", "kind": "document", "input": "native"}], "overlays": []},
        "start": {"origin": {"directory": null}, "declarations": 0, "diagnostics": null},
    })
}

// contract: surfaces-geometry.sync.rejects-surface-rect-before-layout
#[test]
fn sync_request_check_rejects_an_invalid_surface_rectangle() {
    let composition = serde_json::from_value(surface("tab-1", 10.0)["composition"].clone())
        .expect("the composition fixture is valid");
    let held = HashMap::from([("tab-1".to_string(), composition)]);
    let plugins = HashMap::from([("tab-1".to_string(), "page".to_string())]);
    let valid = sync_request(
        serde_json::json!({"settled": true, "titlebar": 40.0, "declarations": [{"commands": []}], "surfaces": [surface("tab-1", 10.0)]}),
    );
    assert!(check_sync_request(&valid, &held, &plugins).is_ok());
    let negative = sync_request(serde_json::json!({
        "settled": true,
        "titlebar": 40.0,
        "declarations": [{"commands": []}],
        "surfaces": [surface("tab-1", 10.0), surface("tab-2", -1.0)],
    }));
    assert_eq!(
        check_sync_request(&negative, &held, &plugins).unwrap_err(),
        r#"surface "tab-2" geometry must not have a negative size"#
    );
}

// contract: view.placement.requires-current-page-declaration
#[test]
fn sync_request_check_rejects_a_view_without_a_current_page_declaration() {
    let request = sync_request(serde_json::json!({
        "settled": true, "titlebar": 40.0, "declarations": [{"commands": []}], "surfaces": [surface("tab-unannounced", 10.0)]
    }));
    assert_eq!(
        check_sync_request(&request, &HashMap::new(), &HashMap::new()).unwrap_err(),
        r#"surface "tab-unannounced" has no composition declaration in the current page"#
    );
}

// contract: surfaces-geometry.sync.rejects-overlay-rect-before-layout
#[test]
fn sync_request_check_rejects_an_invalid_window_overlay_rectangle() {
    let held = HashMap::new();
    let valid = sync_request(serde_json::json!({
        "settled": true, "titlebar": 40.0, "declarations": [], "surfaces": [],
        "overlays": [{"x": 1.0, "y": 2.0, "w": 3.0, "h": 4.0}, {"x": 5.0, "y": 6.0, "w": 7.0, "h": 8.0, "visible": false}],
    }));
    assert_eq!(
        check_sync_request(&valid, &held, &HashMap::new())
            .expect("a valid sync request is accepted"),
        vec![
            WindowOverlay {
                x: 1.0,
                y: 2.0,
                w: 3.0,
                h: 4.0,
                visible: true,
            },
            WindowOverlay {
                x: 5.0,
                y: 6.0,
                w: 7.0,
                h: 8.0,
                visible: false,
            },
        ]
    );
    let negative = sync_request(serde_json::json!({
        "settled": true, "titlebar": 40.0, "declarations": [], "surfaces": [],
        "overlays": [{"x": 1.0, "y": 2.0, "w": 3.0, "h": 4.0}, {"x": 0.0, "y": 0.0, "w": 3.0, "h": -4.0}],
    }));
    assert_eq!(
        check_sync_request(&negative, &held, &HashMap::new()).unwrap_err(),
        "window overlay geometry must not have a negative size"
    );
}

// contract: surfaces-geometry.sync.plugin
#[test]
fn sync_request_check_requires_the_same_plugin_of_each_surface() {
    let document = serde_json::json!({"kind": "view", "page": "ui/page.html", "regions": [{"name": "page", "kind": "document", "input": "native"}], "overlays": []});
    let mut value = surface("tab-1", 10.0);
    value["composition"] = document.clone();
    let held = HashMap::from([(
        "tab-1".to_string(),
        serde_json::from_value(document).expect("the composition fixture is valid"),
    )]);
    let request = sync_request(
        serde_json::json!({"settled": true, "titlebar": 40.0, "declarations": [{"commands": []}], "surfaces": [value.clone()]}),
    );
    let same = HashMap::from([("tab-1".to_string(), "page".to_string())]);
    assert!(check_sync_request(&request, &held, &same).is_ok());
    let other = HashMap::from([("tab-1".to_string(), "other".to_string())]);
    assert_eq!(
        check_sync_request(&request, &held, &other).unwrap_err(),
        r#"surface "tab-1" changed its composition declaration"#
    );
    let stale_composition = serde_json::from_value(serde_json::json!({
        "kind": "view", "page": "ui/old-page.html", "regions": [{"name": "page", "kind": "document", "input": "native"}], "overlays": []
    })).expect("the stale composition fixture is valid");
    let stale = HashMap::from([("tab-1".to_string(), stale_composition)]);
    assert_eq!(
        check_sync_request(&request, &stale, &same).unwrap_err(),
        r#"surface "tab-1" changed its composition declaration"#
    );
    value["plugin"] = serde_json::json!("");
    let missing = sync_request(
        serde_json::json!({"settled": true, "titlebar": 40.0, "declarations": [{"commands": []}], "surfaces": [value]}),
    );
    assert_eq!(
        check_sync_request(&missing, &HashMap::new(), &HashMap::new()).unwrap_err(),
        r#"surface "tab-1" requires its plugin"#
    );
}

// contract: view.start-values.first-script
#[test]
fn sync_request_check_validates_the_start_values_of_a_view() {
    let held = HashMap::new();
    let view = |start: serde_json::Value| {
        serde_json::json!({
            "id": "tab-1", "module": null, "x": 0.0, "y": 0.0, "w": 10.0, "h": 10.0,
            "visible": true, "dim": false, "plugin": "page",
            "composition": {"kind": "view", "page": "ui/page.html"}, "start": start,
        })
    };
    let request = sync_request(serde_json::json!({
        "settled": true, "titlebar": 40.0,
        "declarations": [{"commands": []}],
        "surfaces": [view(serde_json::json!({"project": {"id": "prj-one", "root": ""}, "declarations": 0}))],
    }));
    assert_eq!(
        check_sync_request(&request, &held, &HashMap::new()).unwrap_err(),
        r#"surface "tab-1": view start project root is empty"#
    );
    let request = sync_request(serde_json::json!({
        "settled": true, "titlebar": 40.0,
        "declarations": [{"commands": []}],
        "surfaces": [view(serde_json::json!({"project": {"id": "", "root": "/work/one"}, "declarations": 0}))],
    }));
    assert_eq!(
        check_sync_request(&request, &held, &HashMap::new()).unwrap_err(),
        r#"surface "tab-1": view start project id is empty"#
    );
    let request = sync_request(serde_json::json!({
        "settled": true, "titlebar": 40.0,
        "declarations": [{"commands": []}],
        "surfaces": [view(serde_json::json!({"origin": {"directory": ""}, "declarations": 0}))],
    }));
    assert_eq!(
        check_sync_request(&request, &held, &HashMap::new()).unwrap_err(),
        r#"surface "tab-1": view start origin directory is empty"#
    );
    let request = sync_request(serde_json::json!({
        "settled": true, "titlebar": 40.0,
        "declarations": [{"commands": []}],
        "surfaces": [view(serde_json::json!({"origin": {"directory": null}, "declarations": 0}))],
    }));
    assert_eq!(
        check_sync_request(&request, &held, &HashMap::new()).unwrap_err(),
        r#"surface "tab-1": view start diagnostics is missing"#
    );
    let request = sync_request(serde_json::json!({
        "settled": true, "titlebar": 40.0,
        "declarations": [{"commands": []}],
        "surfaces": [view(serde_json::json!({"origin": {"directory": null}, "declarations": 0, "diagnostics": []}))],
    }));
    assert_eq!(
        check_sync_request(&request, &held, &HashMap::new()).unwrap_err(),
        r#"surface "tab-1": view start diagnostics is not an object or null"#
    );
    let request = sync_request(serde_json::json!({
        "settled": true, "titlebar": 40.0,
        "declarations": [{"commands": []}],
        "surfaces": [view(serde_json::json!({"origin": {"directory": null}, "declarations": 1}))],
    }));
    assert_eq!(
        check_sync_request(&request, &held, &HashMap::new()).unwrap_err(),
        r#"surface "tab-1": view start declarations index 1 is outside the request table of 1 entries"#
    );
    // The removed hybrid composition is refused with the plugin and the field, whatever its start values.
    let hybrid = serde_json::json!({
        "id": "tab-1", "module": "surface.js", "x": 0.0, "y": 0.0, "w": 10.0, "h": 10.0,
        "visible": true, "dim": false, "plugin": "page",
        "composition": {"kind": "hybrid", "regions": [{"name": "page", "kind": "document", "input": "native"}], "overlays": []},
        "start": {"project": {"id": "prj-one", "root": "/work/one"}, "declarations": 0},
    });
    let request = sync_request(serde_json::json!({
        "settled": true, "titlebar": 40.0, "declarations": [{"commands": []}], "surfaces": [hybrid],
    }));
    assert_eq!(
        check_sync_request(&request, &held, &HashMap::new()).unwrap_err(),
        r#"surface "tab-1": plugin page surface composition: kind hybrid is removed; the composition takes kind view"#
    );
}

// A view surface whose start values carry no origin, or an origin that is not {directory} with a path or null, is refused with
// its reason; the host never injects a directory in its place. The fixed form with a null directory is accepted.
// contract: view.start-values.refuses-a-missing-origin
#[test]
fn sync_request_check_refuses_a_view_origin_without_a_directory_form() {
    let composition = serde_json::json!({"kind": "view", "page": "ui/page.html"});
    let held = HashMap::from([(
        "tab-1".to_string(),
        serde_json::from_value(composition).expect("the composition fixture is valid"),
    )]);
    let plugins = HashMap::from([("tab-1".to_string(), "page".to_string())]);
    let view = |start: Option<serde_json::Value>| {
        let mut surface = serde_json::json!({
            "id": "tab-1", "module": null, "x": 0.0, "y": 0.0, "w": 10.0, "h": 10.0,
            "visible": true, "dim": false, "plugin": "page",
            "composition": {"kind": "view", "page": "ui/page.html"},
        });
        if let Some(start) = start {
            surface["start"] = start;
        }
        surface
    };
    let missing = r#"surface "tab-1": view start origin is missing"#;
    let malformed = r#"surface "tab-1": view start origin is not {directory} with a path or null"#;
    let cases = [
        (None, missing),
        (
            Some(serde_json::json!({"params": null, "declarations": 0})),
            missing,
        ),
        (
            Some(serde_json::json!({"origin": null, "declarations": 0})),
            malformed,
        ),
        (
            Some(serde_json::json!({"origin": {}, "declarations": 0})),
            malformed,
        ),
        (
            Some(serde_json::json!({"origin": {"directory": 1}, "declarations": 0})),
            malformed,
        ),
        (
            Some(
                serde_json::json!({"origin": {"directory": "/work/one", "root": "/work/one"}, "declarations": 0}),
            ),
            malformed,
        ),
    ];
    for (start, want) in cases {
        let declarations = if start.is_some() {
            serde_json::json!([{"commands": []}])
        } else {
            serde_json::json!([])
        };
        let request = sync_request(serde_json::json!({
            "settled": true, "titlebar": 40.0, "declarations": declarations, "surfaces": [view(start)],
        }));
        assert_eq!(
            check_sync_request(&request, &held, &plugins).unwrap_err(),
            want
        );
    }
    let request = sync_request(serde_json::json!({
        "settled": true, "titlebar": 40.0,
        "declarations": [{"commands": []}],
        "surfaces": [view(Some(serde_json::json!({"origin": {"directory": null}, "declarations": 0, "diagnostics": null})))],
    }));
    assert!(check_sync_request(&request, &held, &plugins).is_ok());
}
