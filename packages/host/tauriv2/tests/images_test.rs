//! Checks the decision logic of image envelopes and the confirmation of their representation.

use serde_json::json;
use soksak_host_tauriv2::application_log::start_standard_error;
use soksak_host_tauriv2::images::{
    Configure, Decision, Images, Key, after_present, decide, handle_envelope,
    handle_envelope_with_recovery,
};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[path = "support/records.rs"]
mod records;

fn configured_envelope(configuration: &Configure, sequence: i32) -> String {
    json!({
        "image": {
            "name": &configuration.name,
            "token": {
                "kind": "iosurface-global",
                "id": 12345u32,
                "nonce": "AAAAAAAAAAAAAAAAAAAAAA=="
            },
            "width": configuration.width,
            "height": configuration.height,
            "scale": configuration.scale,
            "format": "bgra8",
            "generation": configuration.generation,
            "raster": configuration.raster,
            "sequence": sequence
        }
    })
    .to_string()
}

// contract: images.attach.rejects-reservation-without-sidecar
#[test]
fn reserve_rejects_empty_sidecar() {
    let images = Images::default();
    let key: Key = ("tab-1".to_string(), "view".to_string());

    // Try reserve with an empty sidecar.
    let result = images.reserve(&key, "owner", "");
    assert!(result.is_err(), "expected error for empty sidecar");
    assert!(
        result.unwrap_err().contains("requires a sidecar"),
        "expected 'requires a sidecar' error"
    );

    // Check that the image was not registered.
    assert!(
        images.get(&key).is_err(),
        "image should not be registered after failed reserve"
    );
}

// contract: images.envelope.rejects-unattached-image, images.envelope.refusal-echoes-name-and-sequence
#[test]
fn unattached_image_is_refused() {
    let images = Images::default();
    let nonce_b64 = "AAAAAAAAAAAAAAAAAAAAAA=="; // 16 zero bytes
    let body = json!({
        "image": {
            "name": "view",
            "token": {
                "kind": "iosurface-global",
                "id": 12345u32,
                "nonce": nonce_b64
            },
            "width": 800,
            "height": 600,
            "scale": 2.0,
            "format": "bgra8",
            "generation": 1,
            "raster": 1,
            "sequence": 1
        }
    })
    .to_string();

    // Since the image is not registered, a notAttached error must be returned.
    match decide(&body, "sidecar-a", "tab-1", &images) {
        Decision::Reply { name, json, .. } => {
            assert_eq!(name, "view");
            assert!(
                json["image"]["error"]
                    .as_str()
                    .unwrap()
                    .contains("notAttached")
            );
            assert_eq!(json["image"]["name"], "view");
            assert_eq!(json["image"]["sequence"], 1);
        }
        _ => panic!("expected Reply(notAttached)"),
    }
}

// contract: images.envelope.rejects-other-sidecar
#[test]
fn image_from_another_sidecar_is_refused() {
    let images = Images::default();
    let key: Key = ("tab-1".to_string(), "view".to_string());
    images
        .reserve(&key, "owner-a", "sidecar-a")
        .expect("reserve");
    images.set(&key, 100);
    // This is the configured current raster, so the only reason for the rejection is the sidecar that sent it.
    let configured = images
        .configure_raster(&key, 800, 600, 2.0, true)
        .unwrap()
        .unwrap();
    let body = configured_envelope(&configured, 1);
    match decide(&body, "sidecar-b", "tab-1", &images) {
        Decision::Reply { name, json, .. } => {
            assert_eq!(name, "view");
            assert_eq!(json["image"]["error"], "notAttached");
        }
        _ => panic!("expected Reply(notAttached) for different sidecar"),
    }
    // Contrast: the same envelope that the connected sidecar sent is displayed.
    assert!(
        matches!(
            decide(&body, "sidecar-a", "tab-1", &images),
            Decision::Present { .. }
        ),
        "the attaching sidecar's envelope for the configured raster was not presented"
    );
}

// contract: images.envelope.presents-attached-current-frame, images.envelope.present-carries-nonce-scale-generation-raster
#[test]
fn attached_image_is_presented() {
    let images = Images::default();
    let key: Key = ("tab-1".to_string(), "view".to_string());

    // The sidecar registers the image.
    images
        .reserve(&key, "owner-a", "sidecar-a")
        .expect("reserve");
    images.set(&key, 100);
    let configured = images
        .configure_raster(&key, 800, 600, 2.0, true)
        .unwrap()
        .unwrap();

    let nonce_b64 = "AAAAAAAAAAAAAAAAAAAAAA==";
    let body = json!({
        "image": {
            "name": "view",
            "token": {
                "kind": "iosurface-global",
                "id": 12345u32,
                "nonce": nonce_b64
            },
            "width": 800,
            "height": 600,
            "scale": 2.0,
            "format": "bgra8",
            "generation": configured.generation,
            "raster": configured.raster,
            "sequence": 1
        }
    })
    .to_string();

    // When the same sidecar sends the same image, Present must be returned.
    match decide(&body, "sidecar-a", "tab-1", &images) {
        Decision::Present {
            id,
            nonce,
            width,
            height,
            scale,
            name,
            generation,
            raster,
            sequence,
        } => {
            assert_eq!(id, 12345u32);
            assert_eq!(nonce, [0; 16]);
            assert_eq!(width, 800);
            assert_eq!(height, 600);
            assert_eq!(scale, 2.0);
            assert_eq!(name, "view");
            assert_eq!(generation, configured.generation);
            assert_eq!(raster, configured.raster);
            assert_eq!(sequence, 1);
        }
        _ => panic!("expected Present"),
    }
}

