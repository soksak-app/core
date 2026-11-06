//! Checks that the start of a page ends what the earlier page left in the layout of its window.

use std::sync::Mutex;

use super::*;

// contract: exposure.relay.page-reload-ends-surface-requests
#[test]
fn a_page_start_ends_the_waits_the_layout_and_the_keyboard_hold_of_the_earlier_page() {
    let steps = Mutex::new(Vec::new());
    let result = end_page_layout(
        || {
            steps.lock().unwrap().push("abandon");
            Err("abandon failed".to_string())
        },
        || {
            steps.lock().unwrap().push("cancel");
            Ok(())
        },
        || {
            steps.lock().unwrap().push("decided");
            Err("no window".to_string())
        },
    );
    assert_eq!(*steps.lock().unwrap(), ["abandon", "cancel", "decided"]);
    assert_eq!(
        result,
        Err("abandon failed; ending the keyboard hold: no window".to_string())
    );
}
