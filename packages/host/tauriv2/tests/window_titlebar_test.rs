//! 페이지가 요청하는 창 제목줄 높이의 검사를 확인한다(docs/spec/hosts.md#window-buttons). 두 host 는 같은 값을
//! 같은 문장으로 거부한다.

use soksak_host_tauriv2::windows::validate_titlebar_height;

// contract: window.titlebar.accepts-heights-in-range
#[test]
fn window_titlebar_accepts_heights_in_range() {
    for height in [32.0, 40.0, 54.0, 54.5, 108.0, 200.0] {
        assert!(
            validate_titlebar_height(height).is_ok(),
            "{height} was rejected"
        );
    }
}

// contract: window.titlebar.rejects-other-heights
#[test]
fn window_titlebar_rejects_other_heights() {
    let want = "title bar height must be a finite number from 32 through 200 points";
    for height in [
        31.99,
        0.0,
        -1.0,
        -40.0,
        200.01,
        1e300,
        f64::NAN,
        f64::INFINITY,
        f64::NEG_INFINITY,
    ] {
        assert_eq!(
            validate_titlebar_height(height),
            Err(want.to_string()),
            "{height}"
        );
    }
}
