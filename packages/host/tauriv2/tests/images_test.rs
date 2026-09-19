//! 그림 봉투의 의사결정 로직과 표현 확인을 검사한다.

use serde_json::json;
use soksak_host_tauriv2::images::{Images, Key, decide, Decision, after_present};

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
            "format": "bgra8",
            "sequence": 1
        }
    }).to_string();

    // 이미지가 등록되지 않았으므로 notAttached 오류를 반환해야 함
    match decide(&body, "sidecar-a", "tab-1", &images) {
        Decision::Reply(json) => {
            assert!(json["image"]["error"].as_str().unwrap().contains("notAttached"));
            assert_eq!(json["image"]["name"], "view");
            assert_eq!(json["image"]["sequence"], 1);
        }
        _ => panic!("expected Reply(notAttached)"),
    }
}

#[test]
fn image_from_another_sidecar_is_refused() {
    let images = Images::default();
    let key: Key = ("tab-1".to_string(), "view".to_string());

    // 첫 번째 사이드카가 이미지를 등록
    images.reserve(&key, "owner-a", "sidecar-a").ok();
    images.set(&key, 100);

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
            "format": "bgra8",
            "sequence": 1
        }
    }).to_string();

    // 다른 사이드카가 같은 이미지를 보내면 notAttached 오류를 반환해야 함
    match decide(&body, "sidecar-b", "tab-1", &images) {
        Decision::Reply(json) => {
            assert!(json["image"]["error"].as_str().unwrap().contains("notAttached"));
        }
        _ => panic!("expected Reply(notAttached) for different sidecar"),
    }
}

#[test]
fn attached_image_is_presented() {
    let images = Images::default();
    let key: Key = ("tab-1".to_string(), "view".to_string());

    // 사이드카가 이미지를 등록
    images.reserve(&key, "owner-a", "sidecar-a").ok();
    images.set(&key, 100);

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
            "format": "bgra8",
            "sequence": 1
        }
    }).to_string();

    // 같은 사이드카가 같은 이미지를 보내면 Present를 반환해야 함
    match decide(&body, "sidecar-a", "tab-1", &images) {
        Decision::Present {
            id,
            nonce,
            width,
            height,
            name,
            sequence,
        } => {
            assert_eq!(id, 12345u32);
            assert_eq!(nonce, [0; 16]);
            assert_eq!(width, 800);
            assert_eq!(height, 600);
            assert_eq!(name, "view");
            assert_eq!(sequence, 1);
        }
        _ => panic!("expected Present"),
    }
}

#[test]
fn successful_present_is_released() {
    let response = after_present(true, None, "view", 1);
    assert!(response["image"]["released"].is_object());
    assert_eq!(response["image"]["released"]["name"], "view");
    assert_eq!(response["image"]["released"]["sequence"], 1);
}

#[test]
fn failed_present_is_reported() {
    let response = after_present(false, Some("forbidden"), "view", 1);
    assert!(response["image"]["error"].is_string());
    assert_eq!(response["image"]["error"], "forbidden");
    assert_eq!(response["image"]["name"], "view");
    assert_eq!(response["image"]["sequence"], 1);
}

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
            "format": "rgba8",  // 잘못된 포맷
            "sequence": 1
        }
    }).to_string();

    match decide(&body_wrong_format, "sidecar-a", "tab-1", &images) {
        Decision::Reply(json) => {
            assert!(json["image"]["error"].as_str().unwrap().contains("unsupported"));
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
            "format": "bgra8",
            "sequence": 1
        }
    }).to_string();

    match decide(&body_wrong_nonce, "sidecar-a", "tab-1", &images) {
        Decision::Reply(json) => {
            assert!(json["image"]["error"].as_str().unwrap().contains("unsupported"));
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
            "format": "bgra8",
            "sequence": 1
        }
    }).to_string();

    match decide(&body_wrong_kind, "sidecar-a", "tab-1", &images) {
        Decision::Reply(json) => {
            assert!(json["image"]["error"].as_str().unwrap().contains("unsupported"));
        }
        _ => panic!("expected Reply(unsupported) for wrong token kind"),
    }
}

#[test]
fn non_image_body_is_not_handled() {
    let images = Images::default();

    // 이미지 필드가 없는 경우
    let body_no_image = json!({
        "other": "data"
    }).to_string();

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
            "format": "bgra8",
            "sequence": 1
        }
    }).to_string();

    // 등록되지 않은 이미지이므로 Reply가 반환되어야 함
    match decide(&body, "sidecar-a", "tab-1", &images) {
        Decision::Reply(json) => {
            // 응답을 문자열로 변환하여 JSON 유효성 확인
            let response_str = serde_json::to_string(&json).unwrap();
            assert!(serde_json::from_str::<serde_json::Value>(&response_str).is_ok());

            // 이름이 올바르게 이스케이프되었는지 확인
            assert_eq!(json["image"]["name"], "a\"b");
        }
        _ => panic!("expected Reply"),
    }
}

#[test]
fn surface_close_removes_only_its_images() {
    let images = Images::default();
    let surface_1_img_1: Key = ("tab-1".to_string(), "view".to_string());
    let surface_1_img_2: Key = ("tab-1".to_string(), "other".to_string());
    let surface_2_img: Key = ("tab-2".to_string(), "view".to_string());

    // tab-1에 2개 이미지 등록
    images.reserve(&surface_1_img_1, "owner", "sidecar").ok();
    images.set(&surface_1_img_1, 100);
    images.reserve(&surface_1_img_2, "owner", "sidecar").ok();
    images.set(&surface_1_img_2, 200);

    // tab-2에 1개 이미지 등록
    images.reserve(&surface_2_img, "owner", "sidecar").ok();
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
