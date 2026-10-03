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
