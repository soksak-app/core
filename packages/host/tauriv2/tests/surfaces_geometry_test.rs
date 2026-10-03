use std::collections::HashMap;

use soksak_host_tauriv2::platform::WindowOverlay;
use soksak_host_tauriv2::surfaces::{check_sync_request, validate_rect, SyncRequest};

// contract: surfaces-geometry.rect.accepts-zero-size, surfaces-geometry.rect.rejects-negative-size, surfaces-geometry.rect.rejects-non-finite
#[test]
fn rejects_non_finite_and_negative_surface_geometry_without_fallback() {
    assert!(validate_rect("surface", 0.0, 0.0, 0.0, 10.0).is_ok());
    assert!(validate_rect("surface", 0.0, 0.0, -0.1, 10.0)
        .unwrap_err()
        .contains("negative size"));
    assert!(validate_rect("surface", 0.0, 0.0, f64::NAN, 10.0)
        .unwrap_err()
        .contains("finite"));
}

fn sync_request(request: serde_json::Value) -> SyncRequest {
    serde_json::from_value(request).expect("the sync request fixture is a valid request")
}

fn surface(id: &str, w: f64) -> serde_json::Value {
    serde_json::json!({
        "id": id, "module": "surface.js", "x": 0.0, "y": 0.0, "w": w, "h": 10.0,
        "visible": true, "dim": false, "composition": {"kind": "dom"},
    })
}

// contract: surfaces-geometry.sync.rejects-surface-rect-before-layout
#[test]
fn sync_request_check_rejects_an_invalid_surface_rectangle() {
    let held = HashMap::new();
    let valid =
        sync_request(serde_json::json!({"settled": true, "surfaces": [surface("tab-1", 10.0)]}));
    assert!(check_sync_request(&valid, &held).is_ok());
    let negative = sync_request(serde_json::json!({
        "settled": true,
        "surfaces": [surface("tab-1", 10.0), surface("tab-2", -1.0)],
    }));
    assert_eq!(
        check_sync_request(&negative, &held).unwrap_err(),
        r#"surface "tab-2" geometry must not have a negative size"#
    );
}

// contract: surfaces-geometry.sync.rejects-overlay-rect-before-layout
#[test]
fn sync_request_check_rejects_an_invalid_window_overlay_rectangle() {
    let held = HashMap::new();
    let valid = sync_request(serde_json::json!({
        "settled": true, "surfaces": [],
        "overlays": [{"x": 1.0, "y": 2.0, "w": 3.0, "h": 4.0}, {"x": 5.0, "y": 6.0, "w": 7.0, "h": 8.0, "visible": false}],
    }));
    assert_eq!(
        check_sync_request(&valid, &held).expect("a valid sync request is accepted"),
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
        "settled": true, "surfaces": [],
        "overlays": [{"x": 1.0, "y": 2.0, "w": 3.0, "h": 4.0}, {"x": 0.0, "y": 0.0, "w": 3.0, "h": -4.0}],
    }));
    assert_eq!(
        check_sync_request(&negative, &held).unwrap_err(),
        "window overlay geometry must not have a negative size"
    );
}
