//! 표면 준비가 담는 창 제목줄 높이의 검사를 확인한다(docs/spec/native-surfaces.md#title-bar-height). 두 host 는
//! 같은 값을 같은 문장으로, 배치 트랜잭션을 시작하기 전에 거부한다.

use std::collections::HashMap;

use soksak_host_tauriv2::surfaces::{check_sync_request, SyncRequest};
use soksak_host_tauriv2::windows::validate_titlebar_height;

/// 페이지가 보내는 형태의 표면 동기화 요청이다. JSON 은 NaN 과 무한대를 담을 수 없다.
fn titlebar_request(titlebar: f64) -> SyncRequest {
    serde_json::from_value(
        serde_json::json!({"settled": true, "surfaces": [], "titlebar": titlebar}),
    )
    .expect("the sync request fixture is a valid request")
}

// contract: surfaces.sync.titlebar.accepts-heights-in-range
#[test]
fn sync_request_accepts_titlebar_heights_in_range() {
    for height in [32.0, 40.0, 54.0, 54.5, 108.0, 200.0] {
        assert!(
            check_sync_request(&titlebar_request(height), &HashMap::new()).is_ok(),
            "a sync request with title bar {height} was refused"
        );
    }
}

// contract: surfaces.sync.titlebar.rejects-other-heights
#[test]
fn sync_request_rejects_other_titlebar_heights() {
    let want = "title bar height must be a finite number from 32 through 200 points";
    for height in [31.99, 0.0, -1.0, -40.0, 200.01, 1e300] {
        assert_eq!(
            check_sync_request(&titlebar_request(height), &HashMap::new()).err(),
            Some(want.to_string()),
            "title bar {height}"
        );
    }
    for height in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert_eq!(
            validate_titlebar_height(height),
            Err(want.to_string()),
            "{height}"
        );
    }
}
