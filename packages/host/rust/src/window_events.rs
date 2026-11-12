//! The events of a window (docs/spec/logging.md#entrances): every event that a host registers for a window is the
//! event `host.window.event` with the window and the kind, and a resize also with the content size of the window.

use crate::event_log::Level;
use crate::framework::LogicalSize;

/// The kinds of a window event that `record_window_event` stores and the level of each. The movement of a window arrives in a
/// stream, so it is at the level `debug`. The kind `resize` carries the content size, so `record_window_resize` stores it.
const KINDS: [(&str, Level); 12] = [
    ("move", Level::Debug),
    ("scale_factor_changed", Level::Debug),
    ("show", Level::Info),
    ("hide", Level::Info),
    ("occlusion_changed", Level::Info),
    ("focus", Level::Info),
    ("lost_focus", Level::Info),
    ("close_requested", Level::Info),
    ("closed", Level::Info),
    ("web_process_ended", Level::Info),
    ("navigation_committed", Level::Info),
    // window-active is the host's event that tells the page that the window became active; the host records it when it sends the event.
    ("window-active", Level::Info),
];

/// Stores the event `host.project.front` of a project that a window shows in front, after the window is shown
/// (docs/spec/logging.md#entrances). `key` tells whether the window is the key window. `app_active` tells whether
/// the application is active, and is None when that state could not be read.
pub fn record_project_front(window: &str, project: &str, key: bool, app_active: Option<bool>) {
    crate::event_record::emit_host(
        Level::Info,
        "host.project.front",
        serde_json::json!({"window": window, "project": project, "key": key, "app_active": app_active}),
    );
}

/// Stores a window event of the kind for the window. A kind outside `KINDS` is reported on the standard error and nothing is
/// stored.
pub fn record_window_event(window: &str, kind: &str) {
    let Some((_, level)) = KINDS.iter().find(|(name, _)| *name == kind) else {
        eprintln!("event writer: the window event kind {kind:?} is not declared");
        return;
    };
    crate::event_record::emit_host(
        *level,
        "host.window.event",
        serde_json::json!({"window": window, "kind": kind}),
    );
}

/// Stores the window event `resize` of the window with the width and the height of its content in points, read when the event
/// arrived and before it is stored. `size` is None when the content was gone, as that of a window that closed is, and the width and
/// the height are then null. The size change of a window arrives in a stream, so it is at the level `debug`.
pub fn record_window_resize(window: &str, size: Option<LogicalSize>) {
    crate::event_record::emit_host(
        Level::Debug,
        "host.window.event",
        serde_json::json!({
            "window": window,
            "kind": "resize",
            "width": size.map(|size| size.width),
            "height": size.map(|size| size.height),
        }),
    );
}