// contract: images.ack.consumed-carries-frame-identity
#[test]
fn successful_present_is_consumed() {
    let response = after_present(Ok(()), "view", 7, 3, 1);
    assert!(response["image"]["consumed"].is_object());
    assert_eq!(response["image"]["consumed"]["name"], "view");
    assert_eq!(response["image"]["consumed"]["generation"], 7);
    assert_eq!(response["image"]["consumed"]["raster"], 3);
    assert_eq!(response["image"]["consumed"]["sequence"], 1);
}

// contract: images.transfer.rejects-duplicate-sequence, images.transfer.reconfigure-advances-raster, images.transfer.rejects-stale-raster, images.transfer.configure-stamps-current-generation, images.transfer.generation-advances, images.transfer.rejects-old-generation-after-reattach
#[test]
fn only_the_current_generation_raster_and_sequence_can_be_presented() {
    let images = Images::default();
    let key: Key = ("tab-1".to_string(), "view".to_string());

    let first_generation = images.begin_generation(&key.0);
    images.reserve(&key, "owner", "sidecar-a").unwrap();
    assert!(images.set(&key, 100));
    let first_raster = images
        .configure_raster(&key, 800, 600, 2.0, true)
        .unwrap()
        .unwrap();
    assert_eq!(first_raster.generation, first_generation);
    assert!(matches!(
        decide(
            &configured_envelope(&first_raster, 1),
            "sidecar-a",
            &key.0,
            &images
        ),
        Decision::Present { .. }
    ));
    match decide(
        &configured_envelope(&first_raster, 1),
        "sidecar-a",
        &key.0,
        &images,
    ) {
        Decision::Reply { json, .. } => assert_eq!(json["image"]["error"], "stale"),
        other => panic!("duplicate sequence was not stale: {other:?}"),
    }

    let second_raster = images
        .configure_raster(&key, 900, 600, 2.0, true)
        .unwrap()
        .unwrap();
    assert!(second_raster.raster > first_raster.raster);
    match decide(
        &configured_envelope(&first_raster, 2),
        "sidecar-a",
        &key.0,
        &images,
    ) {
        Decision::Reply { json, .. } => assert_eq!(json["image"]["error"], "stale"),
        other => panic!("old raster was not stale: {other:?}"),
    }
    assert!(matches!(
        decide(
            &configured_envelope(&second_raster, 1),
            "sidecar-a",
            &key.0,
            &images
        ),
        Decision::Present { .. }
    ));

    images.remove(&key).unwrap();
    images.end_generation(&key.0);
    let second_generation = images.begin_generation(&key.0);
    assert!(second_generation > first_generation);
    images.reserve(&key, "owner", "sidecar-a").unwrap();
    assert!(images.set(&key, 101));
    images
        .configure_raster(&key, 800, 600, 2.0, true)
        .unwrap()
        .unwrap();
    match decide(
        &configured_envelope(&first_raster, 3),
        "sidecar-a",
        &key.0,
        &images,
    ) {
        Decision::Reply { json, .. } => assert_eq!(json["image"]["error"], "notAttached"),
        other => panic!("old generation was not rejected: {other:?}"),
    }
}

// contract: images.transfer.configure-stamps-current-generation, images.transfer.generation-advances, images.transfer.new-generation-invalidates-queued-old-frame
#[test]
fn beginning_a_new_generation_invalidates_a_queued_old_frame_before_image_close() {
    let images = Images::default();
    let key: Key = ("tab-queued".to_string(), "view".to_string());
    let first_generation = images.begin_generation(&key.0);
    images.reserve(&key, "owner", "sidecar-a").unwrap();
    assert!(images.set(&key, 100));
    let first_raster = images
        .configure_raster(&key, 800, 600, 2.0, true)
        .unwrap()
        .unwrap();
    assert_eq!(first_raster.generation, first_generation);
    assert!(matches!(
        decide(
            &configured_envelope(&first_raster, 1),
            "sidecar-a",
            &key.0,
            &images
        ),
        Decision::Present { .. }
    ));

    let next_generation = images.begin_generation(&key.0);
    assert!(next_generation > first_generation);
    match decide(
        &configured_envelope(&first_raster, 2),
        "sidecar-a",
        &key.0,
        &images,
    ) {
        Decision::Reply { json, .. } => assert_eq!(json["image"]["error"], "notAttached"),
        other => panic!("queued old frame was not invalidated: {other:?}"),
    }
}

