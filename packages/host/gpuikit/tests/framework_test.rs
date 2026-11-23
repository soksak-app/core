//! Tests of the identity of the GPUI framework adapter.

use soksak_host::framework::Framework as _;
use soksak_host::framework::WindowEvent;
use soksak_host_gpuikit::Framework;

// contract: application.framework.names-the-application
#[test]
fn the_adapter_names_the_gpuikit_host() {
    let framework = Framework;
    assert_eq!(framework.application_name(), "gpuikit");
    assert_eq!(framework.display_name(), "GPUI");
}

// contract: application.framework.window-events-are-port-events
#[test]
fn each_window_notification_of_appkit_is_an_event_of_the_frontend() {
    // The adapter observes these AppKit notifications of each window and reports each as the port event beside it.
    let table: Vec<(String, WindowEvent)> = soksak_host_gpuikit::window_notifications()
        .into_iter()
        .map(|(name, event)| (name.to_string(), event))
        .collect();
    let names: Vec<&str> = table.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(
        names,
        [
            "NSWindowDidResizeNotification",
            "NSWindowDidMoveNotification",
            "NSWindowDidBecomeKeyNotification",
            "NSWindowDidResignKeyNotification",
            "NSWindowWillCloseNotification",
        ]
    );
    assert!(matches!(table[0].1, WindowEvent::Resized));
    assert!(matches!(table[1].1, WindowEvent::Moved));
    assert!(matches!(table[2].1, WindowEvent::Focused(true)));
    assert!(matches!(table[3].1, WindowEvent::Focused(false)));
    assert!(matches!(table[4].1, WindowEvent::Destroyed));
}
