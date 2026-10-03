//! 창 객체 수 응답 테스트. 수는 공용 라이브러리가 세며 여기서는 응답의 이름과 값만 검사한다. 진단 빌드에서만
//! 컴파일한다.
#![cfg(feature = "diagnostics")]

use serde_json::json;
use soksak_host_tauriv2::platform::WindowObjects;

// contract: diagnostics.native-objects.payload-names-counts
#[test]
fn the_window_objects_payload_names_the_counts() {
    let payload = WindowObjects {
        window_compositions: 1,
        surface_hosts: 2,
        input_registrations: 3,
    }
    .payload();
    assert_eq!(
        payload,
        json!({"windowCompositions": 1, "surfaceHosts": 2, "inputRegistrations": 3})
    );
}

// contract: diagnostics.native-objects.equal-validates
#[test]
fn the_window_objects_equal_validates() {
    let equal = WindowObjects::from_equal(
        &json!({"windowCompositions": 1, "surfaceHosts": 2, "inputRegistrations": 0}),
    );
    assert_eq!(
        equal,
        Ok(WindowObjects {
            window_compositions: 1,
            surface_hosts: 2,
            input_registrations: 0,
        })
    );
    for raw in [
        json!(null),
        json!([]),
        json!(1),
        json!({}),
        json!({"windowCompositions": 1, "surfaceHosts": 2}),
        json!({"windowCompositions": 1, "surfaceHosts": 2, "inputRegistrations": -1}),
        json!({"windowCompositions": 1.5, "surfaceHosts": 2, "inputRegistrations": 0}),
        json!({"windowCompositions": "1", "surfaceHosts": 2, "inputRegistrations": 0}),
        json!({"windowCompositions": 1, "surfaceHosts": 2, "inputRegistrations": 0, "other": 0}),
        json!({"windowCompositions": 1, "surfaceHosts": 2, "other": 0}),
    ] {
        assert_eq!(
            WindowObjects::from_equal(&raw),
            Err("equal must be an object of windowCompositions, surfaceHosts and inputRegistrations, each a non-negative integer".to_string()),
            "{raw}"
        );
    }
    let counts = WindowObjects {
        window_compositions: 2,
        surface_hosts: 2,
        input_registrations: 1,
    };
    assert_eq!(
        counts.to_string(),
        "windowCompositions 2, surfaceHosts 2, inputRegistrations 1"
    );
}

// contract: diagnostics.process-exit.pid-validates
#[test]
fn the_process_exit_pid_validates() {
    assert_eq!(
        soksak_host_tauriv2::platform::parse_process_id(Some(&json!(2147483647))),
        Ok(2147483647)
    );
    for raw in [
        None,
        Some(json!(null)),
        Some(json!(0)),
        Some(json!(-1)),
        Some(json!(1.5)),
        Some(json!("12")),
        Some(json!(2147483648_i64)),
        Some(json!({})),
    ] {
        assert_eq!(
            soksak_host_tauriv2::platform::parse_process_id(raw.as_ref()),
            Err("pid must be a positive integer".to_string()),
            "{raw:?}"
        );
    }
}