// contract: images.transfer.reconfigure-advances-raster, images.wait.blocks-before-first-frame, images.wait.releases-after-current-frame-presented, images.wait.successful-handle-replies-consumed, images.wait.newer-sequence-rearms-wait, images.wait.reconfigure-clears-presented, images.wait.hidden-image-does-not-block, images.wait.hidden-surface-does-not-block, images.wait.ended-generation-does-not-block
#[test]
fn presentation_wait_tracks_the_visible_current_raster() {
    let images = Images::default();
    let key: Key = ("tab-1".to_string(), "view".to_string());
    images.reserve(&key, "owner", "sidecar-a").unwrap();
    assert!(images.set(&key, 100));
    let first = images
        .configure_raster(&key, 800, 600, 2.0, true)
        .unwrap()
        .unwrap();
    assert!(images.wait_current(Duration::ZERO).is_err());

    let response = Arc::new(Mutex::new(None));
    let received = Arc::clone(&response);
    assert!(handle_envelope(
        &configured_envelope(&first, 1),
        "sidecar-a",
        &key.0,
        &images,
        |_work| Ok(()),
        move |_image, value| {
            *received.lock().unwrap() = Some(value);
            Ok(())
        },
    ));
    assert!(response.lock().unwrap().as_ref().unwrap()["image"]["consumed"].is_object());
    assert!(images.wait_current(Duration::ZERO).is_ok());

    assert!(matches!(
        decide(
            &configured_envelope(&first, 2),
            "sidecar-a",
            &key.0,
            &images,
        ),
        Decision::Present { .. }
    ));
    assert!(
        images.wait_current(Duration::ZERO).is_err(),
        "a newer sequence on the same raster must be awaited"
    );

    let second = images
        .configure_raster(&key, 900, 600, 2.0, true)
        .unwrap()
        .unwrap();
    assert!(second.raster > first.raster);
    assert!(!images.current_presented());
    images.set_visible(&key, false).unwrap();
    assert!(images.wait_current(Duration::ZERO).is_ok());
    images.set_visible(&key, true).unwrap();
    assert!(images.wait_current(Duration::ZERO).is_err());
    images.set_surface_visible(&key.0, false);
    assert!(images.wait_current(Duration::ZERO).is_ok());
    images.set_surface_visible(&key.0, true);
    assert!(images.wait_current(Duration::ZERO).is_err());
    images.end_generation(&key.0);
    assert!(images.wait_current(Duration::ZERO).is_ok());
}

/// The environment variable that tells the child process the configuration directory.
const APPLICATION_LOG_CHILD: &str = "SOKSAK_APPLICATION_LOG_CHILD";

// contract: images.wait.timeout-writes-no-log-line
#[test]
fn presentation_wait_timeout_returns_its_failure_and_writes_no_log_line() {
    if let Some(config) = std::env::var_os(APPLICATION_LOG_CHILD) {
        if let Err(error) = start_standard_error(std::path::Path::new(&config), "com.soksak.test") {
            println!("{error}");
            std::process::exit(2);
        }
        let writer = records::start_writer(std::path::Path::new(&config));
        let images = Images::default();
        let key: Key = ("tab-1".to_string(), "view".to_string());
        images.reserve(&key, "owner", "sidecar-a").unwrap();
        assert!(images.set(&key, 100));
        images
            .configure_raster(&key, 800, 600, 2.0, true)
            .unwrap()
            .unwrap();
        // With a time limit of 0, the wait ends before it waits, so a short time is given so that the path where the
        // wait ends at the time limit is exercised.
        assert_eq!(
            images.wait_current(Duration::from_millis(20)),
            Err("presentationTimeout".to_string())
        );
        writer.flush(Duration::from_secs(5)).unwrap();
        return;
    }
    let config = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "presentation_wait_timeout_returns_its_failure_and_writes_no_log_line",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(APPLICATION_LOG_CHILD, config.path())
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "child ended with {:?}, output {:?}",
        output.status,
        String::from_utf8_lossy(&output.stdout)
    );
    // The wait ended with its own failure, so the event log holds log.open and the run record and nothing else but the registrations of the native observers.
    // The registrations of the native observers are the events `native.observe.registered`; they are not part of the wait.
    let events: Vec<_> = records::read_events(&records::event_log_path(config.path()))
        .into_iter()
        .filter(|event| event["event"] != "native.observe.registered")
        .collect();
    assert!(
        events.len() == 2 && events[1]["fields"]["where"] == "run",
        "a presentation timeout wrote events: {events:?}"
    );
}

// contract: images.visibility.survives-first-document-navigation
#[test]
fn surface_visibility_survives_first_document_navigation() {
    let images = Images::default();
    let key: Key = ("hidden".into(), "view".into());
    images.set_surface_visible(&key.0, false);
    images.remove_surface(&key.0);
    images.begin_generation(&key.0);
    images.reserve(&key, "owner", "sidecar-a").unwrap();
    assert!(images.set(&key, 100));
    assert!(
        images
            .configure_raster(&key, 1, 1, 2.0, true)
            .unwrap()
            .is_none(),
        "navigation lost outer surface visibility"
    );
    assert!(images.visible().is_empty());
    assert!(images.current_presented());
}

// contract: images.visibility.hidden-surface-defers-configuration, images.visibility.refresh-list-excludes-hidden
#[test]
fn hidden_surface_defers_raster_configuration() {
    let images = Images::default();
    let key: Key = ("hidden".into(), "view".into());
    images.reserve(&key, "owner", "sidecar-a").unwrap();
    assert!(images.set(&key, 100));
    images.set_surface_visible(&key.0, false);
    assert!(
        images
            .configure_raster(&key, 1, 1, 2.0, true)
            .unwrap()
            .is_none(),
        "hidden surface sent raster configuration"
    );
    assert!(images.visible().is_empty());
    images.set_surface_visible(&key.0, true);
    assert_eq!(images.visible(), vec![(key.clone(), 100)]);
    let shown = images
        .configure_raster(&key, 800, 600, 2.0, true)
        .unwrap()
        .unwrap();
    assert_eq!((shown.width, shown.height), (800, 600));
    images.set_visible(&key, false).unwrap();
    assert!(images.visible().is_empty());
}

