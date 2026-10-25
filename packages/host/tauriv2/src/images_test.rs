use std::sync::{Arc, Mutex};

// contract: images.reload.captures-old-image-owner
#[test]
fn reload_captures_each_image_supplier_before_advancing_generation() {
    let images = super::Images::default();
    let surface = "surface-reload";
    let old_generation = images.begin_generation(surface);
    for name in ["second", "first"] {
        let key = (surface.to_string(), name.to_string());
        images.reserve(&key, "owner", "fixture-sidecar").unwrap();
        assert!(images.set(&key, name.len() as usize));
    }

    let targets = images.begin_reload(surface);
    assert_eq!(
        targets,
        [
            super::DetachTarget {
                surface: surface.to_string(),
                name: "first".to_string(),
                sidecar: "fixture-sidecar".to_string(),
                generation: old_generation,
            },
            super::DetachTarget {
                surface: surface.to_string(),
                name: "second".to_string(),
                sidecar: "fixture-sidecar".to_string(),
                generation: old_generation,
            },
        ]
    );

    assert!(
        targets
            .iter()
            .all(|target| target.generation == old_generation),
        "detach requests retain the generation that owned the image before reload"
    );
}

// contract: images.detach.timeout-retains-target
#[test]
fn a_timed_out_detach_target_remains_for_the_next_page_start() {
    let images = super::Images::default();
    let surface = "surface-retry";
    let old_generation = images.begin_generation(surface);
    let key = (surface.to_string(), "region".to_string());
    images.reserve(&key, "owner", "fixture-sidecar").unwrap();
    assert!(images.set(&key, 1));

    let timed_out = images.begin_reload(surface);
    assert_eq!(images.begin_reload(surface), timed_out);
    images.remove_surface(surface);
    let retried = images.begin_reload(surface);

    assert_eq!(retried, timed_out);
    assert_eq!(retried[0].generation, old_generation);

    images.complete_detachments(&retried);
    assert!(images.begin_reload(surface).is_empty());
}

// contract: images.detach.timeout-retains-target
#[test]
fn a_timed_out_detach_keeps_its_supplier_in_the_next_reconnect_targets() {
    let images = super::Images::default();
    let surface = "surface-reconnect-retry";
    images.begin_generation(surface);
    let key = (surface.to_string(), "region".to_string());
    images.reserve(&key, "owner", "fixture-sidecar").unwrap();
    assert!(images.set(&key, 1));

    let _unacknowledged = images.begin_reload(surface);
    images.remove_surface(surface);

    let mut sidecars = images.sidecars_for_surface(surface);
    sidecars.sort();
    assert_eq!(
        sidecars,
        ["fixture-sidecar"],
        "a timeout retains the supplier needed by the next page reload"
    );
}

// contract: images.detach.timeout-retains-target
#[test]
fn ending_a_surface_clears_its_unacknowledged_detach_targets() {
    let images = super::Images::default();
    let surface = "surface-ended";
    images.begin_generation(surface);
    let key = (surface.to_string(), "region".to_string());
    images.reserve(&key, "owner", "fixture-sidecar").unwrap();
    assert!(images.set(&key, 1));
    images.begin_reload(surface);
    images.remove_surface(surface);

    images.end_generation(surface);

    assert!(images.sidecars_for_surface(surface).is_empty());
    assert!(images.begin_reload(surface).is_empty());
}
// contract: exposure.window.region-reports-presented-frame
#[test]
fn presenting_a_frame_notifies_after_its_identity_is_current() {
    let images = super::Images::default();
    let key = ("tab-1".to_string(), "view".to_string());
    images.begin_generation(&key.0);
    images.reserve(&key, "owner", "sidecar-a").unwrap();
    assert!(images.set(&key, 100));
    let raster = images
        .configure_raster(&key, 800, 600, 2.0, true)
        .unwrap()
        .unwrap();
    let body = serde_json::json!({
        "image": {
            "name": "view",
            "token": {
                "kind": "iosurface-global",
                "id": 12345u32,
                "nonce": "AAAAAAAAAAAAAAAAAAAAAA=="
            },
            "width": raster.width,
            "height": raster.height,
            "scale": raster.scale,
            "format": "bgra8",
            "generation": raster.generation,
            "raster": raster.raster,
            "sequence": 2
        }
    })
    .to_string();
    let notified = Arc::new(Mutex::new(None));
    let received = Arc::clone(&notified);
    let current_images = images.clone();
    let current_key = key.clone();
    assert!(super::handle_envelope_with_recovery(
        &body,
        "sidecar-a",
        &key.0,
        &images,
        |_work| Ok(()),
        |_image, _response| Ok(()),
        |_| Ok(()),
        || true,
        move || *received.lock().unwrap() = current_images.presented_frame(&current_key),
    ));
    let frame = notified
        .lock()
        .unwrap()
        .expect("the presented frame notification");
    assert_eq!(frame.generation, raster.generation);
    assert_eq!(frame.raster, raster.raster);
    assert_eq!(frame.sequence, 2);
}

// contract: exposure.window.region-reports-presented-frame
#[test]
fn failed_or_retired_frame_does_not_notify_the_window() {
    let images = super::Images::default();
    let key = ("tab-1".to_string(), "view".to_string());
    images.begin_generation(&key.0);
    images.reserve(&key, "owner", "sidecar-a").unwrap();
    assert!(images.set(&key, 100));
    let raster = images
        .configure_raster(&key, 800, 600, 2.0, true)
        .unwrap()
        .unwrap();
    let body = serde_json::json!({
        "image": {
            "name": "view",
            "token": {
                "kind": "iosurface-global",
                "id": 12345u32,
                "nonce": "AAAAAAAAAAAAAAAAAAAAAA=="
            },
            "width": raster.width,
            "height": raster.height,
            "scale": raster.scale,
            "format": "bgra8",
            "generation": raster.generation,
            "raster": raster.raster,
            "sequence": 1
        }
    })
    .to_string();
    assert!(super::handle_envelope_with_recovery(
        &body,
        "sidecar-a",
        &key.0,
        &images,
        |_work| Err("presentFailed".to_string()),
        |_image, _response| Ok(()),
        |_| Ok(()),
        || true,
        || panic!("a failed image frame notified the window"),
    ));
    assert_eq!(images.presented_frame(&key), None);

    let mut retired_body: serde_json::Value = serde_json::from_str(&body).unwrap();
    retired_body["image"]["sequence"] = serde_json::json!(2);
    let retired_images = images.clone();
    let retired_key = key.clone();
    assert!(super::handle_envelope_with_recovery(
        &retired_body.to_string(),
        "sidecar-a",
        &key.0,
        &images,
        move |_work| {
            retired_images.begin_generation(&retired_key.0);
            Ok(())
        },
        |_image, _response| Ok(()),
        |_| Ok(()),
        || true,
        || panic!("a retired image frame notified the window"),
    ));
    assert_eq!(images.presented_frame(&key), None);
}
