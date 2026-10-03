//! 그림 봉투의 의사결정 로직과 표현 확인을 검사한다.

use serde_json::json;
use soksak_host_tauriv2::images::{
    after_present, decide, handle_envelope, handle_envelope_with_recovery, Configure, Decision,
    Images, Key,
};
use std::sync::{Arc, Mutex};
use std::time::Duration;

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

    // 빈 sidecar로 reserve 시도
    let result = images.reserve(&key, "owner", "");
    assert!(result.is_err(), "expected error for empty sidecar");
    assert!(
        result.unwrap_err().contains("requires a sidecar"),
        "expected 'requires a sidecar' error"
    );

    // 이미지가 등록되지 않았는지 확인
    assert!(
        images.get(&key).is_err(),
        "image should not be registered after failed reserve"
    );
}

// contract: images.envelope.rejects-unattached-image, images.envelope.refusal-echoes-name-and-sequence
#[test]
fn unattached_image_is_refused() {
    let images = Images::default();
    let nonce_b64 = "AAAAAAAAAAAAAAAAAAAAAA=="; // 0 byte 16개
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

    // 이미지가 등록되지 않았으므로 notAttached 오류를 반환해야 함
    match decide(&body, "sidecar-a", "tab-1", &images) {
        Decision::Reply { name, json } => {
            assert_eq!(name, "view");
            assert!(json["image"]["error"]
                .as_str()
                .unwrap()
                .contains("notAttached"));
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
    // 구성된 현재 래스터이므로 거부 이유는 보낸 사이드카뿐이다.
    let configured = images
        .configure_raster(&key, 800, 600, 2.0, true)
        .unwrap()
        .unwrap();
    let body = configured_envelope(&configured, 1);
    match decide(&body, "sidecar-b", "tab-1", &images) {
        Decision::Reply { name, json } => {
            assert_eq!(name, "view");
            assert_eq!(json["image"]["error"], "notAttached");
        }
        _ => panic!("expected Reply(notAttached) for different sidecar"),
    }
    // 대조: 연결한 사이드카가 보낸 같은 봉투는 표시된다.
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

    // 사이드카가 이미지를 등록
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

    // 같은 사이드카가 같은 이미지를 보내면 Present를 반환해야 함
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

    // 포맷이 잘못된 경우
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
            "format": "rgba8",  // 잘못된 포맷
            "generation": 1,
            "raster": 1,
            "sequence": 1
        }
    })
    .to_string();

    match decide(&body_wrong_format, "sidecar-a", "tab-1", &images) {
        Decision::Reply { name, json } => {
            assert_eq!(name, "view");
            assert!(json["image"]["error"]
                .as_str()
                .unwrap()
                .contains("unsupported"));
        }
        _ => panic!("expected Reply(unsupported) for wrong format"),
    }

    // nonce 길이가 잘못된 경우
    let body_wrong_nonce = json!({
        "image": {
            "name": "view",
            "token": {
                "kind": "iosurface-global",
                "id": 12345u32,
                "nonce": "short"  // 16바이트가 아님
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
        Decision::Reply { name, json } => {
            assert_eq!(name, "view");
            assert!(json["image"]["error"]
                .as_str()
                .unwrap()
                .contains("unsupported"));
        }
        _ => panic!("expected Reply(unsupported) for wrong nonce length"),
    }

    // token.kind이 잘못된 경우
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
        Decision::Reply { name, json } => {
            assert_eq!(name, "view");
            assert!(json["image"]["error"]
                .as_str()
                .unwrap()
                .contains("unsupported"));
        }
        _ => panic!("expected Reply(unsupported) for wrong token kind"),
    }
}

// contract: images.envelope.ignores-body-without-image, images.envelope.ignores-invalid-json
#[test]
fn non_image_body_is_not_handled() {
    let images = Images::default();

    // 이미지 필드가 없는 경우
    let body_no_image = json!({
        "other": "data"
    })
    .to_string();

    match decide(&body_no_image, "sidecar-a", "tab-1", &images) {
        Decision::NotImage => {
            // 정상
        }
        _ => panic!("expected NotImage for body without image field"),
    }

    // 잘못된 JSON
    let body_invalid = "not json";
    match decide(body_invalid, "sidecar-a", "tab-1", &images) {
        Decision::NotImage => {
            // 정상
        }
        _ => panic!("expected NotImage for invalid JSON"),
    }
}

// contract: images.envelope.refusal-preserves-quoted-name
#[test]
fn reply_escapes_names() {
    let images = Images::default();
    let nonce_b64 = "AAAAAAAAAAAAAAAAAAAAAA==";

    // 이름에 따옴표를 포함
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

    // 등록되지 않은 이미지이므로 Reply가 반환되어야 함
    match decide(&body, "sidecar-a", "tab-1", &images) {
        Decision::Reply { name, json } => {
            assert_eq!(name, "a\"b");
            // 응답을 문자열로 변환하여 JSON 유효성 확인
            let response_str = serde_json::to_string(&json).unwrap();
            assert!(serde_json::from_str::<serde_json::Value>(&response_str).is_ok());

            // 이름이 올바르게 이스케이프되었는지 확인
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

    // tab-1에 2개 이미지 등록
    images
        .reserve(&surface_1_img_1, "owner", "sidecar")
        .expect("reserve");
    images.set(&surface_1_img_1, 100);
    images
        .reserve(&surface_1_img_2, "owner", "sidecar")
        .expect("reserve");
    images.set(&surface_1_img_2, 200);

    // tab-2에 1개 이미지 등록
    images
        .reserve(&surface_2_img, "owner", "sidecar")
        .expect("reserve");
    images.set(&surface_2_img, 300);

    // tab-1 표면의 모든 이미지 제거
    let removed = images.remove_surface("tab-1");
    assert_eq!(removed.len(), 2);
    assert!(removed.contains(&100));
    assert!(removed.contains(&200));

    // tab-1의 이미지는 더 이상 접근 불가
    assert!(images.get(&surface_1_img_1).is_err());
    assert!(images.get(&surface_1_img_2).is_err());

    // tab-2의 이미지는 여전히 접근 가능
    assert_eq!(images.get(&surface_2_img).unwrap(), 300);
}

// contract: images.present.main-thread-failure-reports-present-failed
#[test]
fn presentation_failure_is_reported() {
    let images = Images::default();
    let key: Key = ("tab-1".to_string(), "view".to_string());

    // 이미지 등록
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

    // handle_envelope 호출, onMain이 false 반환 (표시 실패)
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
    // 같은 크기의 재구성은 전송하지 않는다 — 상태가 이미 구성되었기 때문이다.
    assert!(images
        .configure_raster(&terminal, 800, 600, 2.0, true)
        .unwrap()
        .is_none());

    // 연결이 끊긴 사이드카의 configure 상태만 무효화한다(V5-106).
    let invalidated = images.invalidate_sidecar("sidecar-a");
    assert_eq!(invalidated, 1, "exactly sidecar-a's images are invalidated");
    assert_eq!(
        images.invalidate_sidecar("sidecar-c"),
        0,
        "an unknown sidecar invalidates nothing"
    );

    // 무효화된 사이드카의 같은 크기 구성은 다시 전송된다 — 새 연결의 서비스는 그림 상태가 없다.
    let resent = images
        .configure_raster(&terminal, 800, 600, 2.0, true)
        .unwrap()
        .expect("the invalidated sidecar's configure is resent at the same size");
    assert_eq!(resent.name, "view");
    assert_eq!(resent.sidecar, "sidecar-a");

    // 다른 사이드카의 영역은 무효화되지 않았으므로 같은 크기 재구성은 여전히 전송하지 않는다.
    assert!(images
        .configure_raster(&browser, 800, 600, 2.0, true)
        .unwrap()
        .is_none());
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
    // 숨긴 동안 받은 frame 은 native layer 가 해제되어 표시되지 않는다. 다시 보이면 같은 크기라도 새 raster 를
    // 설정해야 하며, 숨긴 동안의 raster 를 기다리지 않는다.
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
        let (reason, invalidated, line) = soksak_host_tauriv2::images::presentation_outcome(
            "s1", "view", 3, 2, 1, 9, detail, "unused",
        );
        assert_eq!(reason, "stale", "{detail}");
        assert!(invalidated, "{detail}");
        assert_eq!(
            line,
            format!("image frame invalidated before native presentation: surface=s1 name=view generation=3 raster=2 sequence=1 token=9 reason={detail}")
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
        let (reason, invalidated, line) = soksak_host_tauriv2::images::presentation_outcome(
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
            line,
            format!("image present on main thread error: surface=s1 name=view generation=3 raster=2 sequence=1 token=9 reason={detail} current generation=3 raster=2")
        );
    }
}

// 같은 표면 문서에서 그림 영역을 떼었다가 다시 붙이면 세대가 그대로이므로, 다시 붙인 영역의 래스터는 사이드카가 이미
// 받은 래스터보다 커야 한다. 사이드카는 (세대, 래스터)가 커지지 않은 구성을 지난 구성으로 보고 무시한다.
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
    // 표면의 모든 영역을 뗀 뒤에도 같다.
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

// 그림 영역 호출의 실패는 호출 이름을 밝힌다(G1.4-112).
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