// contract: images.present.rejects-frame-superseded-during-main-thread
#[test]
fn frame_that_becomes_stale_before_main_thread_presentation_is_rejected() {
    let images = Images::default();
    let key: Key = ("tab-1".to_string(), "view".to_string());
    images.reserve(&key, "owner", "sidecar-a").unwrap();
    assert!(images.set(&key, 100));
    let first = images
        .configure_raster(&key, 800, 600, 2.0, true)
        .unwrap()
        .unwrap();
    let response = Arc::new(Mutex::new(None));
    let received = Arc::clone(&response);
    let changed = images.clone();
    let changed_key = key.clone();

    assert!(handle_envelope(
        &configured_envelope(&first, 1),
        "sidecar-a",
        &key.0,
        &images,
        move |work| {
            changed.configure_raster(&changed_key, 900, 600, 2.0, true)?;
            work()
        },
        move |_image, value| {
            *received.lock().unwrap() = Some(value);
            Ok(())
        },
    ));

    assert_eq!(
        response.lock().unwrap().as_ref().unwrap()["image"]["error"],
        "stale"
    );
    assert!(!images.current_presented());
}

// contract: images.present.rejects-frame-detached-during-main-thread
#[test]
fn frame_detached_before_main_thread_presentation_is_reported_as_stale() {
    let images = Images::default();
    let key: Key = ("tab-1".to_string(), "view".to_string());
    images.reserve(&key, "owner", "sidecar-a").unwrap();
    images.set(&key, 100);
    let configured = images
        .configure_raster(&key, 800, 600, 2.0, true)
        .unwrap()
        .unwrap();
    let detached = images.clone();
    let response = Arc::new(Mutex::new(None));
    let received = Arc::clone(&response);

    assert!(handle_envelope(
        &configured_envelope(&configured, 1),
        "sidecar-a",
        "tab-1",
        &images,
        move |work| {
            detached.remove_surface("tab-1");
            work()
        },
        move |_image, value| {
            *received.lock().unwrap() = Some(value);
            Ok(())
        },
    ));
    assert_eq!(
        response.lock().unwrap().as_ref().unwrap()["image"]["error"],
        "stale"
    );
}

// contract: images.ack.failure-carries-error-and-frame-identity
#[test]
fn failed_present_is_reported() {
    let response = after_present(Err("forbidden"), "view", 7, 3, 1);
    assert!(response["image"]["error"].is_string());
    assert_eq!(response["image"]["error"], "forbidden");
    assert_eq!(response["image"]["name"], "view");
    assert_eq!(response["image"]["generation"], 7);
    assert_eq!(response["image"]["raster"], 3);
    assert_eq!(response["image"]["sequence"], 1);
}

// contract: images.envelope.rejects-unsupported-format, images.envelope.rejects-bad-nonce-length, images.envelope.rejects-unknown-token-kind
#[test]
fn unsupported_image_is_refused() {
    let images = Images::default();

    // The case where the format is invalid.
    let body_wrong_format = json!({
        "image": {
            "name": "view",
            "token": {
                "kind": "iosurface-global",
                "id": 12345u32,
                "nonce": "AAAAAAAAAAAAAAAAAAAAAA=="
            },
            "width": 800,
            "height": 600,
            "scale": 2.0,
            "format": "rgba8",  // invalid format
            "generation": 1,
            "raster": 1,
            "sequence": 1
        }
    })
    .to_string();

    match decide(&body_wrong_format, "sidecar-a", "tab-1", &images) {
        Decision::Reply { name, json, .. } => {
            assert_eq!(name, "view");
            assert!(
                json["image"]["error"]
                    .as_str()
                    .unwrap()
                    .contains("unsupported")
            );
        }
        _ => panic!("expected Reply(unsupported) for wrong format"),
    }

    // The case where the nonce length is invalid.
    let body_wrong_nonce = json!({
        "image": {
            "name": "view",
            "token": {
                "kind": "iosurface-global",
                "id": 12345u32,
                "nonce": "short"  // not 16 bytes
            },
            "width": 800,
            "height": 600,
            "scale": 2.0,
            "format": "bgra8",
            "generation": 1,
            "raster": 1,
            "sequence": 1
        }
    })
    .to_string();

    match decide(&body_wrong_nonce, "sidecar-a", "tab-1", &images) {
        Decision::Reply { name, json, .. } => {
            assert_eq!(name, "view");
            assert!(
                json["image"]["error"]
                    .as_str()
                    .unwrap()
                    .contains("unsupported")
            );
        }
        _ => panic!("expected Reply(unsupported) for wrong nonce length"),
    }

    // The case where token.kind is invalid.
    let body_wrong_kind = json!({
        "image": {
            "name": "view",
            "token": {
                "kind": "other-kind",
                "id": 12345u32,
                "nonce": "AAAAAAAAAAAAAAAAAAAAAA=="
            },
            "width": 800,
            "height": 600,
            "scale": 2.0,
            "format": "bgra8",
            "generation": 1,
            "raster": 1,
            "sequence": 1
        }
    })
    .to_string();

    match decide(&body_wrong_kind, "sidecar-a", "tab-1", &images) {
        Decision::Reply { name, json, .. } => {
            assert_eq!(name, "view");
            assert!(
                json["image"]["error"]
                    .as_str()
                    .unwrap()
                    .contains("unsupported")
            );
        }
        _ => panic!("expected Reply(unsupported) for wrong token kind"),
    }
}

