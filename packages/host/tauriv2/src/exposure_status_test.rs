use super::*;

/// A watch that starts after the watch of the window ended receives the value of the window that changed while no
/// connection watched it. The value sent before the watch ended is not sent again to the new watch.
// contract: status.window.rewatch-notifies
#[test]
fn a_new_watch_receives_the_next_window_value_after_a_stale_record() {
    let mut reported = HashMap::new();
    let open = json!({"modal": "open"});
    let closed = json!({"modal": "closed"});
    assert_eq!(
        decide_window_notify(&mut reported, "main", true, &open),
        WindowNotify::Sent(open.clone()),
        "the first value of a watched window is sent"
    );
    // The last watch of the window ends.
    forget_window_notify(&mut reported, "main");
    assert_eq!(
        decide_window_notify(&mut reported, "main", false, &closed),
        WindowNotify::Unwatched,
        "a value of a window that no connection watches is not sent"
    );
    assert_eq!(
        decide_window_notify(&mut reported, "main", true, &open),
        WindowNotify::Sent(open.clone()),
        "a new watch receives the value of the window after the earlier watch ended"
    );
}
