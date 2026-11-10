//! Checks the answer of host.window.fullscreen for each native result of the change.

use super::fullscreen_answer;
use crate::endpoint::{MISSING_DOCUMENT, NOT_ACTIVE, TIMED_OUT};
use crate::platform::FullscreenResult;

// contract: exposure.fullscreen.answers-once-by-its-event
#[test]
fn the_full_screen_change_answers_with_its_native_result() {
    let cases = [
        (
            FullscreenResult::Refused,
            "the window is minimized",
            NOT_ACTIVE,
        ),
        (
            FullscreenResult::Refused,
            "macOS did not start the full screen transition",
            NOT_ACTIVE,
        ),
        (
            FullscreenResult::Closed,
            "the window closed during the full screen transition",
            MISSING_DOCUMENT,
        ),
        (
            FullscreenResult::Failed,
            "macOS failed the full screen transition",
            TIMED_OUT,
        ),
    ];
    for (result, message, code) in cases {
        let failure = fullscreen_answer(result, message.to_string())
            .expect_err("a change that did not end in the asked state succeeded");
        assert_eq!((failure.code, failure.message.as_str()), (code, message));
    }
    assert!(
        fullscreen_answer(FullscreenResult::Done, String::new()).is_ok(),
        "a finished transition failed"
    );
}