// contract: images.envelope.ignores-body-without-image, images.envelope.ignores-invalid-json
#[test]
fn non_image_body_is_not_handled() {
    let images = Images::default();

    // The case where there is no image field.
    let body_no_image = json!({
        "other": "data"
    })
    .to_string();

    match decide(&body_no_image, "sidecar-a", "tab-1", &images) {
        Decision::NotImage => {
            // Valid.
        }
        _ => panic!("expected NotImage for body without image field"),
    }

    // Invalid JSON.
    let body_invalid = "not json";
    match decide(body_invalid, "sidecar-a", "tab-1", &images) {
        Decision::NotImage => {
            // Valid.
        }
        _ => panic!("expected NotImage for invalid JSON"),
    }
}

// contract: images.envelope.refusal-preserves-quoted-name
#[test]
fn reply_escapes_names() {
    let images = Images::default();
    let nonce_b64 = "AAAAAAAAAAAAAAAAAAAAAA==";

    // Include a quotation mark in the name.
    let body = json!({
        "image": {
            "name": "a\"b",
            "token": {
                "kind": "iosurface-global",
                "id": 12345u32,
                "nonce": nonce_b64
            },
            "width": 800,
            "height": 600,
            "scale": 2.0,
            "format": "bgra8",
            "generation": 1,
            "raster": 1,
            "sequence": 1
        }
    })
    .to_string();

    // The image is not registered, so Reply must be returned.
    match decide(&body, "sidecar-a", "tab-1", &images) {
        Decision::Reply { name, json, .. } => {
            assert_eq!(name, "a\"b");
            // Convert the response to a string and check that the JSON is valid.
            let response_str = serde_json::to_string(&json).unwrap();
            assert!(serde_json::from_str::<serde_json::Value>(&response_str).is_ok());

            // Check that the name is escaped correctly.
            assert_eq!(json["image"]["name"], "a\"b");
        }
        _ => panic!("expected Reply"),
    }
}

// contract: images.attach.surface-close-removes-only-its-images
#[test]
fn surface_close_removes_only_its_images() {
    let images = Images::default();
    let surface_1_img_1: Key = ("tab-1".to_string(), "view".to_string());
    let surface_1_img_2: Key = ("tab-1".to_string(), "other".to_string());
    let surface_2_img: Key = ("tab-2".to_string(), "view".to_string());

    // Register 2 images in tab-1.
    images
        .reserve(&surface_1_img_1, "owner", "sidecar")
        .expect("reserve");
    images.set(&surface_1_img_1, 100);
    images
        .reserve(&surface_1_img_2, "owner", "sidecar")
        .expect("reserve");
    images.set(&surface_1_img_2, 200);

    // Register 1 image in tab-2.
    images
        .reserve(&surface_2_img, "owner", "sidecar")
        .expect("reserve");
    images.set(&surface_2_img, 300);

    // Remove all images of the surface tab-1.
    let removed = images.remove_surface("tab-1");
    assert_eq!(removed.len(), 2);
    assert!(removed.contains(&100));
    assert!(removed.contains(&200));

    // The images of tab-1 can no longer be accessed.
    assert!(images.get(&surface_1_img_1).is_err());
    assert!(images.get(&surface_1_img_2).is_err());

    // The image of tab-2 can still be accessed.
    assert_eq!(images.get(&surface_2_img).unwrap(), 300);
}

// contract: images.present.main-thread-failure-reports-present-failed
#[test]
fn presentation_failure_is_reported() {
    let images = Images::default();
    let key: Key = ("tab-1".to_string(), "view".to_string());

    // Register the image.
    images.reserve(&key, "owner", "sidecar-a").expect("reserve");
    images.set(&key, 100);
    let configured = images
        .configure_raster(&key, 800, 600, 2.0, true)
        .unwrap()
        .unwrap();

    let nonce = "AAAAAAAAAAAAAAAAAAAAAA==";
    let body = json!({
        "image": {
            "name": "view",
            "token": {
                "kind": "iosurface-global",
                "id": 12345u32,
                "nonce": nonce
            },
            "width": 800,
            "height": 600,
            "scale": 2.0,
            "format": "bgra8",
            "generation": configured.generation,
            "raster": configured.raster,
            "sequence": 1
        }
    })
    .to_string();

    let received_response = Arc::new(Mutex::new(None));
    let response_clone = Arc::clone(&received_response);

    // Call handle_envelope, and onMain returns false (presentation failure).
    let handled = handle_envelope(
        &body,
        "sidecar-a",
        "tab-1",
        &images,
        |_work| Err("simulated main thread failure".to_string()),
        |_image, json| {
            *response_clone.lock().unwrap() = Some(json);
            Ok(())
        },
    );

    assert!(handled, "envelope should have been handled");

    let response_opt = received_response.lock().unwrap();
    assert!(response_opt.is_some(), "response should have been sent");

    let response = response_opt.as_ref().unwrap();
    assert!(response["image"]["error"].is_string());
    assert_eq!(
        response["image"]["error"], "presentFailed",
        "expected error presentFailed"
    );
    assert_eq!(response["image"]["name"], "view");
    assert_eq!(response["image"]["sequence"], 1);
    assert_eq!(
        images.wait_current(Duration::ZERO),
        Err("presentFailed".to_string()),
        "native presentation failure must unblock the current-raster wait"
    );
}

