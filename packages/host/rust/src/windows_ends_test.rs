//! Checks that a wait in a window reads only the ends of the window that come after it begins: a reload that begins after the
//! end of the page process of its window is not ended by that end, because the reload starts a new page and recovers the
//! window.

use super::WindowEnds;

// contract: reload.ends-by-ready-close-or-process-end
#[test]
fn an_end_before_a_wait_begins_does_not_end_that_wait() {
    let ends = WindowEnds::default();
    ends.record("the page process ended");
    let mark = ends.mark();
    assert_eq!(
        ends.since(mark),
        None,
        "the end of the page process before the wait ended the wait"
    );
    ends.record("the window closed");
    assert_eq!(ends.since(mark), Some("the window closed".to_string()));
}
