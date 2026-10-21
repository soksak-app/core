use std::collections::HashMap;

use soksak_host_tauriv2::platform::WindowOverlay;
use soksak_host_tauriv2::surfaces::{SyncRequest, check_sync_request, validate_rect};

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

fn surface(id: &str, w: f64) -> serde_json::Value {
    serde_json::json!({
        "id": id, "module": "surface.js", "x": 0.0, "y": 0.0, "w": w, "h": 10.0,
        "visible": true, "dim": false, "plugin": "page", "composition": {"kind": "hybrid", "regions": [{"name": "page", "kind": "document", "input": "native"}], "overlays": []},
    })
}

// contract: surfaces-geometry.sync.rejects-surface-rect-before-layout
#[test]
fn sync_request_check_rejects_an_invalid_surface_rectangle() {
    let held = HashMap::new();
    let valid = sync_request(
        serde_json::json!({"settled": true, "titlebar": 40.0, "surfaces": [surface("tab-1", 10.0)]}),
    );
    assert!(check_sync_request(&valid, &held, &HashMap::new()).is_ok());
    let negative = sync_request(serde_json::json!({
        "settled": true,
        "titlebar": 40.0,
        "surfaces": [surface("tab-1", 10.0), surface("tab-2", -1.0)],
    }));
    assert_eq!(
        check_sync_request(&negative, &held, &HashMap::new()).unwrap_err(),
        r#"surface "tab-2" geometry must not have a negative size"#
    );
}

// contract: surfaces-geometry.sync.rejects-overlay-rect-before-layout
#[test]
fn sync_request_check_rejects_an_invalid_window_overlay_rectangle() {
    let held = HashMap::new();
    let valid = sync_request(serde_json::json!({
        "settled": true, "titlebar": 40.0, "surfaces": [],
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
        "settled": true, "titlebar": 40.0, "surfaces": [],
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
    let document = serde_json::json!({"kind": "hybrid", "regions": [{"name": "page", "kind": "document", "input": "native"}], "overlays": []});
    let mut value = surface("tab-1", 10.0);
    value["composition"] = document.clone();
    let held = HashMap::from([(
        "tab-1".to_string(),
        serde_json::from_value(document).expect("the composition fixture is valid"),
    )]);
    let request = sync_request(
        serde_json::json!({"settled": true, "titlebar": 40.0, "surfaces": [value.clone()]}),
    );
    let same = HashMap::from([("tab-1".to_string(), "page".to_string())]);
    assert!(check_sync_request(&request, &held, &same).is_ok());
    let other = HashMap::from([("tab-1".to_string(), "other".to_string())]);
    assert_eq!(
        check_sync_request(&request, &held, &other).unwrap_err(),
        r#"surface "tab-1" changed its composition declaration"#
    );
    value["plugin"] = serde_json::json!("");
    let missing =
        sync_request(serde_json::json!({"settled": true, "titlebar": 40.0, "surfaces": [value]}));
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
        "surfaces": [view(serde_json::json!({"project": {"root": ""}}))],
    }));
    assert_eq!(
        check_sync_request(&request, &held, &HashMap::new()).unwrap_err(),
        r#"surface "tab-1": view start project root is empty"#
    );
    let request = sync_request(serde_json::json!({
        "settled": true, "titlebar": 40.0,
        "surfaces": [view(serde_json::json!({"origin": {"directory": ""}}))],
    }));
    assert_eq!(
        check_sync_request(&request, &held, &HashMap::new()).unwrap_err(),
        r#"surface "tab-1": view start origin directory is empty"#
    );
    let request = sync_request(serde_json::json!({
        "settled": true, "titlebar": 40.0,
        "surfaces": [view(serde_json::json!({"declarations": []}))],
    }));
    assert_eq!(
        check_sync_request(&request, &held, &HashMap::new()).unwrap_err(),
        r#"surface "tab-1": view start declarations are not an object"#
    );
    // A surface of another composition carries no start values.
    let hybrid = serde_json::json!({
        "id": "tab-1", "module": "surface.js", "x": 0.0, "y": 0.0, "w": 10.0, "h": 10.0,
        "visible": true, "dim": false, "plugin": "page",
        "composition": {"kind": "hybrid", "regions": [{"name": "page", "kind": "document", "input": "native"}], "overlays": []},
        "start": {"project": {"root": "/work/one"}},
    });
    let request = sync_request(serde_json::json!({
        "settled": true, "titlebar": 40.0, "surfaces": [hybrid],
    }));
    assert_eq!(
        check_sync_request(&request, &held, &HashMap::new()).unwrap_err(),
        r#"surface "tab-1": only a view surface carries start values"#
    );
}