// contract: images.present.missing-native-surface-requests-reconfiguration
#[test]
fn missing_native_surface_requests_a_fresh_raster_configuration() {
    let images = Images::default();
    let key: Key = ("tab-1".to_string(), "view".to_string());
    images.reserve(&key, "owner", "sidecar-a").expect("reserve");
    images.set(&key, 100);
    let configured = images
        .configure_raster(&key, 800, 600, 2.0, true)
        .unwrap()
        .unwrap();
    let body = json!({
        "image": {
            "name": "view",
            "token": {
                "kind": "iosurface-global",
                "id": 12345u32,
                "nonce": "AAAAAAAAAAAAAAAAAAAAAA=="
            },
            "width": 800,
            "height": 600,
            "scale": 2.0,
            "format": "bgra8",
            "generation": configured.generation,
            "raster": configured.raster,
            "sequence": 1
        }
    })
    .to_string();
    let recovered = Arc::new(Mutex::new(None));
    let recovered_value = Arc::clone(&recovered);

    assert!(handle_envelope_with_recovery(
        &body,
        "sidecar-a",
        "tab-1",
        &images,
        |_work| Err("notFound".to_string()),
        |_image, _response| Ok(()),
        |reason| {
            assert_eq!(reason, "notFound");
            let next = images.configure_raster(&key, 800, 600, 2.0, true).unwrap();
            *recovered_value.lock().unwrap() = next;
            Ok(())
        },
        || true,
    ));
    let next = recovered
        .lock()
        .unwrap()
        .take()
        .expect("recovery was not requested");
    assert_eq!(next.raster, configured.raster);
    assert!(!images.current_presented());
}

// contract: images.invalidate.sidecar-connection-loss-resends-configure
#[test]
fn invalidating_a_sidecar_resends_its_configure_and_leaves_other_sidecars() {
    let images = Images::default();
    let terminal: Key = ("tab-1".to_string(), "view".to_string());
    let browser: Key = ("tab-2".to_string(), "view".to_string());
    images
        .reserve(&terminal, "owner-a", "sidecar-a")
        .expect("reserve terminal");
    images.set(&terminal, 100);
    images
        .reserve(&browser, "owner-b", "sidecar-b")
        .expect("reserve browser");
    images.set(&browser, 200);
    images
        .configure_raster(&terminal, 800, 600, 2.0, true)
        .unwrap()
        .unwrap();
    images
        .configure_raster(&browser, 800, 600, 2.0, true)
        .unwrap()
        .unwrap();
    // A reconfiguration of the same size is not sent, because the state is already configured.
    assert!(
        images
            .configure_raster(&terminal, 800, 600, 2.0, true)
            .unwrap()
            .is_none()
    );

    // Only the configure state of the sidecar whose connection was lost is invalidated (V5-106).
    let invalidated = images.invalidate_sidecar("sidecar-a");
    assert_eq!(invalidated, 1, "exactly sidecar-a's images are invalidated");
    assert_eq!(
        images.invalidate_sidecar("sidecar-c"),
        0,
        "an unknown sidecar invalidates nothing"
    );

    // The configuration of the same size for the invalidated sidecar is sent again, because the service of the new
    // connection has no image state.
    let resent = images
        .configure_raster(&terminal, 800, 600, 2.0, true)
        .unwrap()
        .expect("the invalidated sidecar's configure is resent at the same size");
    assert_eq!(resent.name, "view");
    assert_eq!(resent.sidecar, "sidecar-a");

    // The region of the other sidecar was not invalidated, so a reconfiguration of the same size is still not sent.
    assert!(
        images
            .configure_raster(&browser, 800, 600, 2.0, true)
            .unwrap()
            .is_none()
    );
}

// contract: images.visibility.shown-surface-reconfigures-its-raster
#[test]
fn shown_surface_reconfigures_its_raster() {
    let images = Images::default();
    let key: Key = ("returning".into(), "view".into());
    images.reserve(&key, "owner", "sidecar-a").unwrap();
    assert!(images.set(&key, 100));
    let first = images
        .configure_raster(&key, 800, 600, 2.0, true)
        .unwrap()
        .unwrap();
    // A frame received while hidden is not displayed because the native layer was released. When it is shown again, a
    // new raster must be set even for the same size, and it does not wait for a raster from the hidden period.
    images.set_surface_visible(&key.0, false);
    images.set_surface_visible(&key.0, true);
    let shown = images
        .configure_raster(&key, 800, 600, 2.0, true)
        .unwrap()
        .expect("the shown surface did not configure a raster");
    assert!(
        shown.raster > first.raster,
        "the shown surface reused raster {} after {}",
        shown.raster,
        first.raster
    );
}

// contract: images.present.replaced-frame-is-logged-as-invalidated
#[test]
fn presentation_outcome_logs_a_replaced_frame_as_invalidated() {
    for detail in [
        "stale",
        "notAttached",
        "staleRaster native=1520x573@2 frame=760x192@2",
        "staleRaster native=none",
    ] {
        let (reason, invalidated, entry) = soksak_host_tauriv2::images::presentation_outcome(
            "s1", "view", 3, 2, 1, 9, detail, "unused",
        );
        assert_eq!(reason, "stale", "{detail}");
        assert!(invalidated, "{detail}");
        assert_eq!(
            entry.line(),
            format!(
                "info host image present: frame invalidated before native presentation: surface=s1 name=view generation=3 raster=2 sequence=1 token=9 reason={detail}"
            )
        );
    }
}

