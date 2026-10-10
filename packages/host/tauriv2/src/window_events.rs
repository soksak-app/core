//! The events of a window (docs/spec/logging.md#automatic-entrances): every event that a host registers for a window is the
//! event `host.window.event` with the window and the kind.

use crate::event_log::Level;

/// The kinds of a window event and the level of each. The movement and the size change of a window arrive in streams, so they
/// are at the level `debug`.
const KINDS: [(&str, Level); 12] = [
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
];

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
