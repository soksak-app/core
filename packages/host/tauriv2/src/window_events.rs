//! The events of a window (docs/spec/logging.md#automatic-entrances): every event that a host registers for a window is the
//! event `host.window.event` with the window and the kind.

use crate::event_log::Level;

/// The kinds of a window event and the level of each. The movement and the size change of a window arrive in streams, so they
/// are at the level `debug`.
const KINDS: [(&str, Level); 13] = [
    ("resize", Level::Debug),
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