// contract: images.present.failure-line-names-the-current-frame
#[test]
fn presentation_outcome_names_the_current_frame_of_a_failure() {
    for (detail, want) in [
        ("notFound", "notFound"),
        ("presentFailed", "presentFailed"),
        ("boom", "presentFailed"),
    ] {
        let (reason, invalidated, entry) = soksak_host_tauriv2::images::presentation_outcome(
            "s1",
            "view",
            3,
            2,
            1,
            9,
            detail,
            "generation=3 raster=2",
        );
        assert_eq!(reason, want, "{detail}");
        assert!(!invalidated, "{detail}");
        assert_eq!(
            entry.line(),
            format!(
                "error host image present: surface=s1 name=view generation=3 raster=2 sequence=1 token=9 reason={detail} current generation=3 raster=2"
            )
        );
    }
}

// When an image region is detached and attached again in the same surface document, the generation stays the same, so
// the raster of the region that was attached again must be larger than the raster that the sidecar already received.
// The sidecar treats a configuration whose (generation, raster) did not grow as an old configuration and ignores it.
// contract: images.transfer.reattach-continues-raster
#[test]
fn reattaching_in_the_same_generation_continues_the_raster() {
    let images = Images::default();
    let key: Key = ("tab-1".into(), "view".into());
    images.begin_generation(&key.0);
    let attach = |images: &Images| {
        images.reserve(&key, "owner", "sidecar-a").unwrap();
        assert!(images.set(&key, 100));
    };
    let configure = |images: &Images, width: u32| {
        images
            .configure_raster(&key, width, 600, 2.0, true)
            .unwrap()
            .expect("a visible attached image is configured")
    };
    attach(&images);
    configure(&images, 800);
    let before = configure(&images, 900);
    images.remove(&key).unwrap();
    attach(&images);
    let after = configure(&images, 700);
    assert!(
        after.generation == before.generation && after.raster > before.raster,
        "configuration after reattaching is ({}, {}), want generation {} and a raster above {}",
        after.generation,
        after.raster,
        before.generation,
        before.raster
    );
    // It is the same after all regions of the surface were detached.
    images.remove_surface(&key.0);
    attach(&images);
    let again = configure(&images, 800);
    assert!(
        again.generation == after.generation && again.raster > after.raster,
        "configuration after removing the surface regions is ({}, {}), want generation {} and a raster above {}",
        again.generation,
        again.raster,
        after.generation,
        after.raster
    );
}

// The failure of an image region call states the call name (G1.4-112).
// contract: images.calls.name-the-call
#[test]
fn an_image_call_failure_names_the_call() {
    assert_eq!(
        soksak_host_tauriv2::images::image_call_error(
            "imageDetach",
            "image \"view\" is not attached".to_string()
        ),
        "imageDetach: image \"view\" is not attached"
    );
}

/// The environment variable that tells the child process the configuration directory.
const IMAGE_FRAME_CHILD: &str = "SOKSAK_IMAGE_FRAME_CHILD";

// A frame that the host refuses, and an envelope that is not valid, leave a record with the frame and the current state
// of the region.
// contract: images.envelope.refusal-is-recorded
#[test]
fn image_frame_refusals_are_recorded() {
    if let Some(config) = std::env::var_os(IMAGE_FRAME_CHILD) {
        start_standard_error(std::path::Path::new(&config), "com.soksak.test").unwrap();
        let writer = records::start_writer(std::path::Path::new(&config));
        let images = Images::default();
        let key: Key = ("tab-1".to_string(), "view".to_string());
        images.reserve(&key, "owner", "sidecar-a").unwrap();
        assert!(images.set(&key, 100));
        let configured = images
            .configure_raster(&key, 800, 600, 2.0, true)
            .unwrap()
            .unwrap();
        println!(
            "frame generation={} raster={}",
            configured.generation, configured.raster
        );
        let send = |_name: &str, _json: serde_json::Value| Ok(());
        let on_main = |work: Box<dyn Fn() -> Result<(), String> + Send>| work();
        // A sidecar that does not own the region.
        handle_envelope(
            &configured_envelope(&configured, 1),
            "sidecar-b",
            "tab-1",
            &images,
            on_main,
            send,
        );
        // A format that the host does not present.
        let mut unsupported: serde_json::Value =
            serde_json::from_str(&configured_envelope(&configured, 2)).unwrap();
        unsupported["image"]["format"] = json!("rgba8");
        handle_envelope(
            &unsupported.to_string(),
            "sidecar-a",
            "tab-1",
            &images,
            on_main,
            send,
        );
        // An image field that is not an envelope is not handled as an image, and the record shows it.
        assert!(!handle_envelope(
            r#"{"image":{"name":5}}"#,
            "sidecar-a",
            "tab-1",
            &images,
            on_main,
            send,
        ));
        writer.flush(Duration::from_secs(5)).unwrap();
        return;
    }
    let config = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "image_frame_refusals_are_recorded",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(IMAGE_FRAME_CHILD, config.path())
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "child ended with {:?}, output {:?}",
        output.status,
        String::from_utf8_lossy(&output.stdout)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    // The harness writes `test <name> ... ` before the test runs, so the line starts after it.
    let frame = stdout
        .lines()
        .find_map(|line| line.split_once("frame generation=").map(|(_, rest)| rest))
        .map(|rest| format!("generation={rest}"))
        .expect("the child printed the frame");
    let log = records::text_of(&records::read_events(&records::event_log_path(
        config.path(),
    )));
    for want in [
        format!(" info host image frame: surface=tab-1 name=view sender=sidecar-b {frame} sequence=1 refused: notAttached current generation="),
        format!(" error host image frame: surface=tab-1 name=view sender=sidecar-a {frame} sequence=2 refused: unsupported current generation="),
        " error host image frame: surface=tab-1 sender=sidecar-a malformed image envelope: {\"name\":5}".to_string(),
    ] {
        assert!(log.contains(&want), "no {want:?} in {log}");
    }
}

