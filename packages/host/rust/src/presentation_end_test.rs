//! The deferred end of a presentation wait on the main thread (end_ticket_waits): it ends the join in the records of an open window,
//! and a window that closed before the end ran has no join to end.

use std::sync::Arc;

use super::end_ticket_waits;
use crate::windows::WindowData;

// contract: tauriv2.presentation-end.closed-window-ends-nothing
#[test]
fn a_deferred_end_after_its_window_closed_ends_nothing_and_reports_no_failure() {
    let closed: Result<Arc<WindowData>, String> = Err("project window is closed".to_string());
    assert_eq!(
        end_ticket_waits(&closed, "tab-a", 1, 7, "timeout"),
        Ok(0),
        "the close of a window abandons its presentation waits, so a deferred end that runs after it has nothing to end"
    );
}

// contract: tauriv2.presentation-end.open-window-ends-join
#[test]
fn a_deferred_end_in_an_open_window_ends_its_join() {
    let data = Arc::new(WindowData::default());
    assert!(data.documents.presentation().begin("tab-a", 1, 7));
    assert_eq!(
        end_ticket_waits(&Ok(Arc::clone(&data)), "tab-a", 1, 7, "hidden"),
        Ok(1),
        "the join of an open window ends without presentation"
    );
    assert!(!data.documents.presentation().waits("tab-a", 1, 7));
}