// contract: exposure.window.region-reports-presented-frame
#[test]
fn presented_frame_identity_is_reported() {
    let images = Images::default();
    let key: Key = ("tab-1".to_string(), "view".to_string());
    images.begin_generation(&key.0);
    images.reserve(&key, "owner", "sidecar-a").unwrap();
    assert!(images.set(&key, 100));
    assert_eq!(images.presented_frame(&key), None);

    let raster = images
        .configure_raster(&key, 800, 600, 2.0, true)
        .unwrap()
        .unwrap();
    let response = Arc::new(Mutex::new(None));
    let received = Arc::clone(&response);
    assert!(handle_envelope(
        &configured_envelope(&raster, 2),
        "sidecar-a",
        &key.0,
        &images,
        |_work| Ok(()),
        move |_image, value| {
            *received.lock().unwrap() = Some(value);
            Ok(())
        },
    ));
    assert!(images.wait_current(Duration::ZERO).is_ok());
    let frame = images.presented_frame(&key).expect("a presented frame");
    assert_eq!(frame.generation, raster.generation);
    assert_eq!(frame.raster, raster.raster);
    assert_eq!(frame.sequence, 2);

    // While the main thread presents a newer frame that the host accepted, the presented frame is the earlier one; the
    // newer one is presented when the presentation returns.
    let pending = Arc::new(Mutex::new(None));
    let seen = Arc::clone(&pending);
    let during = images.clone();
    let during_key = key.clone();
    assert!(handle_envelope(
        &configured_envelope(&raster, 3),
        "sidecar-a",
        &key.0,
        &images,
        move |_work| {
            *seen.lock().unwrap() = Some(
                during
                    .presented_frame(&during_key)
                    .map(|frame| frame.sequence),
            );
            Ok(())
        },
        |_image, _value| Ok(()),
    ));
    assert_eq!(
        *pending.lock().unwrap(),
        Some(Some(2)),
        "the presented frame with a newer frame pending"
    );
    assert_eq!(
        images.presented_frame(&key).map(|frame| frame.sequence),
        Some(3)
    );

    images
        .configure_raster(&key, 900, 600, 2.0, true)
        .unwrap()
        .unwrap();
    assert_eq!(images.presented_frame(&key), None);
}

// contract: trace.image-frame-answer-is-recorded
#[test]
fn frame_answer_event_records_consumed_and_refused_answers() {
    let answers = [
        ("consumed", after_present(Ok(()), "view", 1, 1, 7)),
        (
            "refused",
            after_present(Err("notAttached"), "view", 1, 1, 8),
        ),
    ];
    for (label, response) in answers {
        let event = soksak_host_tauriv2::sidecars::frame_answer_event("tab-1", "view", &response);
        assert_eq!(event["event"], "image.frame", "{label} answer: event");
        assert_eq!(event["surface"], "tab-1", "{label} answer: surface");
        assert_eq!(event["name"], "view", "{label} answer: name");
        assert_eq!(event["response"], response, "{label} answer: response");
        assert_eq!(
            event.as_object().map(|fields| fields.len()),
            Some(4),
            "{label} answer: event fields are event, surface, name and response"
        );
    }
}

// A frame of a sidecar that no plugin declares, such as the frame in flight when a plugin is removed while its card is
// open, belongs to a process that ended: its failure invalidates the frame without recovery, and an answer that cannot
// reach the ended sidecar is recorded.
// contract: images.present.frame-of-undeclared-sidecar-is-invalidated
#[test]
fn a_frame_of_a_sidecar_that_no_plugin_declares_is_invalidated() {
    let images = Images::default();
    let key: Key = ("tab-1".to_string(), "view".to_string());
    images.reserve(&key, "owner", "sidecar-a").expect("reserve");
    images.set(&key, 100);
    let configured = images
        .configure_raster(&key, 800, 600, 2.0, true)
        .unwrap()
        .unwrap();
    let answers = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&answers);
    assert!(handle_envelope_with_recovery(
        &configured_envelope(&configured, 1),
        "sidecar-a",
        "tab-1",
        &images,
        |_work| -> Result<(), String> {
            panic!("a frame of a sidecar that no plugin declares reached the native presentation")
        },
        |_image, response| {
            seen.lock().unwrap().push(response);
            Err(soksak_host_tauriv2::sidecars::ResponseError::Ended(
                "sidecar sidecar-a is not running".into(),
            ))
        },
        |reason| panic!("recovery of {reason} was requested for a sidecar that no plugin declares"),
        || false,
    ));
    let answers = answers.lock().unwrap();
    assert_eq!(answers.len(), 1);
    assert_eq!(answers[0]["image"]["error"], "stale");
}
